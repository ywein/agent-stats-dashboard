import type { CostCategory, ModelRequest, PricingBasis, RequestCost } from "../model/index.ts";

export interface RateCard {
	model: PricingBasis["model"];
	rates: PricingBasis["rates"];
	context: { minimum: number; maximumExclusive: number | null } | null;
	rateSource: string;
	retrievedAt: number;
}

/** Estimates are independent of recorded spend, including an explicitly recorded zero. */
export function estimateCost(request: ModelRequest, cards: readonly RateCard[]): RequestCost {
	const cost = structuredClone(request.cost);
	cost.estimated = { total: null, categories: { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null } };
	const matches = cards.filter(c => c.model.provider === request.model.provider && c.model.model === request.model.model);
	const u = request.usage;
	const context = u.inputIncludesCache === "yes" ? u.input : u.inputIncludesCache === "no" && u.input !== null && u.cacheRead !== null && u.cacheWrite !== null
		? u.input + u.cacheRead + u.cacheWrite : null;
	// Never fall through to a base rate when a context-dependent tariff is unresolved.
	const tiered = matches.some(c => c.context !== null);
	const eligible = matches.filter(c => tiered ? context !== null && Number.isSafeInteger(context) && c.context !== null && context >= c.context.minimum &&
		(c.context.maximumExclusive === null || context < c.context.maximumExclusive) : c.context === null);
	if (eligible.length !== 1) return cost;
	const card = eligible[0]!;
	const basis: PricingBasis = { model: request.model, currency: cost.currency, rates: card.rates,
		tier: card.context ? { kind: "context", ...card.context, contextTokens: context! } : { kind: "flat" },
		rateSource: card.rateSource, retrievedAt: card.retrievedAt, temporalBasis: "current", effectiveAt: null,
		method: "non-overlapping tokens × current per-million rate" };
	const counts: Record<CostCategory, number | null> = { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, reasoning: u.reasoning };
	if (u.inputIncludesCache === "yes") counts.input = u.input !== null && u.cacheRead !== null && u.cacheWrite !== null ? Math.max(0, u.input - u.cacheRead - u.cacheWrite) : null;
	if (u.inputIncludesCache === "unknown") counts.input = null;
	if (u.outputIncludesReasoning !== "no") counts.reasoning = null;
	for (const category of ["input", "output", "cacheRead"] as const) {
		const orchestration = u.additional[`orchestration.${category}`];
		if (counts[category] !== null && orchestration?.unit === "tokens") counts[category] += orchestration.value;
	}
	for (const category of Object.keys(counts) as CostCategory[]) {
		const count = counts[category], rate = card.rates[category];
		if (count !== null && rate !== null && Number.isFinite(rate) && rate >= 0)
			cost.estimated.categories[category] = { amount: count * rate / 1e6, basis };
	}
	const required: CostCategory[] = ["input", "output", "cacheRead", "cacheWrite"];
	if (u.outputIncludesReasoning === "no") required.push("reasoning");
	if (required.every(c => cost.estimated.categories[c] !== null))
		cost.estimated.total = { amount: required.reduce((sum, c) => sum + cost.estimated.categories[c]!.amount, 0), basis };
	return cost;
}
