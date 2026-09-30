import { Service } from "@opencode/client/service";
import type { ClientAdapter, SessionSnapshot } from "../adapter-contract/index.ts";
import type { Json, ModelRequest, RecordRef, Session, SessionRecord, SourceCapabilities } from "../core/model/index.ts";
import { estimateCost, type RateCard } from "../core/pricing/index.ts";
import { content, cost, measured, number, object, outcome, text, timing, usage } from "./common.ts";

export const capabilities: SourceCapabilities = { requestDetails: true, toolResults: true, traceEvents: true, ttft: true, recordedCosts: true, pricingEstimates: true };
export interface OpenCodeConfig { url?: string; headers?: Record<string, string> }

export function convertSession(raw: unknown, sourceId: string): Session {
	const s = object(raw), time = object(s.time), fork = object(s.fork);
	if (!text(s.id)) throw new Error("OpenCode session has no ID");
	return { kind: "session", identity: { sourceId, sessionId: s.id }, title: text(s.title),
		agentRole: text(s.parentID) ? "subagent" : "main",
		project: { id: text(s.projectID), name: null, directory: text(object(s.location).directory) },
		createdAt: number(time.created), updatedAt: number(time.updated), relationships: [
			...(text(s.parentID) ? [{ kind: "subagent" as const, session: { sourceId, sessionId: s.parentID }, spawnedBy: null }] : []),
			...(text(fork.sessionID) ? [{ kind: "fork" as const, session: { sourceId, sessionId: fork.sessionID },
				forkPoint: text(object(fork.boundary).messageID) ? { sourceId, sessionId: fork.sessionID, recordId: object(fork.boundary).messageID } : null }] : []),
		], provenance: { locator: { sessionId: s.id }, observedAt: Date.now(), revision: time.updated == null ? null : String(time.updated), adapterVersion: "1" } };
}

export function convertMessages(session: Session, messages: unknown[], cards: readonly RateCard[] = []): SessionSnapshot {
	const records: SessionRecord[] = [];
	let prompt: RecordRef | null = null;
	for (const raw of messages) {
		const m = object(raw), t = object(m.time);
		if (!text(m.id)) throw new Error("OpenCode message has no ID");
		const identity = { ...session.identity, recordId: m.id };
		const provenance = { ...session.provenance, locator: { sessionId: session.identity.sessionId, messageId: m.id } };
		const base = { identity, provenance, origin: null };
		if (m.type === "user") {
			records.push({ ...base, kind: "user-message", at: number(t.created), content: content(m.text) });
			prompt = identity;
		} else if (m.type === "assistant" || (m.type === "compaction" && (m.tokens != null || m.cost != null))) {
			const tokens = object(m.tokens), cache = object(tokens.cache), model = object(m.model);
			// @opencode/core 2.0.19 src/session/usage.ts maps nonCachedInputTokens,
			// visibleOutputTokens and reasoningTokens to separate API counters.
			const u = usage({ ...tokens, cacheRead: cache.read, cacheWrite: cache.write }, "OpenCode V2: disjoint uncached input, visible output, reasoning and cache counters");
			u.outputIncludesReasoning = "no";
			const request: ModelRequest = { ...base, kind: "model-request", model: { provider: text(model.providerID), model: text(model.id), api: "opencode" },
				prompt, output: content(m.content ?? m.summary), usage: u, cost: cost({ total: m.cost }, provenance),
				outcome: outcome(m.finish ?? m.status, m.error, number(t.completed) !== null || m.status === "completed", true),
				timing: timing(number(t.created), number(t.completed), number(t.streamed)), purpose: m.type === "compaction" ? "compaction" : null };
			request.cost = estimateCost(request, cards);
			records.push(request);
			for (const rawPart of Array.isArray(m.content) ? m.content : []) {
				const part = object(rawPart), state = object(part.state), time = object(part.time);
				if (part.type !== "tool" || !text(part.id)) continue;
				records.push({ ...base, identity: { ...session.identity, recordId: JSON.stringify([m.id, "tool", part.id]) },
					kind: "tool-execution", request: identity, callId: part.id, name: text(part.name),
					arguments: "input" in state ? { value: state.input as Json } : null, result: content(state.content),
					outcome: outcome(state.status, state.error, state.status === "completed", state.status === "running" || state.status === "streaming"),
					timing: timing(number(time.ran) ?? number(time.created), number(time.completed), null) });
			}
		} else {
			records.push({ ...base, kind: "trace-event", eventType: text(m.type) ?? "unknown", at: measured(number(t.created), "source timestamp"), subject: null, data: raw as Json });
		}
	}
	const idle = messages.map(object).filter(m => m.type === "idle" && number(object(m.time).created) !== null);
	for (const r of records) {
		if ((r.kind !== "model-request" && r.kind !== "tool-execution") || !["running", "pending"].includes(r.outcome.status)) continue;
		const marker = idle.find(m => object(m.time).created >= (r.timing.startedAt?.value ?? Infinity));
		if (marker) r.outcome = { ...r.outcome, status: marker.outcome === "interrupted" ? "interrupted" : "incomplete", reason: `session idle: ${marker.outcome ?? "unknown"}` };
	}
	return { session, records, mode: "full", deleted: [], checkpoint: session.provenance.revision };
}

