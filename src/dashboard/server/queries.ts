import { average, group, spend, sum, timestamp, tokens } from "../../core/aggregation/index.ts";
import { preferredTotal, recordKey, sessionKey, type ModelRequest, type Session, type SessionRecord, type ToolExecution } from "../../core/model/index.ts";
import type { IngestionStore } from "../../core/storage/index.ts";
import type { AggregatedStats, DashboardStats, ProviderDashboardStats, ToolDashboardStats } from "../shared-types.ts";
import { metricCoverage } from "./coverage.ts";

const HOUR = 3_600_000, DAY = 24 * HOUR;
export function rangeWindow(range: string | null) {
	const spans: Record<string, [number | null, number]> = { "1h": [HOUR, HOUR / 12], "24h": [DAY, HOUR], "7d": [7 * DAY, DAY], "30d": [30 * DAY, DAY], "90d": [90 * DAY, DAY], all: [null, DAY] };
	const [span, bucket] = spans[range ?? "24h"] ?? spans["24h"]!;
	return { cutoff: span === null ? null : Date.now() - span, bucket };
}
const bucketOf = (time: number | null, width: number) => Math.floor((time ?? 0) / width) * width;
const modelKey = (r: ModelRequest) => JSON.stringify([r.model.provider, r.model.model]);
const amount = (r: ModelRequest) => preferredTotal(r.cost)?.amount ?? null;
const categorySum = (rows: ModelRequest[], category: "input" | "output" | "cacheRead" | "cacheWrite") =>
	rows.every(r => r.cost.recorded.categories[category] !== null) ? sum(rows, r => r.cost.recorded.categories[category]!.amount) : null;

