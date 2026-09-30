import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { IngestionStore } from "../../src/core/storage/index.ts";
import { IngestionCoordinator } from "../../src/core/ingestion/index.ts";
import { createIngestionStatusBridge } from "../../src/dashboard/server/ingestion-status.ts";
import { session, piRequest, user } from "./fixtures.ts";

const capabilities = { requestDetails: true, toolResults: true, traceEvents: false, ttft: false, recordedCosts: true, pricingEstimates: false };
const source = { sourceId: session.identity.sourceId, clientType: "fixture", label: "Fixture", capabilities };
const snapshot = (records = [piRequest], checkpoint = "one", mode = "full") => ({ session, records, checkpoint, mode, deleted: [] });
const descriptor = { id: "fixture", name: "Fixture", version: "1", contractVersion: 1 };
const registration = (connection, assigned = source) => ({ source: assigned, config: {}, adapter: { descriptor, connect: async () => connection } });
const connection = (overrides = {}) => ({ capabilities,
	listSessions: async () => ({ sessions: [session], nextCursor: null }),
	readSession: async () => snapshot(), close: async () => {}, ...overrides });
const options = { pollIntervalMs: 100_000, reconcileIntervalMs: 100_000, retryDelayMs: 5, maxAttempts: 2 };
async function until(predicate, message = "condition") {
	for (let i = 0; i < 500; i++) { if (predicate()) return; await delay(5); }
	assert.fail(`Timed out waiting for ${message}`);
}
function setup(t, registrations, opts = options, store = new IngestionStore(":memory:")) {
	const coordinator = new IngestionCoordinator(store, registrations, opts);
	t.after(async () => { await coordinator.stop(); store.close(); });
	return { store, coordinator };
}
const idle = coordinator => coordinator.status().sources.every(s => s.phase === "idle");

