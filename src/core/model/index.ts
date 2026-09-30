/** JSON-serializable wire records. Null means unknown; zero is always a value. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Timestamp = number; // Unix milliseconds, never seconds.
export interface SessionRef { sourceId: string; sessionId: string }
export interface RecordRef extends SessionRef { recordId: string }

export interface Provenance {
	/** Adapter-owned locator, not a session identity. Never include credentials. */
	locator: Json;
	observedAt: Timestamp;
	/** Opaque equality token, not a sortable revision. */
	revision: string | null;
	adapterVersion: string;
}

export interface SourceCapabilities {
	requestDetails: boolean;
	toolResults: boolean;
	traceEvents: boolean;
	ttft: boolean;
	recordedCosts: boolean;
	/** Sufficient model/usage metadata may be available to shared pricing. */
	pricingEstimates: boolean;
}
export interface Source {
	sourceId: string;
	clientType: string;
	label: string;
	capabilities: SourceCapabilities;
}

export interface Session {
	kind: "session";
	/** Optional source-reported role; relationship links carry ownership independently. */
	agentRole?: "main" | "subagent" | "advisor" | null;
	identity: SessionRef;
	title: string | null;
	project: { id: string | null; name: string | null; directory: string | null } | null;
	createdAt: Timestamp | null;
	updatedAt: Timestamp | null;
	relationships: SessionRelationship[];
	provenance: Provenance;
}
export type SessionRelationship =
	| { kind: "parent" | "subagent"; session: SessionRef; spawnedBy: RecordRef | null }
	| { kind: "fork"; session: SessionRef; forkPoint: RecordRef | null };

export interface RecordBase {
	identity: RecordRef;
	provenance: Provenance;
	/** Canonical original for copied fork history; null means locally owned. */
	origin: RecordRef | null;
}
export type ContentBlock =
	| { type: "text" | "reasoning"; text: string }
	| { type: "attachment"; mediaType: string | null; locator: Json }
	| { type: "opaque"; format: string; data: Json };
export interface UserMessage extends RecordBase {
	kind: "user-message";
	content: ContentBlock[] | null;
	at: Timestamp | null;
}

/** Counters retain the source's semantics; never sum overlapping counters. */
export interface TokenUsage {
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	reasoning: number | null;
	total: number | null;
	inputIncludesCache: "yes" | "no" | "unknown";
	outputIncludesReasoning: "yes" | "no" | "unknown";
	/** Adapter description of accounting, including what a reported total counts. */
	semantics: string;
	additional: Record<string, { value: number; unit: string }>;
}

export interface ModelIdentity { provider: string | null; model: string | null; api: string | null }
export type CostCategory = "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning";
export interface RecordedAmount { amount: number; provenance: Provenance }
export interface EstimatedAmount { amount: number; basis: PricingBasis }
export interface PricingBasis {
	model: ModelIdentity;
	currency: string;
	/** Price per one million tokens; null is not a free rate. */
	rates: Record<CostCategory, number | null>;
	tier: { kind: "flat" } | {
		kind: "context"; minimum: number; maximumExclusive: number | null; contextTokens: number;
	};
	rateSource: string;
	retrievedAt: Timestamp;
	temporalBasis: "current" | "historical";
	effectiveAt: Timestamp | null;
	method: string;
}
export interface RequestCost {
	currency: string;
	recorded: { total: RecordedAmount | null; categories: Record<CostCategory, RecordedAmount | null> };
	estimated: { total: EstimatedAmount | null; categories: Record<CostCategory, EstimatedAmount | null> };
}

export interface TimingValue {
	value: number;
	quality: "measured" | "inferred";
	/** For example: endpoint subtraction, extension hook, adjacent entry estimate. */
	method: string;
}
export interface Timing {
	startedAt: TimingValue | null;
	firstTokenAt: TimingValue | null;
	endedAt: TimingValue | null;
	durationMs: TimingValue | null;
	ttftMs: TimingValue | null;
}
export interface Outcome {
	/** Incomplete is a truncated/abandoned observation, not evidence of cancellation. */
	status: "pending" | "running" | "succeeded" | "failed" | "interrupted" | "incomplete" | "unknown";
	reason: string | null;
	error: { message: string | null; code: string | null; details: Json } | null;
}
export interface ModelRequest extends RecordBase {
	kind: "model-request";
	model: ModelIdentity;
	/** Optional link, not necessarily the immediately preceding entry. */
	prompt: RecordRef | null;
	output: ContentBlock[] | null;
	usage: TokenUsage;
	cost: RequestCost;
	outcome: Outcome;
	timing: Timing;
	purpose: string | null;
}
export interface ToolExecution extends RecordBase {
	kind: "tool-execution";
	request: RecordRef | null;
	callId: string | null;
	name: string | null;
	/** Wrapper distinguishes unknown arguments from an explicitly supplied JSON null. */
	arguments: { value: Json } | null;
	result: ContentBlock[] | null;
	outcome: Outcome;
	timing: Timing;
}
export interface TraceEvent extends RecordBase {
	kind: "trace-event";
	eventType: string;
	at: TimingValue | null;
	subject: RecordRef | null;
	data: Json;
}
export type SessionRecord = UserMessage | ModelRequest | ToolExecution | TraceEvent;

/** Tuple encoding is collision-safe even when IDs contain separators. */
export function sessionKey(ref: SessionRef): string {
	return JSON.stringify([ref.sourceId, ref.sessionId]);
}
export function recordKey(ref: RecordRef): string {
	return JSON.stringify([ref.sourceId, ref.sessionId, ref.recordId]);
}

/** Recorded zero takes precedence. Callers must still label the returned basis. */
export function preferredTotal(cost: RequestCost):
	{ amount: number; basis: "recorded" | "estimated" } | null {
	if (cost.recorded.total !== null) return { amount: cost.recorded.total.amount, basis: "recorded" };
	if (cost.estimated.total !== null) return { amount: cost.estimated.total.amount, basis: "estimated" };
	return null;
}

/** Estimate minus recorded total. Only a complete four-category breakdown qualifies;
 * reasoning is optional (typically included in output), but included if separately priced. */
export function estimatedBreakdownDifference(cost: RequestCost): number | null {
	if (cost.recorded.total === null) return null;
	const categories = cost.estimated.categories;
	const required = [categories.input, categories.output, categories.cacheRead, categories.cacheWrite];
	if (required.some(value => value === null)) return null;
	return required.reduce((sum, value) => sum + value!.amount, 0)
		+ (categories.reasoning?.amount ?? 0) - cost.recorded.total.amount;
}
