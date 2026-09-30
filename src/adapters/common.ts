import type { ContentBlock, Json, Outcome, Provenance, RequestCost, Timing, TimingValue, TokenUsage } from "../core/model/index.ts";

export function object(value: unknown): Record<string, any> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
export function number(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
export function text(value: unknown): string | null { return typeof value === "string" ? value : null; }
export function date(value: unknown): number | null { return typeof value === "string" ? number(Date.parse(value)) : number(value); }
export function content(value: unknown): ContentBlock[] | null {
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (!Array.isArray(value)) return null;
	return value.map(block => {
		const b = object(block);
		if (b.type === "text" && typeof b.text === "string") return { type: "text", text: b.text };
		if ((b.type === "thinking" || b.type === "reasoning") && typeof (b.thinking ?? b.text) === "string")
			return { type: "reasoning", text: b.thinking ?? b.text };
		return { type: "opaque", format: "source-content", data: block as Json };
	});
}
export function measured(value: number | null, method: string): TimingValue | null {
	return value === null ? null : { value, quality: "measured", method };
}
export function timing(start: number | null, end: number | null, first: number | null): Timing {
	return { startedAt: measured(start, "source timestamp"), endedAt: measured(end, "source timestamp"),
		firstTokenAt: measured(first, "source timestamp"),
		durationMs: measured(start !== null && end !== null && end >= start ? end - start : null, "endpoint subtraction"),
		ttftMs: measured(start !== null && first !== null && first >= start ? first - start : null, "endpoint subtraction") };
}
export function cost(raw: unknown, provenance: Provenance): RequestCost {
	const values = object(raw);
	const amount = (value: unknown) => number(value) === null ? null : { amount: number(value)!, provenance };
	return { currency: "USD", recorded: { total: amount(values.total), categories: {
		input: amount(values.input), output: amount(values.output), cacheRead: amount(values.cacheRead),
		cacheWrite: amount(values.cacheWrite), reasoning: amount(values.reasoning),
	} }, estimated: { total: null, categories: { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null } } };
}
export function usage(raw: unknown, semantics: string): TokenUsage {
	const u = object(raw);
	return { input: number(u.input), output: number(u.output), cacheRead: number(u.cacheRead), cacheWrite: number(u.cacheWrite),
		reasoning: number(u.reasoning), total: number(u.totalTokens), inputIncludesCache: "no", outputIncludesReasoning: "unknown",
		semantics, additional: {} };
}
export function outcome(reason: unknown, error: unknown, completed: boolean, live = false): Outcome {
	const r = text(reason);
	return { status: error != null || r === "error" ? "failed" : r === "aborted" || r === "cancelled" ? "interrupted"
		: completed ? "succeeded" : live ? "running" : "incomplete", reason: r,
		error: error == null ? null : { message: text(error) ?? text(object(error).message), code: text(object(error).code), details: error as Json } };
}
