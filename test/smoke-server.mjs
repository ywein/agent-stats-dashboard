// Disposable browser fixtures: npm run build && node test/smoke-server.mjs
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startDashboard } from "../src/dashboard/server/runtime.ts";
import { piAdapter, capabilities as piCapabilities } from "../src/adapters/pi.ts";
import { openCodeAdapter, capabilities as ocCapabilities } from "../src/adapters/opencode.ts";
import { dashboardConfig as piConfig, dashboardConfig as ocConfig } from "../src/config.ts";
import { multiSourceFixture } from "./multi-source-fixture.mjs";

const dir = await mkdtemp(join(tmpdir(), "dashboard-smoke-")), at = Date.now() - 5000;
const session = { id: "fixture", title: "Read fixture", location: { directory: "/work/app" }, time: { created: at, updated: at + 2000 } };
const messages = [{ id: "user", type: "user", text: "Read the fixture", time: { created: at } },
	{ id: "request", type: "assistant", model: { id: "fixture-model", providerID: "fixture" }, time: { created: at + 100, streamed: at + 200, completed: at + 1400 },
		cost: 0, tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 30, write: 5 } }, finish: "tool-calls",
		content: [{ type: "text", text: "Here is the fixture." }, { type: "tool", id: "call", name: "read", state: { status: "completed", input: { path: "fixture.txt" }, content: [{ type: "text", text: "Fixture contents" }] }, time: { created: at + 300, completed: at + 1200 } }] }];
const api = createServer((req, res) => {
	const p = new URL(req.url, "http://fixture").pathname;
	const data = p === "/api/model" ? [{ id: "fixture-model", providerID: "fixture", cost: [{ input: 2, output: 8, cache: { read: 0.2, write: 2 } }] }] : p === "/api/session" ? [session] : messages;
	res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data }));
});
api.listen(0, "127.0.0.1"); await once(api, "listening");
const root = join(dir, "sessions"); await mkdir(join(root, "project"), { recursive: true });
await writeFile(join(root, "project", "fixture.jsonl"), [
	{ type: "session", id: "fixture", title: "Read fixture", cwd: "/work/app", timestamp: new Date(at).toISOString() },
	{ type: "message", id: "user", message: { role: "user", content: "Read the fixture" }, timestamp: new Date(at).toISOString() },
	{ type: "message", id: "request", parentId: "user", timestamp: new Date(at + 100).toISOString(), message: { role: "assistant", provider: "fixture", model: "fixture-model", api: "fixture", timestamp: at + 100, duration: 1300, ttft: 100, stopReason: "toolUse",
		usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 5, totalTokens: 65, cost: { total: 0 } }, content: [{ type: "text", text: "Here is the fixture." }, { type: "toolCall", id: "call", name: "read", arguments: { path: "fixture.txt" } }] } },
	{ type: "message", id: "result", timestamp: new Date(at + 1200).toISOString(), message: { role: "toolResult", toolCallId: "call", content: [{ type: "text", text: "Fixture contents" }], isError: false } },
].map(JSON.stringify).join("\n") + "\n");
const handles = [];
for (const [name, port, adapter, capabilities, config, sourceConfig] of [
	["pi", 38480, piAdapter, piCapabilities, piConfig, { root }],
	["opencode", 38580, openCodeAdapter, ocCapabilities, ocConfig, { url: `http://127.0.0.1:${api.address().port}` }],
]) handles.push(await startDashboard({ app: name, port, config, database: join(dir, `${name}.db`), staticDirectory: resolve("dist/client"),
	sources: [{ source: { sourceId: name, clientType: name, label: name, capabilities }, adapter, config: sourceConfig }] }));
handles.push(await startDashboard({ app: "mixed", port: 38680, config: piConfig, database: join(dir, "mixed.db"), staticDirectory: resolve("dist/client"), sources: multiSourceFixture().sources }));
console.log("Pi: http://127.0.0.1:38480 — OpenCode: http://127.0.0.1:38580 — Mixed: http://127.0.0.1:38680");
async function stop() { await Promise.all(handles.map(h => h.stop())); api.closeAllConnections(); api.close(); await rm(dir, { recursive: true, force: true }); process.exit(0); }
process.on("SIGTERM", stop); process.on("SIGINT", stop);
