import type { LiveStatus, SourceIngestionStatus } from "../shared-types.ts";

/** Structural boundary keeps the dashboard independent of storage and adapters. */
export interface IngestionStatusProvider {
	status(): { version: number; sources: SourceIngestionStatus[] };
	subscribe(listener: (status: { version: number; sources: SourceIngestionStatus[] }) => void): () => void;
	refresh(sourceId?: string): Promise<void>;
}

/** Shared host adapter for /api/status, /api/events and the sync action. */
export function createIngestionStatusBridge(ingestion: IngestionStatusProvider, indexingHours: () => number = () => 0) {
	const present = ({ version, sources }: ReturnType<IngestionStatusProvider["status"]>): LiveStatus => {
		const errors = sources.filter(source => source.error !== null && source.phase !== "stopped");
		const syncing = sources.some(source => source.phase === "connecting" || source.phase === "syncing");
		const times = sources.map(source => source.lastSyncedAt);
		return {
			version, sources, indexingHours: indexingHours(),
			sync: {
				phase: errors.length ? "error" : syncing ? "syncing" : "idle",
				current: sources.reduce((sum, source) => sum + source.current, 0),
				total: sources.reduce((sum, source) => sum + source.total, 0),
				processed: 0,
				lastSyncedAt: times.length && times.every(time => time !== null) ? Math.min(...times as number[]) : null,
				error: errors.length ? errors.map(source => `${source.label} (${source.operation ?? "ingestion"}): ${source.error}`).join("; ") : null,
			},
		};
	};
	return {
		status: () => present(ingestion.status()),
		subscribe: (listener: (status: LiveStatus) => void) => ingestion.subscribe(status => listener(present(status))),
		requestSync: (sourceId?: string) => ingestion.refresh(sourceId),
	};
}
