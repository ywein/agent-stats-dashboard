import { preferredTotal, type ModelRequest, type SessionRecord } from "../model/index.ts";

export function group<T>(items: readonly T[], key: (item: T) => string): T[][] {
	const groups = new Map<string, T[]>();
	for (const item of items) { const k = key(item); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(item); }
	return [...groups.values()];
}
export function sum<T>(items: readonly T[], value: (item: T) => number | null): number {
	return items.reduce((total, item) => total + (value(item) ?? 0), 0);
}
export function average<T>(items: readonly T[], value: (item: T) => number | null): number | null {
	const values = items.map(value).filter((v): v is number => v !== null);
	return values.length ? sum(values, v => v) / values.length : null;
}
export function tokens(request: ModelRequest): number | null {
	const u = request.usage;
	if (u.total !== null) return u.total;
	if (u.input === null || u.output === null || u.inputIncludesCache === "unknown") return null;
	let result = u.input + u.output;
	if (u.inputIncludesCache === "no") {
		if (u.cacheRead === null || u.cacheWrite === null) return null;
		result += u.cacheRead + u.cacheWrite;
	}
	if (u.outputIncludesReasoning === "no") {
		if (u.reasoning === null) return null;
		result += u.reasoning;
	}
	return result + sum(Object.entries(u.additional).filter(([name]) => name.startsWith("orchestration.")), ([, v]) => v.value);
}
export function timestamp(record: SessionRecord): number | null {
	return record.kind === "user-message" ? record.at : record.kind === "trace-event" ? record.at?.value ?? null : record.timing.startedAt?.value ?? null;
}
/** Keep the preferred-total policy visible alongside the legacy total field. */
export function spend(requests: readonly ModelRequest[]) {
	return { recorded: sum(requests, r => r.cost.recorded.total?.amount ?? null),
		estimated: sum(requests.filter(r => r.cost.recorded.total === null), r => r.cost.estimated.total?.amount ?? null),
		unavailable: requests.filter(r => preferredTotal(r.cost) === null).length,
		basis: "recorded totals preferred; estimates only when recorded totals are unavailable" };
}
