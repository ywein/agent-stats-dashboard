// End-to-end: fixture sessions + pricing snapshot -> bundled server -> API totals.
// Covers the node:sqlite shim, parser, registry pricing fallback, cwd folders,
// subagent classification and latency fields. Requires `npm run build` first.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

const line = o => `${JSON.stringify(o)}\n`;
const usage = (input, output, cost) => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

test("dashboard API reports priced totals for pi sessions", async t => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-stats-e2e-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const project = join(agentDir, "sessions", "--work-my-app--");
	mkdirSync(join(project, "sess", "child", "run-0"), { recursive: true });
	const ts = Date.now() - 60_000;
	const iso = new Date(ts).toISOString();

	writeFileSync(
		join(project, "sess.jsonl"),
		line({ type: "session", version: 3, id: "s1", timestamp: iso, cwd: "/work/my-app" }) +
			line({ type: "message", id: "u1", parentId: null, timestamp: iso, message: { role: "user", content: "hi" } }) +
			// A recorded $0 bridge request must remain zero even with a public API card.
			line({
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: iso,
				message: {
					role: "assistant",
					api: "x",
					provider: "claude-bridge",
					model: "claude-x",
					usage: usage(1_000_000, 0, 0),
					stopReason: "toolUse",
					timestamp: ts,
					duration: 2000,
					ttft: 500,
					content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } }],
				},
			}) +
			line({
				type: "message",
				id: "r1",
				parentId: "a1",
				timestamp: iso,
				message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "abc" }], isError: false },
			}) +
			// Untyped pi-subagents record: must be ignored.
			line({ recordType: "tool", agent: "x", childIndex: 0, cwd: "/work/my-app" }),
	);
	writeFileSync(
		join(project, "sess", "child", "run-0", "session.jsonl"),
		line({ type: "session", version: 3, id: "s2", timestamp: iso, cwd: "/work/my-app" }) +
			line({
				type: "message",
				id: "a2",
				parentId: null,
				timestamp: iso,
				message: {
					role: "assistant",
					api: "x",
					provider: "openai",
					model: "gpt-x",
					usage: usage(10, 10, 1.5),
					stopReason: "stop",
					timestamp: ts,
					content: [],
				},
			}),
	);
	mkdirSync(join(agentDir, "pi-stats-web"), { recursive: true });
	writeFileSync(
		join(agentDir, "pi-stats-web", "models.json"),
		JSON.stringify({
			"claude-bridge": { "claude-x": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
			anthropic: { "claude-x": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
		}),
	);

	const server = spawn(process.execPath, ["--no-warnings", "dist/server.js", "--client", "pi", "--port", "0"], {
		env: { ...process.env, PI_STATS_AGENT_DIR: agentDir, AGENT_STATS_DIR: join(agentDir, "cache"), AGENT_STATS_IDLE_MS: "0" },
		stdio: ["ignore", "pipe", "inherit"],
	});
	t.after(() => server.kill());
	const [first] = await createInterface({ input: server.stdout })[Symbol.asyncIterator]().next().then(r => [r.value]);
	const { url } = JSON.parse(first);

	const get = async p => (await fetch(url + p)).json();
	let status;
	for (let i = 0; i < 50; i++) {
		status = await get("/api/status");
		if (status.sync.phase === "idle" && status.sync.lastSyncedAt) break;
		await new Promise(r => setTimeout(r, 100));
	}

	const { overall, byAgentType } = await get("/api/stats/overview?range=all");
	assert.equal(overall.totalRequests, 2);
	assert.equal(overall.totalCost, 1.5, "recorded bridge zero is preserved alongside recorded $1.50");
	assert.equal(overall.avgDuration, 2000);
	assert.equal(overall.avgTtft, 500);
	assert.deepEqual(byAgentType.map(a => [a.agentType, a.totalRequests]).sort(), [
		["main", 1],
		["subagent", 1],
	]);

	const folders = await get("/api/stats/folders?range=all");
	assert.deepEqual(
		folders.map(f => f.folder),
		["/work/my-app"],
	);

	const tools = await get("/api/stats/tools?range=all");
	assert.equal(tools.byTool[0].tool, "read");

	// DNS-rebinding guard. fetch() drops a custom Host header, so use node:http.
	const denied = await new Promise((resolve, reject) =>
		request(`${url}/api/health`, { headers: { Host: "evil.example" } }, res => resolve(res.statusCode))
			.on("error", reject)
			.end(),
	);
	assert.equal(denied, 403);
});
