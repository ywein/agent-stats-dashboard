import { session, zeroCostRequest, noCost } from "./core/fixtures.ts";

/** Deliberately no Pi/OpenCode adapter dependency. All three sources overlap IDs. */
export function multiSourceFixture() {
	const reads = new Map(), failures = new Set();
	const sources = ["recorded / local", "estimated", "minimal"].map((sourceId, index) => {
		const capabilities = Object.fromEntries(["requestDetails", "toolResults", "traceEvents", "ttft", "recordedCosts", "pricingEstimates"].map(key => [key, index !== 2]));
		const identity = { sourceId, sessionId: "same" };
		const s = { ...structuredClone(session), identity, title: sourceId };
		const r = { ...structuredClone(zeroCostRequest), identity: { ...identity, recordId: "same" } };
		r.prompt = null;
		r.timing.startedAt.value = Date.now() - 1000;
		if (index === 1) r.cost.recorded.total = null;
		if (index === 2) {
			r.cost = structuredClone(noCost);
			r.output = null;
			r.timing = { ...r.timing, firstTokenAt: null, endedAt: null, durationMs: null, ttftMs: null };
			r.usage.cacheRead = null; r.usage.cacheWrite = null; r.usage.reasoning = null;
		}
		return { source: { sourceId, clientType: index === 2 ? "minimal" : "fixture", label: sourceId, capabilities }, config: {}, adapter: {
			descriptor: { id: "fixture", name: "Fixture", version: "1", contractVersion: 1 },
			async connect() { return { capabilities,
				async listSessions() { return { sessions: [s], nextCursor: null }; },
				async readSession() {
					reads.set(sourceId, (reads.get(sourceId) ?? 0) + 1);
					if (failures.has(sourceId)) throw new Error("Fixture unavailable");
					return { session: s, records: [r], mode: "full", deleted: [], checkpoint: null };
				}, async close() {},
			}; },
		} };
	});
	return { sources, reads, failures };
}