test("durable upserts, full/partial omission, explicit tombstones and source isolation", async t => {
	const dir = await mkdtemp(join(tmpdir(), "agent-ingestion-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "ingestion.sqlite");
	let store = new IngestionStore(path);
	store.putSource(source);
	store.commitSnapshot(session.identity, snapshot([piRequest, user]));
	store.commitSnapshot(session.identity, snapshot([piRequest, user]));
	assert.equal(store.getRecords(session.identity).length, 2);
	store.commitSnapshot(session.identity, snapshot([], "two", "partial"));
	store.commitSnapshot(session.identity, snapshot([], "three", "full"));
	assert.equal(store.getRecords(session.identity).length, 2);
	const foreign = { ...session.identity, sourceId: "other" };
	store.putSource({ ...source, sourceId: "other" });
	store.commitSnapshot(foreign, { ...snapshot([{ ...piRequest, identity: { ...foreign, recordId: "a1" }, prompt: null }]), session: { ...session, identity: foreign } });
	store.commitSnapshot(session.identity, { ...snapshot([], "deleted", "partial"), deleted: [{ identity: user.identity, provenance: user.provenance }] });
	store.markUnavailable(session.identity, session.provenance, "watch-one");
	store.close();
	store = new IngestionStore(path);
	t.after(() => store.close());
	assert.equal(store.getSession(session.identity).checkpoint, "deleted");
	assert.deepEqual(store.getSession(session.identity).unavailable, session.provenance);
	assert.equal(store.getSourceCheckpoint(source.sourceId).watch, "watch-one");
	assert.equal(store.getRecords(session.identity).length, 1);
	assert.equal(store.getRecords(foreign).length, 1);
	assert.equal(store.getRecords(session.identity)[0].cost.recorded.total.amount, 0.75);
});

test("transaction failure rolls back records, session metadata and checkpoint", () => {
	const store = new IngestionStore(":memory:");
	try {
		store.putSource(source);
		store.commitSnapshot(session.identity, snapshot());
		const invalid = { ...user, identity: piRequest.identity };
		assert.throws(() => store.commitSnapshot(session.identity, { ...snapshot([user, invalid], "bad"), session: { ...session, title: "bad" } }), /kind changed/);
		assert.deepEqual(store.getRecords(session.identity), [piRequest]);
		assert.equal(store.getSession(session.identity).checkpoint, "one");
		assert.equal(store.getSession(session.identity).session.title, null);
		assert.throws(() => store.commitSnapshot(session.identity, snapshot([piRequest, piRequest])), /Duplicate/);
		assert.throws(() => store.commitSnapshot(session.identity, { ...snapshot(), deleted: [{ identity: piRequest.identity, provenance: piRequest.provenance }] }), /Duplicate/);
		assert.throws(() => store.commitSnapshot(session.identity, snapshot([{ ...piRequest, identity: { ...piRequest.identity, sourceId: "other" } }])), /foreign/);
		assert.throws(() => store.commitSnapshot(session.identity, snapshot([{ ...piRequest, origin: { ...piRequest.identity, sourceId: "other" } }])), /foreign/);
		store.commitSnapshot(session.identity, { ...snapshot([], "tombstone"), deleted: [{ identity: piRequest.identity, provenance: piRequest.provenance }] });
		assert.throws(() => store.commitSnapshot(session.identity, snapshot([invalid])), /kind changed/);
		assert.equal(store.getSession(session.identity).checkpoint, "tombstone");
	} finally { store.close(); }
});

test("paginated discovery retries transient reads and repeated refresh never duplicates usage", async t => {
	let calls = 0;
	const cursors = [];
	const second = { ...session, identity: { ...session.identity, sessionId: "second" } };
	const { store, coordinator } = setup(t, [registration(connection({
		listSessions: async ({ cursor }) => { cursors.push(cursor); return { sessions: cursor === null ? [session] : [second], nextCursor: cursor === null ? "page2" : null }; },
		readSession: async ({ session: ref }) => {
			if (++calls === 1) throw new Error("Temporary read failure");
			return ref.sessionId === "second" ? { ...snapshot([]), session: second } : snapshot();
		},
	}))]);
	coordinator.start();
	await until(() => idle(coordinator));
	assert.deepEqual(cursors, [null, "page2"]);
	await coordinator.refresh();
	assert.equal(store.getRecords(session.identity).length, 1);
	assert.equal(store.getRecords(session.identity)[0].cost.recorded.total.amount, 0.75);
	assert.ok(store.getSession(second.identity));
	assert.equal(store.getSourceCheckpoint(source.sourceId).discovery, null);
});

test("interrupted pagination resumes from the last fully committed page after reopening", async t => {
	const dir = await mkdtemp(join(tmpdir(), "agent-resume-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "store.sqlite");
	const store = new IngestionStore(path);
	let waiting = false;
	const first = new IngestionCoordinator(store, [registration(connection({
		listSessions: async ({ cursor, signal }) => {
			if (cursor === "next") { waiting = true; await delay(100_000, undefined, { signal }); }
			return { sessions: [session], nextCursor: "next" };
		},
	}))], options);
	first.start();
	await until(() => waiting);
	await first.stop();
	assert.equal(store.getSourceCheckpoint(source.sourceId).discovery.cursor, "next");
	store.close();
	const reopened = new IngestionStore(path);
	const cursors = [];
	const { coordinator } = setup(t, [registration(connection({ listSessions: async ({ cursor }) => {
		cursors.push(cursor); return { sessions: [session], nextCursor: null };
	} }))], options, reopened);
	coordinator.start();
	await until(() => idle(coordinator));
	assert.deepEqual(cursors, ["next"]);
	assert.equal(reopened.getRecords(session.identity).length, 1);
});

test("incremental polling uses checkpoints, periodic reconciliation performs full reads", async t => {
	const checkpoints = [], hints = [];
	const { store, coordinator } = setup(t, [registration(connection({
		listSessions: async ({ updatedSince }) => { hints.push(updatedSince); return { sessions: [session], nextCursor: null }; },
		readSession: async ({ checkpoint }) => {
			checkpoints.push(checkpoint);
			const outcome = { status: checkpoints.length === 1 ? "running" : "failed", reason: null, error: null };
			return snapshot([{ ...piRequest, outcome }], checkpoints.length, checkpoint === null ? "full" : "partial");
		},
	}))], { ...options, pollIntervalMs: 10, reconcileIntervalMs: 40 });
	coordinator.start();
	await until(() => checkpoints.length > 2 && checkpoints.slice(1).includes(null));
	assert.equal(checkpoints[0], null);
	assert.ok(checkpoints.some(value => typeof value === "number"));
	assert.ok(hints.some(value => typeof value === "number"));
	assert.equal(store.getRecords(session.identity).length, 1);
	assert.equal(store.getRecords(session.identity)[0].outcome.status, "failed");
});

test("one connection failure is isolated and labeled in dashboard status and subscriptions", async t => {
	const broken = { source: { ...source, sourceId: "broken", label: "Remote" }, config: {}, adapter: {
		descriptor, connect: async () => { throw new Error("Connection refused"); },
	} };
	const { store, coordinator } = setup(t, [broken, registration(connection())]);
	const bridge = createIngestionStatusBridge(coordinator);
	const observed = [];
	const unsubscribe = bridge.subscribe(status => observed.push(status));
	t.after(unsubscribe);
	coordinator.start();
	await until(() => store.getRecords(session.identity).length === 1 && observed.some(s => s.sync.error?.includes("Remote (connect): Connection refused")));
	assert.equal(bridge.status().sources.length, 2);
	assert.equal(bridge.status().sync.phase, "error");
	assert.ok(bridge.status().version > 0);
	await bridge.requestSync(source.sourceId);
	assert.equal(store.getRecords(session.identity).length, 1);
});

test("failed/empty discovery preserves history and does not complete its watermark", async t => {
	let fail = false;
	const { store, coordinator } = setup(t, [registration(connection({ listSessions: async () => {
		if (fail) throw new Error("Discovery unavailable");
		return { sessions: [], nextCursor: null };
	} }))]);
	store.putSource(source);
	store.commitSnapshot(session.identity, snapshot());
	coordinator.start();
	await until(() => idle(coordinator));
	const before = store.getSourceCheckpoint(source.sourceId);
	fail = true;
	await assert.rejects(coordinator.refresh(), /refresh failed/);
	assert.equal(store.getSourceCheckpoint(source.sourceId).lastDiscoveryAt, before.lastDiscoveryAt);
	assert.equal(store.getRecords(session.identity).length, 1);
	assert.equal(coordinator.status().sources[0].phase, "error");
	assert.match(createIngestionStatusBridge(coordinator).status().sync.error, /Discovery unavailable/);
});

test("watch events commit in order; deletion retains spend and full refresh restores availability", async t => {
	let reads = 0;
	const checkpoints = [];
	const { store, coordinator } = setup(t, [registration(connection({
		readSession: async ({ checkpoint }) => {
			checkpoints.push(checkpoint);
			return snapshot([{ ...piRequest, outcome: { status: ++reads === 1 ? "running" : "succeeded", reason: null, error: null } }], `read-${reads}`, checkpoint === null ? "full" : "partial");
		},
		async *watchChanges({ checkpoint, signal }) {
			assert.equal(checkpoint, null);
			yield { kind: "refresh", session: session.identity, checkpoint: "event1" };
			assert.equal(store.getSourceCheckpoint(source.sourceId).watch, "event1");
			yield { kind: "deleted", session: session.identity, provenance: session.provenance, checkpoint: "event2" };
			await delay(100_000, undefined, { signal });
		},
	}))]);
	coordinator.start();
	await until(() => store.getSession(session.identity)?.unavailable !== null && store.getSource(source.sourceId) && store.getSourceCheckpoint(source.sourceId).watch === "event2");
	assert.deepEqual(checkpoints, [null, "read-1"]);
	assert.equal(store.getRecords(session.identity)[0].outcome.status, "succeeded");
	await coordinator.refresh();
	assert.equal(store.getSession(session.identity).unavailable, null);
	assert.equal(store.getRecords(session.identity).length, 1);
});

test("failed watch ingestion retains both checkpoints, replay succeeds after reconnect", async t => {
	let fail = true, watchCalls = 0;
	const watchInputs = [];
	const { store, coordinator } = setup(t, [registration(connection({
		readSession: async ({ checkpoint }) => {
			if (checkpoint !== null && fail) throw new Error("Cannot read update");
			return snapshot([piRequest], checkpoint === null ? "initial" : "updated", checkpoint === null ? "full" : "partial");
		},
		async *watchChanges({ checkpoint, signal }) {
			watchCalls++;
			watchInputs.push(checkpoint);
			yield { kind: "refresh", session: session.identity, checkpoint: "next-event" };
			await delay(100_000, undefined, { signal });
		},
	}))], { ...options, retryDelayMs: 30 });
	store.putSource(source);
	store.commitWatch(source.sourceId, "previous-event");
	coordinator.start();
	await until(() => coordinator.status().sources[0].error === "Cannot read update");
	assert.equal(store.getSession(session.identity).checkpoint, "initial");
	assert.equal(store.getSourceCheckpoint(source.sourceId).watch, "previous-event");
	await until(() => watchCalls >= 2);
	fail = false;
	await until(() => store.getSourceCheckpoint(source.sourceId).watch === "next-event");
	assert.deepEqual(watchInputs.slice(0, 2), ["previous-event", "previous-event"]);
	assert.equal(store.getSession(session.identity).checkpoint, "updated");
	assert.equal(store.getRecords(session.identity).length, 1);
});

test("stream gaps reset opaque watch cursors and reconcile before reconnecting watch", async t => {
	const order = [];
	let watches = 0;
	const { store, coordinator } = setup(t, [registration(connection({
		readSession: async ({ checkpoint }) => { order.push(["read", checkpoint]); return snapshot(); },
		async *watchChanges({ checkpoint, signal }) {
			order.push(["watch", checkpoint]);
			if (++watches === 1) throw new Error("Expired watch cursor");
			await delay(100_000, undefined, { signal });
		},
	}))]);
	store.putSource(source);
	store.commitWatch(source.sourceId, "expired");
	coordinator.start();
	await until(() => watches === 2);
	assert.deepEqual(order, [["read", null], ["watch", "expired"], ["read", null], ["watch", null]]);
});

test("cancellation during read prevents commits and closes the connection once", async t => {
	let reading = false, closed = 0;
	const { store, coordinator } = setup(t, [registration(connection({
		readSession: async ({ signal }) => { reading = true; await delay(100_000, undefined, { signal }); return snapshot(); },
		close: async () => { closed++; },
	}))]);
	coordinator.start();
	await until(() => reading);
	await Promise.all([coordinator.stop(), coordinator.stop()]);
	assert.equal(closed, 1);
	assert.equal(store.getSession(session.identity), null);
	assert.equal(store.getSourceCheckpoint(source.sourceId).lastDiscoveryAt, null);
	assert.equal(coordinator.status().sources[0].phase, "stopped");
	assert.throws(() => coordinator.start(), /stopped/);
});

test("pagination cycles and partial initial snapshots are surfaced without deleting history", async t => {
	const { store, coordinator } = setup(t, [registration(connection({
		listSessions: async () => ({ sessions: [], nextCursor: "loop" }),
	}))], { ...options, retryDelayMs: 1000 });
	coordinator.start();
	await until(() => coordinator.status().sources[0].error?.includes("cursor cycle"));
	assert.equal(store.getSourceCheckpoint(source.sourceId).lastDiscoveryAt, null);
	const another = setup(t, [registration(connection({ readSession: async () => snapshot([], "bad", "partial") }))], { ...options, retryDelayMs: 1000 });
	another.coordinator.start();
	await until(() => another.coordinator.status().sources[0].error?.includes("full snapshot"));
	assert.equal(another.store.getSession(session.identity), null);
});

test("concurrent refreshes serialize mutable reads and commits for the source", async t => {
	let active = 0, maximum = 0, reads = 0;
	const { store, coordinator } = setup(t, [registration(connection({
		readSession: async () => {
			maximum = Math.max(maximum, ++active);
			const revision = ++reads;
			await delay(5);
			active--;
			return snapshot([{ ...piRequest, output: [{ type: "text", text: String(revision) }] }], revision);
		},
	}))]);
	coordinator.start();
	await until(() => idle(coordinator));
	await Promise.all([coordinator.refresh(), coordinator.refresh(), coordinator.refresh()]);
	assert.equal(maximum, 1);
	assert.equal(store.getSession(session.identity).checkpoint, 4);
	assert.equal(store.getRecords(session.identity)[0].output[0].text, "4");
});

test("commit failures retry without acknowledging watch work or rereading its snapshot", async t => {
	const store = new IngestionStore(":memory:");
	const commit = store.commitSnapshot.bind(store);
	let rejectCommit = true, reads = 0;
	store.commitSnapshot = (ref, data) => {
		if (data.checkpoint === "update" && rejectCommit) throw new Error("Storage unavailable");
		commit(ref, data);
	};
	const { coordinator } = setup(t, [registration(connection({
		readSession: async ({ checkpoint }) => { reads++; return snapshot([piRequest], checkpoint === null ? "initial" : "update", checkpoint === null ? "full" : "partial"); },
		async *watchChanges({ signal }) {
			yield { kind: "refresh", session: session.identity, checkpoint: "event" };
			await delay(100_000, undefined, { signal });
		},
	}))], { ...options, retryDelayMs: 30 }, store);
	coordinator.start();
	await until(() => coordinator.status().sources[0].error === "Storage unavailable");
	assert.equal(store.getSession(session.identity).checkpoint, "initial");
	assert.equal(store.getSourceCheckpoint(source.sourceId).watch, null);
	assert.equal(coordinator.status().sources[0].operation, "commit");
	rejectCommit = false;
	await until(() => store.getSourceCheckpoint(source.sourceId).watch === "event");
	assert.equal(reads, 2);
	assert.equal(store.getSession(session.identity).checkpoint, "update");
	assert.equal(coordinator.status().sources[0].error, null);
});

test("watch rescan acknowledges only after its full scan commits", async t => {
	let scans = 0;
	const { store, coordinator } = setup(t, [registration(connection({
		listSessions: async () => { scans++; return { sessions: [session], nextCursor: null }; },
		async *watchChanges({ signal }) {
			yield { kind: "deleted", session: { ...session.identity, sessionId: "not-yet-seen" }, provenance: session.provenance, checkpoint: "deleted" };
			yield { kind: "rescan", checkpoint: "rescanned" };
			await delay(100_000, undefined, { signal });
		},
	}))]);
	coordinator.start();
	await until(() => store.getSource(source.sourceId) && store.getSourceCheckpoint(source.sourceId).watch === "rescanned");
	assert.equal(scans, 2);
	assert.deepEqual(store.getSession({ ...session.identity, sessionId: "not-yet-seen" }).unavailable, session.provenance);
	assert.equal(store.getRecords(session.identity).length, 1);
});
