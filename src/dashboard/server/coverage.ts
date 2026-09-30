import { estimatedBreakdownDifference, type ModelRequest } from "../../core/model/index.ts";
import { sum } from "../../core/aggregation/index.ts";
import type { MetricCoverage } from "../shared-types.ts";

/** Coverage uses owned requests in the selected range, never advertised capabilities. */
export function metricCoverage(rows: ModelRequest[]): MetricCoverage {
	const count = (test: (r: ModelRequest) => boolean) => rows.filter(test).length;
	const categories = ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const;
	const money = (value: (r: ModelRequest) => number | null) => {
		const available = count(r => value(r) !== null);
		return { available, total: available ? sum(rows, value) : null };
	};
	return {
		requests: rows.length,
		latency: count(r => r.timing.durationMs !== null),
		measuredLatency: count(r => r.timing.durationMs?.quality === "measured"),
		ttft: count(r => r.timing.ttftMs !== null),
		input: count(r => r.usage.input !== null), output: count(r => r.usage.output !== null),
		cacheRead: count(r => r.usage.cacheRead !== null), cacheWrite: count(r => r.usage.cacheWrite !== null),
		reasoning: count(r => r.usage.reasoning !== null), premiumRequests: count(r => r.usage.additional.premiumRequests !== undefined),
		recorded: money(r => r.cost.recorded.total?.amount ?? null),
		estimated: money(r => r.cost.recorded.total === null ? r.cost.estimated.total?.amount ?? null : null),
		estimatedCategories: Object.fromEntries(categories.map(key => [key, money(r => r.cost.estimated.categories[key]?.amount ?? null)])) as MetricCoverage["estimatedCategories"],
		breakdownDifference: money(r => estimatedBreakdownDifference(r.cost)),
		pricingBases: [...new Set(rows.flatMap(r => Object.values(r.cost.estimated.categories).flatMap(v => v ? [`${v.basis.temporalBasis} rates · ${v.basis.rateSource} · ${v.basis.tier.kind} tier`] : [])))],
	};
}
