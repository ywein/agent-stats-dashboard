import assert from "node:assert/strict";
import { test } from "node:test";
import { convertSession, convertMessages } from "../../src/adapters/opencode.ts";

test("OpenCode conversion uses normalized records without transcript files", () => {
	const session = convertSession({ id: "ses_1", title: "test", location: { directory: "/work/app" }, time: { created: 1000, updated: 3000 } }, "source");
	const snapshot = convertMessages(session, [
		{ id: "msg_1", type: "user", text: "Hello", time: { created: 1000 } },
		{ id: "msg_2", type: "assistant", time: { created: 1100, streamed: 1300, completed: 2500 },
			model: { providerID: "anthropic", id: "claude-test" }, cost: 0.75,
			tokens: { input: 10, output: 20, cache: { read: 30, write: 5 } }, finish: "tool-calls",
			content: [{ type: "tool", id: "call_1", name: "read", state: { status: "completed", input: { path: "x" }, content: [{ type: "text", text: "contents" }] }, time: { created: 1400, completed: 2400 } }] },
	]);
	const request = snapshot.records.find(r => r.kind === "model-request"), tool = snapshot.records.find(r => r.kind === "tool-execution");
	assert.equal(session.project.directory, "/work/app");
	assert.equal(request.prompt.recordId, "msg_1");
	assert.equal(request.cost.recorded.total.amount, 0.75);
	assert.equal(request.cost.recorded.categories.input, null);
	assert.equal(request.timing.durationMs.value, 1400);
	assert.equal(request.timing.ttftMs.value, 200);
	assert.equal(tool.result[0].text, "contents");
	assert.equal(tool.timing.durationMs.value, 1000);
});
