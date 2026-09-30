import { createHash } from "node:crypto";
import { group, sum, timestamp, tokens } from "../../core/aggregation/index.ts";
import { preferredTotal, sessionKey, type ModelRequest, type Session, type SessionRecord } from "../../core/model/index.ts";
import type { SessionSummary, SessionTrace, TraceMarker, TraceSpan, TraceTrack } from "../shared-types.ts";
import type { DashboardQueries } from "./queries.ts";

export function sessionTree(q: DashboardQueries, root: Session): Session[] {
	const result: Session[] = [], visited = new Set<string>();
	const walk = (s: Session) => {
		const key = sessionKey(s.identity);
		if (visited.has(key)) return;
		visited.add(key); result.push(s);
		for (const child of q.sessions.values()) if (child.relationships.some(r => (r.kind === "subagent" || r.kind === "parent") && sessionKey(r.session) === key)) walk(child);
	};
	walk(root); return result;
}
function summary(q: DashboardQueries, s: Session): SessionSummary {
	const tree = sessionTree(q, s), keys = new Set(tree.map(s => sessionKey(s.identity)));
	const records = q.records.map(r => r.record).filter(r => keys.has(sessionKey(r.identity)) && r.origin === null);
	const requests = records.filter((r): r is ModelRequest => r.kind === "model-request");
	const times = records.flatMap(r => {
		const start = timestamp(r), end = r.kind === "model-request" || r.kind === "tool-execution" ? r.timing.endedAt?.value ?? null : null;
		return [start, end].filter((t): t is number => t !== null);
	});
	return { file: sessionKey(s.identity), folder: s.project?.directory ?? "unknown", title: s.title,
		startedAt: times.length ? times.reduce((a,b) => Math.min(a,b)) : s.createdAt ?? 0, endedAt: times.length ? times.reduce((a,b) => Math.max(a,b)) : s.updatedAt ?? s.createdAt ?? 0,
		requests: requests.length, toolCalls: records.filter(r => r.kind === "tool-execution").length, subagents: tree.length - 1,
		totalTokens: sum(requests, tokens), costTotal: sum(requests, r => preferredTotal(r.cost)?.amount ?? null), unpricedRequests: requests.filter(r => preferredTotal(r.cost) === null).length,
		models: [...new Set(requests.map(r => r.model.model).filter((m): m is string => m !== null))] };
}
export function listSessions(q: DashboardQueries, limit: number, search: string): SessionSummary[] {
	return [...q.sessions.values()].filter(s => !s.relationships.some(r => (r.kind === "subagent" || r.kind === "parent") && q.sessions.has(sessionKey(r.session))))
		.map(s => summary(q, s)).filter(s => `${s.title ?? ""} ${s.folder} ${s.file}`.toLowerCase().includes(search.toLowerCase()))
		.sort((a,b) => b.endedAt - a.endedAt).slice(0, limit);
}
const plain = (record: SessionRecord) => record.kind === "user-message" ? record.content?.map(b => b.type === "text" ? b.text : "").join("") ?? "" : "";