/** Read-side cache rebuilt only after committed ingestion changes. No source I/O in HTTP handlers. */
export class DashboardQueries {
	readonly sessions: Map<string, Session>;
	readonly records: { id: number; record: SessionRecord }[];
	readonly requests: ModelRequest[];
	readonly tools: ToolExecution[];
	readonly byRecord: Map<string, SessionRecord>;
	private readonly handles: Map<string, number>;
	private readonly sessionRecords: Map<string, SessionRecord[]>;
	private readonly sources: Map<string, import("../../core/model/index.ts").Source>;
	constructor(store: IngestionStore, sourceIds?: ReadonlySet<string>) {
		this.sources = new Map(store.listSources().map(source => [source.sourceId, source]));
		this.sessions = new Map(store.listSessions().filter(({ session }) => !sourceIds || sourceIds.has(session.identity.sourceId)).map(({ session }) => [sessionKey(session.identity), session]));
		this.records = store.listRecords().filter(({ record }) => !sourceIds || sourceIds.has(record.identity.sourceId));
		this.byRecord = new Map(this.records.map(({ record }) => [recordKey(record.identity), record]));
		this.handles = new Map(this.records.map(({ id, record }) => [recordKey(record.identity), id]));
		this.sessionRecords = new Map(group(this.records.map(r => r.record), r => sessionKey(r.identity)).map(g => [sessionKey(g[0]!.identity), g]));
		this.requests = this.records.map(r => r.record).filter((r): r is ModelRequest => r.kind === "model-request" && r.origin === null);
		this.tools = this.records.map(r => r.record).filter((r): r is ToolExecution => r.kind === "tool-execution" && r.origin === null);
	}
	forSession(key: string): SessionRecord[] { return this.sessionRecords.get(key) ?? []; }
	folder(r: SessionRecord) { return this.sessions.get(sessionKey(r.identity))?.project?.directory ?? "unknown"; }
	agent(r: SessionRecord): "main" | "subagent" | "advisor" {
		const role = this.sessions.get(sessionKey(r.identity))?.agentRole;
		if (role) return role;
		return this.sessions.get(sessionKey(r.identity))?.relationships.some(l => l.kind === "subagent" || l.kind === "parent") ? "subagent" : "main";
	}
	select(range: string | null): ModelRequest[] {
		const { cutoff } = rangeWindow(range);
		return this.requests.filter(r => cutoff === null || (timestamp(r) !== null && timestamp(r)! >= cutoff));
	}
	aggregate(rows: ModelRequest[]): AggregatedStats {
		const input = sum(rows, r => r.usage.input), output = sum(rows, r => r.usage.output), read = sum(rows, r => r.usage.cacheRead), write = sum(rows, r => r.usage.cacheWrite);
		const times = rows.map(timestamp).filter((t): t is number => t !== null);
		const failed = rows.filter(r => r.outcome.status === "failed").length;
		const savings = rows.flatMap(r => {
			const c = r.cost.recorded.categories, rate = r.cost.estimated.categories.input?.basis.rates.input;
			if (rate == null || r.usage.input === null || r.usage.cacheRead === null || r.usage.cacheWrite === null || !c.input || !c.cacheRead || !c.cacheWrite) return [];
			return [{ actual: c.input.amount + c.cacheRead.amount + c.cacheWrite.amount, uncached: (r.usage.input + r.usage.cacheRead + r.usage.cacheWrite) * rate / 1e6 }];
		});
		const uncached = sum(savings, s => s.uncached);
		const cachedRows = rows.filter(r => r.usage.input !== null && r.usage.cacheRead !== null && r.usage.cacheWrite !== null);
		const cacheInput = sum(cachedRows, r => r.usage.input! + r.usage.cacheRead! + r.usage.cacheWrite!);
		return { coverage: metricCoverage(rows), totalRequests: rows.length, successfulRequests: rows.filter(r => r.outcome.status === "succeeded").length,
			totalReasoningTokens: sum(rows, r => r.usage.outputIncludesReasoning === "no" ? r.usage.reasoning : null),
			failedRequests: failed, errorRate: rows.length ? failed / rows.length : 0,
			totalInputTokens: input, totalOutputTokens: output, totalCacheReadTokens: read, totalCacheWriteTokens: write,
			cacheRate: cachedRows.length ? (cacheInput ? sum(cachedRows, r => r.usage.cacheRead) / cacheInput : 0) : null, cacheSavings: uncached > 0 ? 1 - sum(savings, s => s.actual) / uncached : null,
			totalCost: sum(rows, amount), unpricedRequests: rows.filter(r => amount(r) === null).length,
			totalPremiumRequests: sum(rows, r => r.usage.additional.premiumRequests?.value ?? null),
			avgDuration: average(rows, r => r.timing.durationMs?.value ?? null), avgTtft: average(rows, r => r.timing.ttftMs?.value ?? null),
			avgTokensPerSecond: average(rows, r => r.timing.durationMs && r.timing.durationMs.value > 0 && r.usage.output !== null ? r.usage.output * 1000 / r.timing.durationMs.value : null),
			firstTimestamp: times.length ? times.reduce((a,b) => Math.min(a,b)) : 0, lastTimestamp: times.length ? times.reduce((a,b) => Math.max(a,b)) : 0 };
	}
	dashboard(range: string | null): DashboardStats & { spend: ReturnType<typeof spend> } {
		const rows = this.select(range), { bucket } = rangeWindow(range);
		const timeGroups = group(rows.filter(r => timestamp(r) !== null), r => String(bucketOf(timestamp(r), bucket)));
		const modelGroups = group(rows, modelKey);
		const seriesGroups = group(rows.filter(r => timestamp(r) !== null), r => JSON.stringify([bucketOf(timestamp(r), bucket), modelKey(r)]));
		return { overall: this.aggregate(rows), spend: spend(rows),
			byModel: modelGroups.map(g => ({ model: g[0]!.model.model ?? "unknown", provider: g[0]!.model.provider ?? "unknown", ...this.aggregate(g) })).sort((a,b) => b.totalRequests - a.totalRequests),
			byFolder: group(rows, r => this.folder(r)).map(g => ({ folder: this.folder(g[0]!), ...this.aggregate(g) })).sort((a,b) => b.totalRequests - a.totalRequests).slice(0, 2000),
			byAgentType: group(rows, r => this.agent(r)).map(g => { const a = this.aggregate(g); return { agentType: this.agent(g[0]!), totalRequests: a.totalRequests, totalInputTokens: a.totalInputTokens,
				totalOutputTokens: a.totalOutputTokens, totalReasoningTokens: a.totalReasoningTokens, totalCacheReadTokens: a.totalCacheReadTokens, totalCacheWriteTokens: a.totalCacheWriteTokens, totalCost: a.totalCost }; }),
			timeSeries: timeGroups.map(g => ({ timestamp: bucketOf(timestamp(g[0]!), bucket), requests: g.length, errors: g.filter(r => r.outcome.status === "failed").length,
				tokens: sum(g, tokens), cost: sum(g, amount) })).sort((a,b) => a.timestamp - b.timestamp),
			modelSeries: seriesGroups.map(g => ({ timestamp: bucketOf(timestamp(g[0]!), bucket), model: g[0]!.model.model ?? "unknown", provider: g[0]!.model.provider ?? "unknown", requests: g.length })).sort((a,b) => a.timestamp - b.timestamp),
			modelPerformanceSeries: seriesGroups.map(g => { const a = this.aggregate(g); return { timestamp: bucketOf(timestamp(g[0]!), bucket), model: g[0]!.model.model ?? "unknown", provider: g[0]!.model.provider ?? "unknown", requests: g.length, avgTtft: a.avgTtft, avgTokensPerSecond: a.avgTokensPerSecond }; }).sort((a,b) => a.timestamp - b.timestamp),
			costSeries: group(rows.filter(r => timestamp(r) !== null), r => JSON.stringify([bucketOf(timestamp(r), DAY), modelKey(r)])).map(g => ({ timestamp: bucketOf(timestamp(g[0]!), DAY), model: g[0]!.model.model ?? "unknown", provider: g[0]!.model.provider ?? "unknown",
				recordedCost: g.some(r => r.cost.recorded.total !== null) ? spend(g).recorded : null,
				estimatedCost: g.some(r => r.cost.recorded.total === null && r.cost.estimated.total !== null) ? spend(g).estimated : null,
				cost: sum(g, amount), requests: g.length, unpricedRequests: g.filter(r => amount(r) === null).length,
				costInput: categorySum(g, "input"), costOutput: categorySum(g, "output"), costCacheRead: categorySum(g, "cacheRead"), costCacheWrite: categorySum(g, "cacheWrite") })).sort((a,b) => a.timestamp - b.timestamp),
		};
	}
	request(r: ModelRequest, id?: number) {
		const recorded = r.cost.recorded.categories;
		return { id: id ?? this.handles.get(recordKey(r.identity)), source: this.sources.get(r.identity.sourceId) ?? null,
			sessionFile: sessionKey(r.identity), entryId: r.identity.recordId, folder: this.folder(r), model: r.model.model ?? "unknown", provider: r.model.provider ?? "unknown", api: r.model.api ?? "unknown",
			timestamp: timestamp(r), duration: r.timing.durationMs?.value ?? null, ttft: r.timing.ttftMs?.value ?? null,
			stopReason: r.outcome.status === "failed" ? "error" : r.outcome.reason ?? r.outcome.status, errorMessage: r.outcome.error?.message ?? null,
			usage: { input: r.usage.input, output: r.usage.output, reasoning: r.usage.reasoning, cacheRead: r.usage.cacheRead, cacheWrite: r.usage.cacheWrite, totalTokens: tokens(r), premiumRequests: r.usage.additional.premiumRequests?.value ?? 0,
				cost: { input: recorded.input?.amount ?? null, output: recorded.output?.amount ?? null, cacheRead: recorded.cacheRead?.amount ?? null, cacheWrite: recorded.cacheWrite?.amount ?? null, total: amount(r) } },
			cost: r.cost, costUnpriced: amount(r) === null, agentType: this.agent(r), outcome: r.outcome, timing: r.timing };
	}
	recent(limit: number, errors = false, range: string | null = "all") {
		return this.select(range).filter(r => !errors || r.outcome.status === "failed").sort((a,b) => (timestamp(b) ?? 0) - (timestamp(a) ?? 0)).slice(0, limit).map(r => this.request(r));
	}
	details(id: number) {
		const r = this.records.find(row => row.id === id)?.record;
		if (!r || r.kind !== "model-request") return null;
		const prompt = r.prompt ? this.byRecord.get(recordKey(r.prompt)) : null;
		return { ...this.request(r, id), messages: prompt ? [prompt] : [], output: r.output, record: r,
			tools: this.tools.filter(t => t.request && recordKey(t.request) === recordKey(r.identity)) };
	}
	toolDashboard(range: string | null): ToolDashboardStats {
		const { cutoff, bucket } = rangeWindow(range);
		const owner = (t: ToolExecution) => { const r = t.request ? this.byRecord.get(recordKey(t.request)) : null; return r?.kind === "model-request" ? r : null; };
		const at = (t: ToolExecution) => { const r = owner(t); return r ? timestamp(r) : timestamp(t); };
		const tools = this.tools.filter(t => cutoff === null || (at(t) !== null && at(t)! >= cutoff));
		const counts = new Map(group(this.tools.filter(t => t.request), t => recordKey(t.request!)).map(g => [recordKey(g[0]!.request!), g.length]));
		const share = (t: ToolExecution, field: (r: ModelRequest) => number | null) => { const r = owner(t); return r ? (field(r) ?? 0) / (counts.get(recordKey(r.identity)) ?? 1) : 0; };
		const row = (g: ToolExecution[]) => ({ tool: g[0]!.name ?? "unknown", calls: g.length, errors: g.filter(t => t.outcome.status === "failed").length,
			argsChars: sum(g, t => t.arguments ? JSON.stringify(t.arguments.value).length : null), resultChars: sum(g, t => t.result ? t.result.reduce((n, b) => n + (b.type === "text" ? b.text.length : 0), 0) : null),
			totalTokensShare: sum(g, t => share(t, tokens)), outputTokensShare: sum(g, t => share(t, r => r.usage.output)), costShare: sum(g, t => share(t, amount)),
			unpricedRequestsShare: sum(g, t => share(t, r => amount(r) === null ? 1 : 0)), lastUsed: g.reduce((high, t) => Math.max(high, at(t) ?? 0), 0) });
		return { byTool: group(tools, t => t.name ?? "unknown").map(row).sort((a,b) => b.calls - a.calls),
			byToolModel: group(tools, t => JSON.stringify([t.name, owner(t)?.model])).map(g => ({ ...row(g), model: owner(g[0]!)?.model.model ?? "unknown", provider: owner(g[0]!)?.model.provider ?? "unknown" })),
			series: group(tools.filter(t => at(t) !== null), t => JSON.stringify([bucketOf(at(t), bucket), t.name])).map(g => ({ timestamp: bucketOf(at(g[0]!), bucket), tool: g[0]!.name ?? "unknown", calls: g.length, errors: g.filter(t => t.outcome.status === "failed").length })).sort((a,b) => a.timestamp - b.timestamp) };
	}
	providers(range: string | null): ProviderDashboardStats {
		const rows = this.select(range), { bucket } = rangeWindow(range);
		return { providers: group(rows, r => r.model.provider ?? "unknown").map(g => { const a = this.aggregate(g); return { coverage: a.coverage, provider: g[0]!.model.provider ?? "unknown", totalRequests: a.totalRequests, failedRequests: a.failedRequests,
			models: new Set(g.map(r => r.model.model)).size, totalInputTokens: a.totalInputTokens, totalOutputTokens: a.totalOutputTokens, totalCacheReadTokens: a.totalCacheReadTokens, totalCacheWriteTokens: a.totalCacheWriteTokens,
			totalTokens: sum(g, tokens), totalCost: a.totalCost, unpricedRequests: a.unpricedRequests, totalPremiumRequests: a.totalPremiumRequests, avgTokensPerSecond: a.avgTokensPerSecond }; }),
			hourly: group(rows.filter(r => timestamp(r) !== null), r => JSON.stringify([r.model.provider, new Date(timestamp(r)!).getHours()])).map(g => ({ provider: g[0]!.model.provider ?? "unknown", hour: new Date(timestamp(g[0]!)!).getHours(), totalTokens: sum(g, tokens), outputTokens: sum(g, r => r.usage.output), requests: g.length })),
			series: group(rows.filter(r => timestamp(r) !== null), r => JSON.stringify([r.model.provider, bucketOf(timestamp(r), bucket)])).map(g => ({ timestamp: bucketOf(timestamp(g[0]!), bucket), provider: g[0]!.model.provider ?? "unknown", totalTokens: sum(g, tokens), cost: sum(g, amount), unpricedRequests: g.filter(r => amount(r) === null).length, requests: g.length })).sort((a,b) => a.timestamp - b.timestamp) };
	}
}
