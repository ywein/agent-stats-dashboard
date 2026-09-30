import { useState } from "react";
import { getSources, requestSync } from "../api";
import { useQuery } from "../data/query";
import { useLive } from "../data/live";
import { formatCost, formatPercent, formatRelativeTime } from "../data/formatters";
import type { useHashRoute } from "../data/useHashRoute";
import { ErrorState } from "../ui/States";

const labels = { requestDetails: "Request details", toolResults: "Tool results", traceEvents: "Detailed traces", ttft: "TTFT", recordedCosts: "Recorded costs", pricingEstimates: "Pricing estimates" } as const;

export function SourcesPanel({ route }: { route: ReturnType<typeof useHashRoute> }) {
	const query = useQuery(["sources", route.range], () => getSources(route.range), { pollMs: 5000 });
	const { sources: statuses } = useLive();
	const [error, setError] = useState<Error | null>(null);
	const [pending, setPending] = useState<string | null>(null);
	const data = query.data;
	if (query.error) return <section><ErrorState error={query.error} onRetry={query.refetch} /><button className="btn" onClick={() => route.setSource({})}>Show all sources</button></section>;
	if (!data) return <p className="dim">Loading sources…</p>;
	const selected = data.sources.filter(s => data.selectedSourceIds.includes(s.sourceId));
	const coverage = data.coverage;
	const feature = route.section === "traces" ? "traceEvents" : route.section === "tools" ? "toolResults" : route.section === "requests" ? "requestDetails" : null;
	const supported = feature ? selected.filter(s => s.capabilities[feature]).length : 0;
	const available = (count: number) => coverage.requests ? `${formatPercent(count / coverage.requests)} of requests (${count}/${coverage.requests})` : "unavailable — no requests";
	const refresh = async (id: string) => {
		setPending(id); setError(null);
		try { await requestSync(id); } catch (e) { setError(e instanceof Error ? e : new Error(String(e))); }
		finally { setPending(null); query.refetch(); }
	};
	return <section className="card" style={{ marginBottom: 20, padding: 16 }} aria-label="Sources and metric coverage">
		<div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
			<label>Source <select aria-label="Source" value={route.sourceId !== undefined ? `source:${route.sourceId}` : route.clientType !== undefined ? `client:${route.clientType}` : "all"}
				onChange={e => { const value = e.target.value; route.setSource(value === "all" ? {} : value.startsWith("source:") ? { sourceId: value.slice(7) } : { clientType: value.slice(7) }); }}>
				<option value="all">All sources</option>
				<optgroup label="Client type">{[...new Set(data.sources.map(s => s.clientType))].map(type => <option key={type} value={`client:${type}`}>{type}</option>)}</optgroup>
				<optgroup label="Individual source">{data.sources.map(s => <option key={s.sourceId} value={`source:${s.sourceId}`}>{s.label} ({s.sourceId})</option>)}</optgroup>
			</select></label>
			<span className="dim">{coverage.requests} requests · Latency available for {available(coverage.latency)} · TTFT available for {available(coverage.ttft)}</span>
		</div>
		{feature && supported < selected.length && <p role="note" className="micro dim">{labels[feature]} supported by {supported} of {selected.length} selected sources. {selected.filter(s => !s.capabilities[feature]).map(s => s.label).join(", ")} cannot supply this feature. Available usage and session summaries are still shown.</p>}
		<p className="micro dim">Recorded spend: {formatCost(coverage.recorded.total)} ({coverage.recorded.available} requests). Estimated-only spend: {formatCost(coverage.estimated.total)} ({coverage.estimated.available} requests). {coverage.requests - coverage.recorded.available - coverage.estimated.available} requests have unavailable cost. Cost charts combine these two labeled bases; estimates are API-equivalent prices, not recorded charges.</p>
		<details>
			<summary>Source status, capabilities and coverage</summary>
			{selected.map(source => {
				const status = statuses.find(s => s.sourceId === source.sourceId) ?? source.status;
				const unsupported = Object.entries(labels).filter(([key]) => !source.capabilities[key as keyof typeof labels]).map(([, label]) => label);
				return <div key={source.sourceId} style={{ marginTop: 12 }}>
					<strong>{source.label}</strong> · {source.clientType} · {status?.phase ?? "Not configured"} · Last synced {status?.lastSyncedAt ? formatRelativeTime(status.lastSyncedAt) : "never"}{" "}
					<button className="btn" disabled={!status || pending === source.sourceId || status.phase === "syncing" || status.phase === "connecting"} onClick={() => void refresh(source.sourceId)}>Refresh {source.label}</button>
					{status?.error && <p role="alert">{status.operation}: {status.error}</p>}
					<p className="micro dim">{unsupported.length ? `Unavailable from this source: ${unsupported.join(", ")}.` : "All capabilities supported."} Capabilities describe possible data; individual records may still be incomplete.</p>
				</div>;
			})}
			<p className="micro dim">Latency: {coverage.measuredLatency} measured, {coverage.latency - coverage.measuredLatency} inferred. Token coverage — input: {available(coverage.input)}; output: {available(coverage.output)}; cache read: {available(coverage.cacheRead)}; cache write: {available(coverage.cacheWrite)}. Aggregates include available values only.</p>
			<strong>Separate estimated category breakdown</strong>
			<p className="micro dim">{Object.entries(coverage.estimatedCategories).map(([key, value]) => `${key}: ${formatCost(value.total)} (${value.available}/${coverage.requests} requests)`).join(" · ")}</p>
			<p className="micro dim">{coverage.pricingBases.join("; ") || "Pricing estimates unavailable."} Estimates are not rescaled to recorded spend. For {coverage.breakdownDifference.available} requests with both a recorded total and complete estimated categories, estimate minus recorded total is {formatCost(coverage.breakdownDifference.total)}. Different rates, subscriptions and billing policies can make these values differ.</p>
		</details>
		{error && <p role="alert">{error.message}</p>}
	</section>;
}
