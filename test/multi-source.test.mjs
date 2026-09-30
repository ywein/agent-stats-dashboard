import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "../src/dashboard/server/runtime.ts";
import { dashboardConfig } from "../src/config.ts";
import { multiSourceFixture } from "./multi-source-fixture.mjs";

test("mixed-source filtering, record isolation, coverage, pricing bases and targeted refresh", async t => {
	const dir = await mkdtemp(join(tmpdir(), "multi-source-"));
	const fixture = multiSourceFixture();
	const runtime = await startDashboard({ app: "test", config: dashboardConfig, sources: fixture.sources,
		database: join(dir, "test.db"), staticDirectory: dir, port: 0, pollIntervalMs: 60_000 });
	t.after(async () => { await runtime.stop(); await rm(dir, { recursive: true, force: true }); });
	const base = `http://127.0.0.1:${runtime.port}`;
	const json = async path => { const response = await fetch(base + path); assert.equal(response.status, 200, path); return response.json(); };
	for (let i = 0; i < 100; i++) {
		if ((await json("/api/status")).sources.every(s => s.phase === "idle")) break;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	const all = await json("/api/stats?range=all");
	assert.equal(all.overall.totalRequests, 3);
	const info = await json("/api/sources?range=all");
	assert.equal(info.coverage.latency, 2);
	assert.equal(info.coverage.ttft, 2);
	assert.deepEqual(info.coverage.recorded, { available: 1, total: 0 });
	assert.equal(info.coverage.estimated.available, 1);
	assert.equal(info.coverage.breakdownDifference.available, 1);
	assert.ok(info.coverage.breakdownDifference.total > 0);
	assert.equal((await json("/api/stats?range=all&clientType=fixture")).overall.totalRequests, 2);
	let total = 0, cost = 0;
	for (const source of fixture.sources) {
		const filter = `sourceId=${encodeURIComponent(source.source.sourceId)}`;
		const stats = await json(`/api/stats?range=all&${filter}`);
		total += stats.overall.totalRequests; cost += stats.overall.totalCost;
		assert.equal(stats.overall.totalRequests, 1);
		const requests = await json(`/api/stats/recent?${filter}`);
		assert.equal(requests.length, 1);
		assert.equal(requests[0].source.sourceId, source.source.sourceId);
		assert.equal((await json(`/api/sessions?${filter}`)).length, 1);
		assert.equal((await fetch(`${base}/api/request/${requests[0].id}?sourceId=absent`)).status, 400);
		const other = source.source.sourceId === "minimal" ? "estimated" : "minimal";
		assert.equal((await fetch(`${base}/api/request/${requests[0].id}?sourceId=${other}`)).status, 404);
		assert.equal((await fetch(`${base}/api/session/trace?file=${encodeURIComponent(requests[0].sessionFile)}&sourceId=${other}`)).status, 404);
		assert.equal((await fetch(`${base}/api/session/entry?file=${encodeURIComponent(requests[0].sessionFile)}&id=same&sourceId=${other}`)).status, 404);
	}
	assert.equal(total, all.overall.totalRequests);
	assert.equal(cost, all.overall.totalCost);
	const minimal = await json("/api/sources?range=all&sourceId=minimal");
	assert.equal(minimal.coverage.latency, 0);
	assert.equal(minimal.coverage.recorded.total, null);
	assert.equal(minimal.coverage.estimated.total, null);
	assert.equal(minimal.coverage.estimatedCategories.input.total, null);
	assert.equal((await json("/api/stats?range=all&sourceId=minimal")).overall.avgDuration, null);
	assert.equal((await json("/api/stats/tools?range=all&sourceId=minimal")).byTool.length, 0);
	assert.equal((await json("/api/stats/costs?range=all&sourceId=minimal")).costSeries[0].recordedCost, null);
	assert.equal((await fetch(`${base}/api/stats?clientType=missing`)).status, 400);
	assert.equal((await json("/api/stats?range=all&sourceId=minimal&clientType=fixture")).overall.totalRequests, 0);
	const before = new Map(fixture.reads);
	assert.equal((await fetch(`${base}/api/sync?sourceId=minimal`, { method: "POST" })).status, 403);
	assert.equal((await fetch(`${base}/api/sync?sourceId=minimal`, { method: "POST", headers: { "X-Dashboard-Action": "1" } })).status, 202);
	for (let i = 0; i < 100 && fixture.reads.get("minimal") === before.get("minimal"); i++) await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(fixture.reads.get("minimal"), before.get("minimal") + 1);
	assert.equal(fixture.reads.get("estimated"), before.get("estimated"));
	assert.equal(fixture.reads.get("recorded / local"), before.get("recorded / local"));
});
