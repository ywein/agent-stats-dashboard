import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { IngestionStore } from "../../core/storage/index.ts";
import { IngestionCoordinator } from "../../core/ingestion/index.ts";
import { assertAdapterCompatible } from "../index.ts";

/** Register against a fresh, deterministic backend with >=2 sessions and one running request.
 * create() returns { adapter, source, config, advance, remove, failNext, cleanup? }.
 * advance completes that request, remove emits its tombstone, failNext fails one read/discovery.
 */
export function adapterContractTests(name, create) {
	async function setup(t) {
		const fixture = await create();
		assertAdapterCompatible(fixture.adapter);
		const controller = new AbortController();
		const connection = await fixture.adapter.connect(fixture.config, { source: fixture.source, signal: controller.signal, log() {} });
		t.after(async () => { controller.abort(); await connection.close(); await fixture.cleanup?.(); });
		const input = { cursor: null, updatedSince: null, signal: controller.signal };
		return { ...fixture, connection, controller, input };
	}
	async function discover(f) {
		const sessions = []; const cursors = new Set(); let cursor = null;
		do {
			assert.ok(!cursors.has(cursor), "pagination must terminate without cursor cycles"); cursors.add(cursor);
			const page = await f.connection.listSessions({ ...f.input, cursor });
			assert.ok(page.nextCursor === null || typeof page.nextCursor === "string");
			sessions.push(...page.sessions); cursor = page.nextCursor;
		} while (cursor !== null);
		assert.ok(sessions.length >= 2, "contract fixture needs at least two sessions");
		assert.equal(new Set(sessions.map(s => JSON.stringify(s.identity))).size, sessions.length);
		for (const session of sessions) assert.equal(session.identity.sourceId, f.source.sourceId);
		return sessions;
	}
	const read = (f, session, checkpoint = null) => f.connection.readSession({ session: session.identity, checkpoint, signal: f.controller.signal });
	test(`${name}: pagination and stable identity across reconnect`, async t => {
		const f = await setup(t); const sessions = await discover(f);
		assert.deepEqual((await discover(f)).map(s => s.identity), sessions.map(s => s.identity));
		const first = await read(f, sessions[0]);
		assert.equal(first.mode, "full");
		await f.connection.close();
		f.connection = await f.adapter.connect(f.config, { source: f.source, signal: f.controller.signal, log() {} });
		t.after(() => f.connection.close());
		assert.deepEqual((await read(f, sessions[0])).records.map(r => r.identity), first.records.map(r => r.identity));
	});
	test(`${name}: incremental replacement, missing values and explicit deletion`, async t => {
		const f = await setup(t); const [session] = await discover(f);
		const store = new IngestionStore(":memory:"); t.after(() => store.close()); store.putSource(f.source);
		const first = await read(f, session); store.commitSnapshot(session.identity, first);
		const running = first.records.find(r => r.kind === "model-request" && r.outcome.status === "running");
		assert.ok(running, "fixture must supply a running request");
		assert.equal(running.timing.ttftMs, null); assert.equal(running.cost.recorded.total, null);
		assert.equal(running.usage.output, null);
		await f.advance();
		const next = await read(f, session, first.checkpoint); store.commitSnapshot(session.identity, next);
		store.commitSnapshot(session.identity, next);
		const completed = store.getRecords(session.identity).find(r => r.identity.recordId === running.identity.recordId);
		assert.equal(completed.outcome.status, "succeeded");
		assert.equal(store.getRecords(session.identity).length, first.records.length);
		// Omission is not a tombstone, even during full reconciliation.
		store.commitSnapshot(session.identity, { ...next, mode: "full", records: [], deleted: [] });
		assert.equal(store.getRecords(session.identity).length, first.records.length);
		await f.remove(); const removed = await read(f, session, next.checkpoint);
		assert.ok(removed.deleted.some(d => d.identity.recordId === running.identity.recordId));
		store.commitSnapshot(session.identity, removed);
		assert.ok(!store.getRecords(session.identity).some(r => r.identity.recordId === running.identity.recordId));
	});
	test(`${name}: errors, coordinator retries, reconciliation and shutdown`, async t => {
		const f = await create(); t.after(() => f.cleanup?.());
		const store = new IngestionStore(":memory:");
		const coordinator = new IngestionCoordinator(store, [f], { retryDelayMs: 5, maxAttempts: 2, pollIntervalMs: 10000, reconcileIntervalMs: 10000 });
		t.after(async () => { await coordinator.stop(); store.close(); });
		await f.failNext(); coordinator.start();
		for (let i = 0; i < 200 && coordinator.status().sources[0].phase !== "idle"; i++) await delay(10);
		assert.equal(coordinator.status().sources[0].phase, "idle", "a transient failure must recover");
		await coordinator.refresh(); await coordinator.stop(); await coordinator.stop();
		assert.equal(coordinator.status().sources[0].phase, "stopped");
	});
	test(`${name}: cancellation and idempotent close`, async t => {
		const f = await setup(t); const [session] = await discover(f);
		f.controller.abort();
		await assert.rejects(() => read(f, session));
		await f.connection.close(); await f.connection.close();
	});
}
