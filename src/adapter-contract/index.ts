import type { Json, Provenance, Session, SessionRecord, SessionRef, Source, SourceCapabilities, RecordRef } from "../core/model/index.ts";

export const ADAPTER_API_VERSION = 1 as const;
export interface AdapterDescriptor { id: string; name: string; version: string; contractVersion: typeof ADAPTER_API_VERSION }

/** Validate at runtime too: JavaScript and separately installed adapters bypass TS. */
export function assertAdapterCompatible(value: unknown): asserts value is ClientAdapter {
	const adapter = value as Partial<ClientAdapter> | null;
	const descriptor = adapter?.descriptor;
	const name = descriptor?.id ?? "unknown";
	if (descriptor?.contractVersion !== ADAPTER_API_VERSION) {
		throw new Error(`Adapter "${name}" requires API ${descriptor?.contractVersion ?? "unspecified"}; this runtime supports API ${ADAPTER_API_VERSION}. Install a compatible adapter or upgrade the dashboard.`);
	}
	if (![descriptor.id, descriptor.name, descriptor.version].every(v => typeof v === "string" && v.trim()) || typeof adapter?.connect !== "function") {
		throw new Error(`Adapter "${name}" must export a descriptor (id, name, version, contractVersion) and connect(config, context).`);
	}
}
export interface AdapterContext {
	source: Source;
	signal: AbortSignal;
	log(level: "debug" | "info" | "warn" | "error", message: string, details?: Json): void;
}
export interface ClientAdapter {
	descriptor: AdapterDescriptor;
	connect(config: unknown, context: AdapterContext): Promise<AdapterConnection>;
}
export interface SessionPageInput {
	cursor: string | null;
	/** Optimization hint only; periodic full discovery remains required. */
	updatedSince: number | null;
	signal: AbortSignal;
}
export interface SessionPage {
	sessions: Session[];
	nextCursor: string | null;
}
export interface SessionReadInput {
	session: SessionRef;
	/** Last committed session checkpoint; null requires a mode: "full" response. */
	checkpoint: Json;
	signal: AbortSignal;
}
export interface RecordDeletion { identity: RecordRef; provenance: Provenance }
export type SessionSnapshot = {
	session: Session;
	/** Whole-record replacements, never field patches. */
	records: SessionRecord[];
	/** Persist atomically with this read's records. */
	checkpoint: Json;
} & (
	| { mode: "full"; deleted: RecordDeletion[] }
	| { mode: "partial"; deleted: RecordDeletion[] }
);
export interface WatchInput { checkpoint: Json; signal: AbortSignal }
export type SourceChange =
	| { kind: "refresh"; session: SessionRef; checkpoint: Json }
	| { kind: "rescan"; checkpoint: Json }
	| { kind: "deleted"; session: SessionRef; provenance: Provenance; checkpoint: Json };
export interface AdapterConnection {
	capabilities: SourceCapabilities;
	listSessions(input: SessionPageInput): Promise<SessionPage>;
	readSession(input: SessionReadInput): Promise<SessionSnapshot>;
	watchChanges?(input: WatchInput): AsyncIterable<SourceChange>;
	close(): Promise<void>;
}
