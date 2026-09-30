import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { createDashboardLauncher } from "../src/dashboard/launcher.ts";

test("shared launcher starts, reuses, scopes URLs and isolates configurations", async t => {
	const dir = await mkdtemp(join(tmpdir(), "launcher-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const server = createServer((_, res) => { res.end('{"app":"unrelated","pid":1}'); });
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise(resolve => server.close(resolve)));
	const basePort = server.address().port;
	const entry = join(dir, "server.mjs");
	await writeFile(entry, `import { createServer } from "node:http";
const args = process.argv; const key = args[args.indexOf("--launcher-key") + 1];
createServer((_, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ app: "fixture-launcher", pid: process.pid, launcherKey: key })); }).listen(Number(args[args.indexOf("--port") + 1]), "127.0.0.1");`);
	const launcher = createDashboardLauncher({ app: "fixture-launcher", basePort, serverEntry: entry, dataDirectory: dir, sourceId: "fixture:a b" });
	const pids = new Set(); t.after(() => { for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch {} } });
	const url = await launcher.ensure();
	const health = await (await fetch(new URL("/api/health", url))).json(); pids.add(health.pid);
	assert.ok(Number(new URL(url).port) > basePort);
	assert.equal(new URLSearchParams(new URL(url).hash.split("?")[1]).get("sourceId"), "fixture:a b");
	assert.equal(await launcher.ensure(), url);
	assert.equal((await launcher.find()).pid, health.pid);
	const other = createDashboardLauncher({ app: "fixture-launcher", basePort, serverEntry: entry, dataDirectory: join(dir, "other") });
	const otherURL = await other.ensure(); pids.add((await other.find()).pid);
	assert.notEqual(new URL(otherURL).port, new URL(url).port);
	// A source file entirely replaces client defaults: both integrations can reuse it.
	const sourcesFile = join(dir, "sources.json"); await writeFile(sourcesFile, "[]");
	const configured = { app: "fixture-launcher", basePort, serverEntry: entry, dataDirectory: dir, sourcesFile };
	const pi = createDashboardLauncher({ ...configured, serverArguments: ["--client", "pi"], env: { PI_STATS_AGENT_DIR: "/fixture/pi" } });
	const opencode = createDashboardLauncher({ ...configured, serverArguments: ["--client", "opencode"] });
	const configuredURL = await pi.ensure(); pids.add((await pi.find()).pid);
	assert.equal(await opencode.ensure(), configuredURL);
});

test("launcher reports missing builds and early process exit", async t => {
	const dir = await mkdtemp(join(tmpdir(), "launcher-error-")); t.after(() => rm(dir, { recursive: true, force: true }));
	const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const basePort = server.address().port; await new Promise(resolve => server.close(resolve));
	const options = { app: "fixture", basePort, serverEntry: join(dir, "missing.mjs"), dataDirectory: dir };
	await assert.rejects(createDashboardLauncher(options).ensure(), /missing.*build/);
	await writeFile(options.serverEntry, 'process.exit(1)');
	await assert.rejects(createDashboardLauncher(options).ensure(), /failed to start.*server.log/);
	assert.throws(() => createDashboardLauncher({ ...options, basePort: NaN }), /base port/);
});
