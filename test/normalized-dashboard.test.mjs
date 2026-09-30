import assert from "node:assert/strict";
import { test } from "node:test";
import { IngestionStore } from "../src/core/storage/index.ts";
import { sessionKey } from "../src/core/model/index.ts";
import { convertSession, convertMessages, capabilities } from "../src/adapters/opencode.ts";
import { DashboardQueries } from "../src/dashboard/server/queries.ts";
import { buildTrace } from "../src/dashboard/server/traces.ts";

test("common queries isolate overlapping identities and replace lifecycle updates without double counting", () => {
	const store = new IngestionStore(":memory:");
	try {
		const sessions = ["pi", "opencode"].map(sourceId => {
			store.putSource({ sourceId, clientType: sourceId, label: sourceId, capabilities });
			return convertSession({ id: "same", location: { directory: "/app" }, time: { created: 1000, updated: 3000 } }, sourceId);
		});
		const msg = { id: "r", type: "assistant", model: { id: "m", providerID: "p" }, time: { created: 1100 }, tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 30, write: 0 } }, cost: 0,
			content: [{ type: "tool", id: "tool", name: "read", time: { created: 1200 }, state: { status: "running", input: { file: "x" } } }] };
		for (const s of sessions) store.commitSnapshot(s.identity, convertMessages(s, [msg]));
		let q = new DashboardQueries(store);
		assert.equal(q.dashboard("all").overall.totalRequests, 2);
		assert.equal(q.dashboard("all").overall.successfulRequests, 0);
		assert.equal(q.dashboard("all").overall.avgDuration, null);
		assert.equal(q.dashboard("all").costSeries[0].costInput, null);
		const first = q.recent(10).find(r => r.sessionFile === sessionKey(sessions[0].identity));
		const etag = buildTrace(q, first.sessionFile).etag;
		assert.equal(q.details(first.id).tools[0].outcome.status, "running");
		store.commitSnapshot(sessions[0].identity, convertMessages(sessions[0], [{ ...msg, time: { created: 1100, completed: 2100 }, finish: "error", error: { message: "failed" }, cost: 0.75,
			content: [{ ...msg.content[0], time: { created: 1200, completed: 2000 }, state: { status: "completed", content: [{ type: "text", text: "contents" }], input: { file: "x" } } }] }]));
		q = new DashboardQueries(store);
		assert.equal(q.dashboard("all").overall.totalRequests, 2);
		assert.equal(q.dashboard("all").overall.failedRequests, 1);
		assert.equal(q.dashboard("all").overall.totalCost, 0.75);
		assert.equal(q.dashboard("all").overall.avgDuration, 1000);
		assert.equal(q.details(first.id).tools[0].result[0].text, "contents");
		assert.equal(q.details(first.id).cost.recorded.categories.input, null);
		assert.notEqual(buildTrace(q, first.sessionFile).etag, etag);
		assert.equal(q.toolDashboard("all").byTool[0].costShare, 0.75);
		assert.equal(q.recent(10, true).length, 1);
		assert.equal(buildTrace(q, "/etc/passwd"), null);
	} finally { store.close(); }
});

test("child-only changes invalidate parent traces; fork context does not inflate spend", () => {
	const store = new IngestionStore(":memory:");
	try {
		store.putSource({ sourceId: "source", clientType: "fixture", label: "fixture", capabilities });
		const root = convertSession({ id: "root", location: {}, time: { created: 1000, updated: 3000 } }, "source");
		const child = convertSession({ id: "child", parentID: "root", location: {}, time: { created: 1000, updated: 3000 } }, "source");
		const fork = convertSession({ id: "fork", fork: { sessionID: "root", boundary: { type: "through", messageID: "r" } }, location: {}, time: { created: 1000, updated: 3000 } }, "source");
		const msg = { id: "r", type: "assistant", model: { id: "m", providerID: "p" }, time: { created: 1100, completed: 2100 }, finish: "stop", cost: 1 };
		for (const s of [root, child]) store.commitSnapshot(s.identity, convertMessages(s, [msg]));
		const copied = convertMessages(fork, [msg]); copied.records[0].origin = { ...root.identity, recordId: "r" };
		store.commitSnapshot(fork.identity, copied);
		let q = new DashboardQueries(store), trace = buildTrace(q, sessionKey(root.identity));
		assert.equal(trace.tracks.length, 2);
		assert.equal(trace.summary.costTotal, 2);
		assert.equal(q.dashboard("all").overall.totalCost, 2);
		store.commitSnapshot(child.identity, convertMessages(child, [{ ...msg, cost: 2 }]));
		const next = buildTrace(new DashboardQueries(store), sessionKey(root.identity));
		assert.notEqual(next.etag, trace.etag);
		assert.equal(next.summary.costTotal, 3);
	} finally { store.close(); }
});
