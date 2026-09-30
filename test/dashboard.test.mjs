import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const timestamp = 1_800_000_000_000;
const iso = new Date(timestamp).toISOString();
const usage = { input: 10, output: 20, cacheRead: 30, cacheWrite: 5, totalTokens: 65,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.75 } };
const session = { id: "ses_fixture", title: "Fixture session", location: { directory: "/work/app" },
	time: { created: timestamp, updated: timestamp + 2000 } };
const messages = [
	{ id: "u1", type: "user", text: "Read the file", time: { created: timestamp } },
	{ id: "a1", type: "assistant", model: { providerID: "fixture", id: "model" },
		time: { created: timestamp + 100, streamed: timestamp + 300, completed: timestamp + 1500 },
		cost: 0.75, tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 30, write: 5 } }, finish: "tool-calls",
		content: [{ type: "tool", id: "call_1", name: "read", state: { status: "completed",
			input: { path: "x" }, content: [{ type: "text", text: "contents" }] },
			time: { created: timestamp + 400, completed: timestamp + 1400 } }] },
];
const journal = [
	{ type: "session", version: 3, id: session.id, timestamp: iso, cwd: "/work/app", title: session.title },
	{ type: "message", id: "u1", parentId: null, timestamp: iso, message: { role: "user", content: "Read the file" } },
	{ type: "message", id: "a1", parentId: "u1", timestamp: new Date(timestamp + 100).toISOString(),
		message: { role: "assistant", api: "fixture", provider: "fixture", model: "model", timestamp: timestamp + 100,
			duration: 1400, ttft: 200, stopReason: "toolUse", usage,
			content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "x" } }] } },
	{ type: "message", id: "a1:call_1", parentId: "a1", timestamp: new Date(timestamp + 1400).toISOString(),
		message: { role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: "contents" }], isError: false } },
].map(entry => JSON.stringify(entry)).join("\n") + "\n";

async function start(t, directory, data, source, serviceUrl, args = []) {
	const child = spawn(process.execPath, ["--no-warnings", ...(source === "opencode" ? ["--import", join(root, "test/service-fixture.mjs")] : []),
		"dist/server.js", "--port", "0", "--client", source === "fixture" ? "pi" : source, ...args], {
		cwd: directory,
		env: { ...process.env, PI_STATS_AGENT_DIR: data, AGENT_STATS_DIR: data,
			AGENT_STATS_IDLE_MS: "0", TEST_OPENCODE_URL: serviceUrl },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let errors = "";
	child.stderr.on("data", chunk => errors += chunk);
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill();
			await exited;
		}
	});
	const lines = createInterface({ input: child.stdout });
	const first = await Promise.race([
		once(lines, "line").then(([line]) => JSON.parse(line)),
		once(child, "exit").then(() => { throw new Error(`Dashboard exited: ${errors}`); }),
	]);
	return first.url;
}

async function waitForData(url) {
	for (let i = 0; i < 100; i++) {
		const response = await fetch(`${url}/api/stats/overview?range=all`);
		const body = await response.json();
		if (body.overall.totalRequests === 1) return;
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	assert.fail("Fixture request was not ingested");
}

// Capture representative responses while testing complete field/type compatibility.
// Values such as DB ids, trace fingerprints and sync times are intentionally volatile.
function shape(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return value.map(shape);
	if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, shape(val)]));
	return typeof value;
}