export function buildTrace(q: DashboardQueries, key: string): SessionTrace | null {
	const root = q.sessions.get(key);
	if (!root) return null;
	const tree = sessionTree(q, root), totals = summary(q, root);
	const tracks: TraceTrack[] = tree.map((s, index) => {
		const records = q.forSession(sessionKey(s.identity));
		const spans: TraceSpan[] = [], markers: TraceMarker[] = [];
		for (const r of records) {
			const start = timestamp(r) ?? (r.kind === "tool-execution" || r.kind === "model-request" ? r.timing.endedAt?.value ?? null : null);
			if (start === null) continue;
			if (r.kind === "trace-event") {
				const kinds: Record<string, TraceMarker["kind"]> = { compaction: "compaction", model_change: "model_change", "model-switched": "model_change", mode_change: "mode_change", reset_boundary: "reset", session_exit: "session_exit", idle: "session_exit" };
				const kind = kinds[r.eventType]; if (kind) markers.push({ time: start, kind, label: r.eventType });
				continue;
			}
			const end = r.kind === "user-message" ? start : r.timing.endedAt?.value ?? start;
			const span: TraceSpan = { id: JSON.stringify([sessionKey(s.identity), r.identity.recordId]), kind: r.kind === "user-message" ? "turn" : r.kind === "model-request" ? "model" : "tool",
				start, end: Math.max(start, end), label: (r.kind === "user-message" ? plain(r) : r.kind === "model-request" ? r.model.model ?? "unknown" : r.name ?? "unknown").slice(0, 80), entryId: r.identity.recordId };
			if (r.kind === "model-request") {
				if (r.model.model) span.model = r.model.model;
				const count = tokens(r), total = preferredTotal(r.cost);
				if (count !== null) span.tokens = count;
				if (total) span.cost = total.amount;
				if (r.timing.ttftMs) span.ttft = r.timing.ttftMs.value;
			} else if (r.kind === "tool-execution") {
				if (r.callId) span.toolCallId = r.callId;
				if (r.arguments) span.detail = JSON.stringify(r.arguments.value).slice(0, 160);
			}
			if (r.kind !== "user-message") {
				span.durationKnown = r.timing.durationMs !== null;
				span.isError = r.outcome.status === "failed";
				span.unterminated = r.outcome.status === "running" || r.outcome.status === "pending" || r.outcome.status === "incomplete";
			}
			spans.push(span);
		}
		const parent = s.relationships.find(r => r.kind === "parent" || r.kind === "subagent");
		return { id: index === 0 ? "main" : sessionKey(s.identity), parentId: index === 0 ? null : parent && sessionKey(parent.session) === key ? "main" : parent ? sessionKey(parent.session) : "main",
			label: index === 0 ? "Main" : s.title ?? s.identity.sessionId, agent: null,
			model: records.find((r): r is ModelRequest => r.kind === "model-request")?.model.model ?? null,
			file: sessionKey(s.identity), spans: spans.sort((a,b) => a.start - b.start), markers: markers.sort((a,b) => a.time - b.time) };
	});
	const allSpans = tracks.flatMap(t => t.spans), main = tracks[0]!;
	const intervals = allSpans.filter(s => s.end > s.start).sort((a,b) => a.start - b.start);
	let covered = 0, high = totals.startedAt;
	for (const s of intervals) { covered += Math.max(0, s.end - Math.max(high, s.start)); high = Math.max(high, s.end); }
	const fingerprint = { sessions: tree, records: tree.flatMap(s => q.forSession(sessionKey(s.identity))) };
	return { file: key, title: root.title, cwd: root.project?.directory ?? null, startedAt: totals.startedAt, endedAt: totals.endedAt,
		mtimeMs: Math.max(...tree.map(s => s.updatedAt ?? 0)), etag: createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex"), tracks,
		summary: { wallMs: Math.max(0, totals.endedAt - totals.startedAt), modelMs: sum(main.spans.filter(s => s.kind === "model"), s => s.end - s.start),
			toolMs: sum(main.spans.filter(s => s.kind === "tool"), s => s.end - s.start), idleMs: Math.max(0, totals.endedAt - totals.startedAt - covered),
			turns: allSpans.filter(s => s.kind === "turn").length, requests: totals.requests, toolCalls: totals.toolCalls, subagents: totals.subagents, totalTokens: totals.totalTokens, costTotal: totals.costTotal, unpricedRequests: totals.unpricedRequests,
			toolStats: group(allSpans.filter(s => s.kind === "tool"), s => s.label).map(g => ({ tool: g[0]!.label, calls: g.length, errors: g.filter(s => s.isError).length, totalMs: sum(g, s => s.end - s.start), maxMs: Math.max(...g.map(s => s.end - s.start)) })).sort((a,b) => b.totalMs - a.totalMs) } };
}
