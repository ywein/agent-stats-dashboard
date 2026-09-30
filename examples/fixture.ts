import type { ClientAdapter } from "../src/adapter-contract/index.ts";
import type { ModelRequest, Session, SourceCapabilities } from "../src/core/model/index.ts";

export const capabilities: SourceCapabilities = { requestDetails: false, toolResults: false,
	traceEvents: false, ttft: false, recordedCosts: false, pricingEstimates: false };

/** A tiny mutable fixture backend: no client SDK, filesystem or dashboard imports. */
export function createFixtureAdapter() {
	let revision = 0;
	let removed = false;
	let failures = 0;
	const adapter: ClientAdapter = {
		descriptor: { id: "fixture", name: "Fixture", version: "1.0.0", contractVersion: 1 },
		async connect(_config, context) {
			context.signal.throwIfAborted();
			let closed = false;
			function check(signal: AbortSignal) {
				context.signal.throwIfAborted(); signal.throwIfAborted();
				if (closed) throw new Error("Fixture connection closed");
				if (failures > 0) { failures--; throw new Error("Temporary fixture failure"); }
			}
			function session(id: string): Session {
				return { kind: "session", identity: { sourceId: context.source.sourceId, sessionId: id },
					title: `Fixture ${id}`, project: null, createdAt: null, updatedAt: null, relationships: [],
					provenance: { locator: id, observedAt: 0, revision: String(revision), adapterVersion: "1.0.0" } };
			}
			return {
				capabilities,
				async listSessions(input) {
					check(input.signal);
					if (input.cursor !== null && input.cursor !== "second") throw new Error("Invalid fixture cursor");
					return { sessions: [session(input.cursor === null ? "one" : "two")], nextCursor: input.cursor === null ? "second" : null };
				},
				async readSession(input) {
					check(input.signal);
					if (input.session.sourceId !== context.source.sourceId || !["one", "two"].includes(input.session.sessionId)) throw new Error("Unknown fixture session");
					const owner = session(input.session.sessionId);
					const identity = { ...owner.identity, recordId: "request" };
					const categories = { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null };
					const request: ModelRequest = { kind: "model-request", identity, provenance: owner.provenance, origin: null,
						model: { provider: null, model: null, api: null }, prompt: null, output: null,
						usage: { input: 10, output: revision ? 5 : null, cacheRead: null, cacheWrite: null, reasoning: null,
							total: null, inputIncludesCache: "unknown", outputIncludesReasoning: "unknown", semantics: "Fixture counters", additional: {} },
						cost: { currency: "USD", recorded: { total: null, categories }, estimated: { total: null, categories } },
						outcome: { status: revision ? "succeeded" : "running", reason: null, error: null },
						timing: { startedAt: null, firstTokenAt: null, endedAt: null, durationMs: null, ttftMs: null }, purpose: null };
					return { session: owner, mode: input.checkpoint === null ? "full" : "partial", checkpoint: revision,
						records: removed ? [] : [request], deleted: removed ? [{ identity, provenance: owner.provenance }] : [] };
				},
				async close() { closed = true; },
			};
		},
	};
	return { adapter, advance: () => { revision++; }, remove: () => { removed = true; revision++; },
		failNext: () => { failures++; } };
}

export default createFixtureAdapter().adapter;
