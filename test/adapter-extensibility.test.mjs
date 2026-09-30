import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { loadSources } from "../src/adapters/sources.ts";
import { startDashboard } from "../src/dashboard/server/runtime.ts";
import { dashboardConfig } from "../src/config.ts";

test("external fixture adapter feeds unchanged dashboard routes and queries", async t => {
	const dir = await mkdtemp(join(tmpdir(), "extensibility-")); t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "sources.json");
	await writeFile(file, JSON.stringify([{ sourceId: "third-party", clientType: "fixture", label: "Third party",
		adapter: new URL("../examples/fixture.ts", import.meta.url).pathname, config: {} }]));
	const runtime = await startDashboard({ app: "fixture", config: dashboardConfig, database: join(dir, "db.sqlite"),
		staticDirectory: dir, sources: await loadSources(file), port: 0 });
	t.after(() => runtime.stop());
	const get = async route => {
		const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`);
		assert.equal(response.status, 200); return response.json();
	};
	let requests;
	for (let i = 0; i < 100; i++) {
		requests = await get("/api/stats/recent?sourceId=third-party");
		if (requests.length === 2) break;
		await delay(10);
	}
	assert.equal(requests.length, 2);
	await get("/api/stats/overview?sourceId=third-party");
	const { sources } = await get("/api/sources");
	assert.equal(sources[0].clientType, "fixture");
	assert.equal(sources[0].capabilities.recordedCosts, false);
});