test("single packed plugin rebuilds independently and serves both adapters", { timeout: 120_000 }, async t => {
	const dir = await mkdtemp(join(tmpdir(), "dashboard-contract-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const fixture = createServer((req, res) => {
		const path = new URL(req.url, "http://fixture").pathname;
		const data = path === "/api/model" ? [] : path === "/api/session" ? [session] :
			path === `/api/session/${session.id}/message` ? messages : null;
		res.writeHead(data ? 200 : 404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ data }));
	});
	fixture.listen(0, "127.0.0.1");
	await once(fixture, "listening");
	t.after(() => { fixture.closeAllConnections(); fixture.close(); });
	const serviceUrl = `http://127.0.0.1:${fixture.address().port}`;

	// Install actual tarballs outside the workspace. No symlinks or sibling source
	// directories are available to either backend during its build or execution.
	const packed = execFileSync("npm", ["pack", "--json", "--pack-destination", dir], { cwd: root, encoding: "utf8" });
	const archives = [join(dir, JSON.parse(packed.slice(packed.indexOf("[")))[0].filename)];
	const install = join(dir, "install");
	await mkdir(install);
	await writeFile(join(install, "package.json"), '{"private":true,"type":"module"}');
	execFileSync("npm", ["install", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund", ...archives], { cwd: install, stdio: "pipe" });
	const directory = join(install, "node_modules", "agent-stats");
	await rm(join(directory, "dist"), { recursive: true, force: true });
	execFileSync("npm", ["run", "build"], { cwd: directory, stdio: "pipe" });
	const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
	assert.deepEqual(manifest.pi.extensions, ["./dist/pi.js"]);
	assert.equal(manifest.exports["."], "./dist/opencode.js");
	assert.equal(manifest.bin["agent-stats"], "./dist/server.js");
	assert.match(execFileSync(join(install, "node_modules/.bin/agent-stats"), ["--help"], { encoding: "utf8" }), /Usage: agent-stats/);
	for (const file of ["dist/pi.js", "dist/opencode.js", "dist/adapter-contract.js", "dist/client/index.js"]) await readFile(join(directory, file));
	for (const source of ["pi", "opencode"]) {
		await t.test(source, async t => {
			const data = join(dir, source);
			if (source === "pi") {
				await mkdir(join(data, "sessions", "fixture"), { recursive: true });
				await writeFile(join(data, "sessions", "fixture", "session.jsonl"), journal);
			}
			const url = await start(t, directory, data, source, serviceUrl);
			await waitForData(url);
			const json = async path => {
				const response = await fetch(url + path);
				assert.equal(response.status, 200, path);
				return response.json();
			};
			assert.equal((await json("/api/health")).app, "agent-stats");
			const config = await json("/api/config");
			assert.equal(config.sourceLabel, "Coding agents");
			assert.ok(config.features.sections.includes("traces"));
			assert.equal(config.features.judge, false);
			const responses = {};
			for (const path of ["/api/stats", "/api/stats/overview", "/api/stats/recent", "/api/stats/tools", "/api/sessions",
				"/api/stats/model-dashboard", "/api/stats/costs", "/api/stats/providers", "/api/stats/provider-windows",
				"/api/stats/folders", "/api/stats/errors", "/api/stats/frustration", "/api/frustration/estimate"]) {
				responses[path] = await json(`${path}?range=all`);
			}
			const overall = responses["/api/stats/overview"].overall;
			assert.equal(overall.totalCost, 0.75);
			assert.equal(overall.totalRequests, 1);
			assert.equal(overall.avgDuration, 1400);
			assert.equal(overall.avgTtft, 200);
			assert.equal(responses["/api/stats/tools"].byTool[0].tool, "read");
			const request = responses["/api/stats/recent"][0];
			assert.deepEqual(request.usage, { ...usage, reasoning: source === "pi" ? null : 0, cost: source === "pi" ? usage.cost : { input: null, output: null, cacheRead: null, cacheWrite: null, total: 0.75 }, premiumRequests: 0 });
			responses["/api/request/:id"] = await json(`/api/request/${request.id}`);
			const traceUrl = `/api/session/trace?file=${encodeURIComponent(request.sessionFile)}`;
			const trace = await fetch(url + traceUrl);
			responses["/api/session/trace"] = await trace.json();
			assert.equal((await fetch(url + traceUrl, { headers: { "If-None-Match": trace.headers.get("etag") } })).status, 304);
			responses["/api/session/entry"] = await json(`/api/session/entry?file=${encodeURIComponent(request.sessionFile)}&id=a1`);
			assert.equal(responses["/api/session/entry"].entry.kind, "model-request");
			assert.equal(responses["/api/request/:id"].record.kind, "model-request");
			assert.deepEqual(JSON.parse(request.sessionFile).slice(1), [session.id]);
			if (source === "opencode") await assert.rejects(readdir(join(data, "sessions")), { code: "ENOENT" });
			const exampleFile = join(root, "test/contract", `${source}.json`);
			if (process.env.UPDATE_CONTRACT) {
				const sanitized = JSON.stringify(responses, null, 2).replaceAll(data, "<data>");
				await writeFile(exampleFile, sanitized + "\n");
			}
			assert.deepEqual(shape(responses), shape(JSON.parse(await readFile(exampleFile, "utf8"))));
			for (const path of ["/api/sync", "/api/frustration/judge", "/api/frustration/cancel"]) {
				assert.equal((await fetch(url + path)).status, 405);
				assert.equal((await fetch(url + path, { method: "POST" })).status, 403);
				assert.equal((await fetch(url + path, { method: "POST", headers: { "X-Dashboard-Action": "wrong" } })).status, 403);
				const result = await fetch(url + path, { method: "POST", headers: { "X-Dashboard-Action": "1" } });
				assert.equal(result.status, path === "/api/sync" ? 202 : path.endsWith("judge") ? 503 : 200);
			}
			assert.equal((await fetch(url + "/api/request/99999")).status, 404);
			assert.equal((await fetch(url + "/api/session/trace")).status, 400);
			for (const file of ["/", "/index.js", "/index.css", "/a/deep/link"]) assert.equal((await fetch(url + file)).status, 200);
			const stream = await fetch(url + "/api/events");
			assert.match(stream.headers.get("content-type"), /text\/event-stream/);
			const reader = stream.body.getReader();
			assert.match(new TextDecoder().decode((await reader.read()).value), /^data: /);
			await reader.cancel();
		});
	}
	await t.test("published fixture adapter and contract suite", async t => {
		const sources = join(install, "sources.json");
		await writeFile(sources, JSON.stringify([{ sourceId: "external", clientType: "fixture", label: "Fixture",
			adapter: "agent-stats/example", config: {} }]));
		const url = await start(t, directory, join(dir, "fixture"), "fixture", undefined, ["--sources", sources]);
		let requests;
		for (let i = 0; i < 100; i++) {
			requests = await (await fetch(`${url}/api/stats/recent?sourceId=external`)).json();
			if (requests.length === 2) break;
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		assert.equal(requests.length, 2);
		await writeFile(join(install, "contract.test.mjs"), `
import { adapterContractTests } from 'agent-stats/testing';
import { createFixtureAdapter, capabilities } from 'agent-stats/example';
adapterContractTests('packed fixture', () => ({ ...createFixtureAdapter(), source: { sourceId: 'packed', clientType: 'fixture', label: 'Packed', capabilities }, config: {} }));`);
		execFileSync(process.execPath, ["--test", "contract.test.mjs"], { cwd: install, stdio: "pipe" });
	});
});
