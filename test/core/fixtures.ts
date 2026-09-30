import type { ModelRequest, PricingBasis, RequestCost, Session, SessionRecord, ToolExecution, UserMessage } from "../../src/core/model/index.ts";

// Representative structural examples from stats/src/types.ts and
// opencode-stats/src/opencode-sync.ts; synthetic content, no private transcripts.
export const rawPi = {
	type: "message", id: "a1", parentId: "u1", timestamp: "2027-01-15T08:00:00.100Z",
	message: { role: "assistant", provider: "fixture", model: "model", api: "fixture",
		usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 5, totalTokens: 65,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.15, total: 0.75 } },
		stopReason: "toolUse", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "x" } }] },
};
export const rawOpenCode = {
	id: "a1", type: "assistant", model: { providerID: "fixture", id: "model" },
	time: { created: 1800000000100, streamed: 1800000000300, completed: 1800000001500 },
	cost: 0.75, tokens: { input: 10, output: 20, cache: { read: 30, write: 5 } }, finish: "tool-calls",
};
const provenance = { locator: { messageId: "a1" }, observedAt: 1800000002000, revision: null, adapterVersion: "fixture-1" };
const categories = { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null };
const noTiming = { startedAt: null, firstTokenAt: null, endedAt: null, durationMs: null, ttftMs: null };
export const noCost: RequestCost = {
	currency: "USD", recorded: { total: null, categories: { ...categories } },
	estimated: { total: null, categories: { ...categories } },
};
const model = { provider: "fixture", model: "model", api: null };
export const basis: PricingBasis = {
	model, currency: "USD", rates: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25, reasoning: null },
	tier: { kind: "context", minimum: 0, maximumExclusive: 200000, contextTokens: 45 },
	rateSource: "fixture catalog", retrievedAt: 1800000002000, temporalBasis: "current", effectiveAt: null,
	method: "Disjoint input/cache counters; reasoning included in output when present.",
};
export const piRequest: ModelRequest = {
	kind: "model-request", identity: { sourceId: "pi-home", sessionId: "session-1", recordId: rawPi.id },
	provenance: { ...provenance, locator: { file: "/sessions/example.jsonl", entryId: rawPi.id } }, origin: null,
	model: { ...model, api: "fixture" }, prompt: { sourceId: "pi-home", sessionId: "session-1", recordId: "u1" },
	output: [], usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 5, total: rawPi.message.usage.totalTokens, reasoning: null,
		inputIncludesCache: "no", outputIncludesReasoning: "unknown", semantics: "Pi counters; total includes input, output and both cache counters.", additional: {} },
	cost: { ...noCost, recorded: { total: { amount: 0.75, provenance }, categories: {
		input: { amount: 0.1, provenance }, output: { amount: 0.2, provenance },
		cacheRead: { amount: 0.3, provenance }, cacheWrite: { amount: 0.15, provenance }, reasoning: null,
	} } },
	outcome: { status: "succeeded", reason: "toolUse", error: null }, timing: noTiming, purpose: null,
};
export const openCodeRequest: ModelRequest = {
	...piRequest, identity: { sourceId: "opencode-local", sessionId: "session-1", recordId: "a1" },
	provenance, model, prompt: null,
	usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 5, reasoning: null, total: null,
		inputIncludesCache: "unknown", outputIncludesReasoning: "unknown",
		semantics: "OpenCode API counters; this payload does not establish overlap or supply total/reasoning.", additional: {} },
	cost: { ...noCost, recorded: { total: { amount: rawOpenCode.cost, provenance }, categories: { ...categories } } },
	outcome: { status: "succeeded", reason: rawOpenCode.finish, error: null },
	timing: {
		startedAt: { value: rawOpenCode.time.created, quality: "measured", method: "time.created" },
		firstTokenAt: { value: rawOpenCode.time.streamed, quality: "measured", method: "time.streamed" },
		endedAt: { value: rawOpenCode.time.completed, quality: "measured", method: "time.completed" },
		durationMs: { value: 1400, quality: "measured", method: "completed minus created" },
		ttftMs: { value: 200, quality: "measured", method: "streamed minus created" },
	},
};
export const zeroCostRequest: ModelRequest = {
	...openCodeRequest, cost: { ...openCodeRequest.cost,
		recorded: { total: { amount: 0, provenance }, categories: { ...categories } },
		estimated: { total: { amount: 0.00005925, basis }, categories: {
			input: { amount: 0.00001, basis }, output: { amount: 0.00004, basis },
			cacheRead: { amount: 0.000003, basis }, cacheWrite: { amount: 0.00000625, basis }, reasoning: null,
		} },
	},
	// This example has sufficient, known-disjoint accounting for an estimate.
	usage: { ...openCodeRequest.usage, inputIncludesCache: "no", outputIncludesReasoning: "yes", semantics: "Fixture disjoint cache counters, reasoning included in output." },
};
export const lifecycle = [
	{ status: "running", reason: null, error: null },
	{ status: "succeeded", reason: "stop", error: null },
	{ status: "failed", reason: "error", error: { message: "Provider unavailable", code: "503", details: null } },
	{ status: "interrupted", reason: "aborted", error: null },
	{ status: "incomplete", reason: null, error: null },
] as const;
export const lifecycleFixtures: ModelRequest[] = lifecycle.map(outcome => ({
	...piRequest, outcome, cost: noCost, timing: noTiming,
}));
export const session: Session = {
	kind: "session", identity: { sourceId: "pi-home", sessionId: "session-1" }, title: null,
	project: { id: null, name: null, directory: "/work/app" }, createdAt: null, updatedAt: null,
	relationships: [], provenance,
};
export const fork: Session = { ...session, identity: { ...session.identity, sessionId: "fork-1" },
	relationships: [{ kind: "fork", session: session.identity, forkPoint: piRequest.identity }] };
export const inheritedRequest: ModelRequest = { ...piRequest,
	identity: { ...fork.identity, recordId: "copied-a1" }, origin: piRequest.identity };
export const subagent: Session = { ...session, identity: { ...session.identity, sessionId: "child-1" },
	relationships: [{ kind: "subagent", session: session.identity, spawnedBy: piRequest.identity }] };
export const user: UserMessage = { kind: "user-message", identity: { ...session.identity, recordId: "u1" },
	provenance, origin: null, content: [{ type: "text", text: "Read the file" }], at: null };
export const tool: ToolExecution = { kind: "tool-execution", identity: { ...session.identity, recordId: "tool:call_1" },
	provenance, origin: null, request: piRequest.identity, callId: "call_1", name: "read",
	arguments: { value: { path: "x" } }, result: null, outcome: lifecycle[0], timing: noTiming };
export const records: SessionRecord[] = [user, piRequest, tool, {
	kind: "trace-event", identity: { ...session.identity, recordId: "event-1" }, provenance, origin: null,
	eventType: "tool-start", at: null, subject: tool.identity, data: null,
}];