export function modelCards(models: unknown[], retrievedAt: number): RateCard[] {
	return models.flatMap(raw => {
		const m = object(raw), costs = (Array.isArray(m.cost) ? m.cost : []).map(object);
		if (costs.some(c => c.tier && (c.tier.type !== "context" || number(c.tier.size) === null || !Number.isSafeInteger(c.tier.size)))) return [];
		const tiered = costs.some(c => c.tier);
		const sorted = costs.sort((a, b) => (a.tier?.size ?? 0) - (b.tier?.size ?? 0));
		return sorted.map((c, index) => ({ model: { provider: text(m.providerID), model: text(m.id), api: "opencode" },
			rates: { input: number(c.input), output: number(c.output), cacheRead: number(object(c.cache).read), cacheWrite: number(object(c.cache).write), reasoning: number(c.output) },
			// Native pricing uses context > size. Convert integer-token thresholds
			// to the normalized model's inclusive-minimum/exclusive-maximum bounds.
			context: tiered ? { minimum: c.tier ? c.tier.size + 1 : 0, maximumExclusive: sorted[index + 1]?.tier ? sorted[index + 1]!.tier.size + 1 : null } : null,
			rateSource: "OpenCode /api/model", retrievedAt }));
	});
}

export const openCodeAdapter: ClientAdapter = {
	descriptor: { id: "opencode", name: "OpenCode", version: "1", contractVersion: 1 },
	async connect(config, context) {
		const options = object(config) as OpenCodeConfig;
		const endpoint = options.url ? { url: options.url, headers: options.headers ?? {} } : await Service.ensure().then(e => ({ url: e.url, headers: Service.headers(e) }));
		context.signal.throwIfAborted();
		async function get(route: string, signal: AbortSignal): Promise<any> {
			const response = await fetch(new URL(route, endpoint.url), { headers: endpoint.headers ?? {}, signal: AbortSignal.any([context.signal, signal, AbortSignal.timeout(30_000)]) });
			if (!response.ok) throw new Error(`OpenCode API ${response.status} at ${route.split("?")[0]}`);
			return response.json();
		}
		let cards: RateCard[] = [];
		const sessions = new Map<string, Session>();
		async function readMessages(sessionId: string, signal: AbortSignal): Promise<unknown[]> {
			const messages: unknown[] = [], seen = new Set<string>();
			let cursor: string | null = null;
			do {
				const params = new URLSearchParams({ limit: "100", ...(cursor === null ? { order: "asc" } : { cursor }) });
				const page = await get(`/api/session/${encodeURIComponent(sessionId)}/message?${params}`, signal);
				if (!Array.isArray(page.data)) throw new Error("Invalid OpenCode message page");
				messages.push(...page.data);
				cursor = text(page.cursor?.next);
				if (cursor && seen.has(cursor)) throw new Error("OpenCode repeated message cursor");
				if (cursor) seen.add(cursor);
			} while (cursor !== null);
			return messages;
		}
		return { capabilities,
			async listSessions({ cursor, signal }) {
				if (cursor === null) {
					try { cards = modelCards((await get("/api/model", signal)).data, Date.now()); }
					catch (error) { signal.throwIfAborted(); context.log("warn", "Pricing unavailable; importing recorded costs", String(error)); cards = []; }
				}
				const params = new URLSearchParams({ limit: "100", ...(cursor === null ? { order: "asc" } : { cursor }) });
				const page = await get(`/api/session?${params}`, signal);
				if (!Array.isArray(page.data)) throw new Error("Invalid OpenCode session page");
				const result = page.data.map((raw: unknown) => convertSession(raw, context.source.sourceId));
				for (const s of result) sessions.set(s.identity.sessionId, s);
				return { sessions: result, nextCursor: text(page.cursor?.next) };
			},
			async readSession({ session: ref, checkpoint, signal }) {
				const session = sessions.get(ref.sessionId) ?? convertSession(await get(`/api/session/${encodeURIComponent(ref.sessionId)}`, signal), context.source.sourceId);
				const previous = object(checkpoint);
				if (session.provenance.revision !== null && previous.revision === session.provenance.revision && previous.active === false)
					return { session, records: [], mode: "partial", deleted: [], checkpoint };
				const messages = await readMessages(ref.sessionId, signal);
				const snapshot = convertMessages(session, messages, cards);
				const fork = session.relationships.find(r => r.kind === "fork");
				if (fork) {
					const parent = convertMessages({ ...session, identity: fork.session }, await readMessages(fork.session.sessionId, signal));
					const originals = new Set(parent.records.map(r => r.identity.recordId));
					snapshot.records = snapshot.records.map(record => {
						if (originals.has(record.identity.recordId)) return { ...record, origin: { ...fork.session, recordId: record.identity.recordId } };
						// Explicit fork context that predates this session but has remapped IDs
						// cannot be assigned a canonical original. Retain it as context, not spend.
						const at = record.kind === "user-message" ? record.at : record.kind === "trace-event" ? record.at?.value : record.timing.startedAt?.value;
						if (session.createdAt !== null && at != null && at < session.createdAt) return {
							kind: "trace-event" as const, identity: { ...record.identity, recordId: JSON.stringify(["fork-context", record.identity.recordId]) },
							origin: null, provenance: record.provenance, eventType: "fork-context", at: measured(at, "source timestamp"), subject: null, data: record as unknown as Json,
						};
						return record;
					});
				}
				snapshot.checkpoint = { revision: session.provenance.revision, active: snapshot.records.some(r => (r.kind === "model-request" || r.kind === "tool-execution") && (r.outcome.status === "running" || r.outcome.status === "pending")) };
				return snapshot;
			},
			async close() { sessions.clear(); },
		};
	},
};
