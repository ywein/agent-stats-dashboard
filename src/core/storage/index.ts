import { DatabaseSync } from "node:sqlite";
import type { SessionSnapshot } from "../../adapter-contract/index.ts";
import { recordKey, sessionKey, type Json, type Provenance, type Session, type SessionRecord, type SessionRef, type Source } from "../model/index.ts";

export interface DiscoveryCheckpoint { cursor: string; startedAt: number; full: boolean }
export interface SourceCheckpoint {
	watch: Json;
	discovery: DiscoveryCheckpoint | null;
	lastDiscoveryAt: number | null;
	lastReconciledAt: number | null;
}
export interface StoredSession {
	session: Session;
	checkpoint: Json;
	unavailable: Provenance | null;
}

/** Synchronous transactions keep records and their resume positions indivisible. */
export class IngestionStore {
	private readonly db: DatabaseSync;
	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = FULL;
			PRAGMA busy_timeout = 5000;
			CREATE TABLE IF NOT EXISTS ingestion_sources (
				id TEXT PRIMARY KEY, data TEXT NOT NULL, watch TEXT NOT NULL DEFAULT 'null',
				discovery TEXT, last_discovery INTEGER, last_reconciled INTEGER
			);
			CREATE TABLE IF NOT EXISTS ingestion_sessions (
				id TEXT PRIMARY KEY, source_id TEXT NOT NULL, data TEXT NOT NULL,
				checkpoint TEXT NOT NULL, unavailable TEXT
			);
			CREATE TABLE IF NOT EXISTS ingestion_records (
				id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT,
				data TEXT, deleted TEXT
			);
			CREATE INDEX IF NOT EXISTS ingestion_sessions_source ON ingestion_sessions(source_id);
			CREATE INDEX IF NOT EXISTS ingestion_records_session ON ingestion_records(session_id);
		`);
	}

	close(): void { this.db.close(); }
	listSources(): Source[] {
		return this.db.prepare("SELECT data FROM ingestion_sources ORDER BY id").all().map(row => JSON.parse(row.data as string));
	}
	listSessions(): StoredSession[] {
		return this.db.prepare("SELECT data, checkpoint, unavailable FROM ingestion_sessions ORDER BY id").all().map(row => ({
			session: JSON.parse(row.data as string), checkpoint: JSON.parse(row.checkpoint as string),
			unavailable: row.unavailable === null ? null : JSON.parse(row.unavailable as string),
		}));
	}
	/** SQLite rowids are stable dashboard request handles, never adapter identities. */
	listRecords(): { id: number; record: SessionRecord }[] {
		return this.db.prepare("SELECT rowid AS handle, data FROM ingestion_records WHERE deleted IS NULL ORDER BY rowid").all()
			.map(row => ({ id: Number(row.handle), record: JSON.parse(row.data as string) }));
	}
	putSource(source: Source): void {
		this.db.prepare(`INSERT INTO ingestion_sources(id, data) VALUES (?, ?)
			ON CONFLICT(id) DO UPDATE SET data = excluded.data`).run(source.sourceId, JSON.stringify(source));
	}
	getSource(sourceId: string): Source | null {
		const row = this.db.prepare("SELECT data FROM ingestion_sources WHERE id = ?").get(sourceId);
		return row ? JSON.parse(row.data as string) : null;
	}
	getSourceCheckpoint(sourceId: string): SourceCheckpoint {
		const row = this.db.prepare("SELECT * FROM ingestion_sources WHERE id = ?").get(sourceId);
		if (!row) throw new Error(`Unknown source: ${sourceId}`);
		return { watch: JSON.parse(row.watch as string), discovery: row.discovery === null ? null : JSON.parse(row.discovery as string),
			lastDiscoveryAt: row.last_discovery as number | null, lastReconciledAt: row.last_reconciled as number | null };
	}
	commitDiscovery(sourceId: string, cursor: string | null, startedAt: number, full: boolean): void {
		if (cursor !== null) {
			this.db.prepare("UPDATE ingestion_sources SET discovery = ? WHERE id = ?")
				.run(JSON.stringify({ cursor, startedAt, full }), sourceId);
		} else {
			this.db.prepare(`UPDATE ingestion_sources SET discovery = NULL, last_discovery = ?,
				last_reconciled = CASE WHEN ? THEN ? ELSE last_reconciled END WHERE id = ?`)
				.run(startedAt, Number(full), startedAt, sourceId);
		}
	}
	/** Cursor expiry/gaps restart a conservative full scan, never erase history. */
	resetDiscovery(sourceId: string): void {
		this.db.prepare("UPDATE ingestion_sources SET discovery = NULL WHERE id = ?").run(sourceId);
	}
	commitWatch(sourceId: string, checkpoint: Json): void {
		this.db.prepare("UPDATE ingestion_sources SET watch = ? WHERE id = ?").run(JSON.stringify(checkpoint), sourceId);
	}
	getSession(ref: SessionRef): StoredSession | null {
		const row = this.db.prepare("SELECT * FROM ingestion_sessions WHERE id = ?").get(sessionKey(ref));
		return row ? { session: JSON.parse(row.data as string), checkpoint: JSON.parse(row.checkpoint as string),
			unavailable: row.unavailable === null ? null : JSON.parse(row.unavailable as string) } : null;
	}
	getRecords(ref: SessionRef): SessionRecord[] {
		return this.db.prepare("SELECT data FROM ingestion_records WHERE session_id = ? AND deleted IS NULL ORDER BY id")
			.all(sessionKey(ref)).map(row => JSON.parse(row.data as string));
	}
	markUnavailable(ref: SessionRef, provenance: Provenance, watchCheckpoint: Json): void {
		this.transaction(() => {
			// Keep even a deletion observed before the session was ever imported.
			const session = this.getSession(ref)?.session ?? {
				kind: "session", identity: ref, title: null, project: null, createdAt: null,
				updatedAt: null, relationships: [], provenance,
			};
			this.db.prepare(`INSERT INTO ingestion_sessions(id, source_id, data, checkpoint, unavailable)
				VALUES (?, ?, ?, 'null', ?) ON CONFLICT(id) DO UPDATE SET unavailable = excluded.unavailable`)
				.run(sessionKey(ref), ref.sourceId, JSON.stringify(session), JSON.stringify(provenance));
			this.commitWatch(ref.sourceId, watchCheckpoint);
		});
	}
	commitSnapshot(expected: SessionRef, snapshot: SessionSnapshot): void {
		validateSnapshot(expected, snapshot);
		this.transaction(() => {
			const key = sessionKey(expected);
			this.db.prepare(`INSERT INTO ingestion_sessions(id, source_id, data, checkpoint) VALUES (?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET data = excluded.data, checkpoint = excluded.checkpoint, unavailable = NULL`)
				.run(key, expected.sourceId, JSON.stringify(snapshot.session), JSON.stringify(snapshot.checkpoint));
			for (const record of snapshot.records) {
				const id = recordKey(record.identity);
				const existing = this.db.prepare("SELECT kind FROM ingestion_records WHERE id = ?").get(id);
				if (existing?.kind && existing.kind !== record.kind) throw new Error(`Record kind changed: ${id}`);
				this.db.prepare(`INSERT INTO ingestion_records(id, session_id, kind, data) VALUES (?, ?, ?, ?)
					ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, data = excluded.data, deleted = NULL`)
					.run(id, key, record.kind, JSON.stringify(record));
			}
			for (const deletion of snapshot.deleted) {
				this.db.prepare(`INSERT INTO ingestion_records(id, session_id, deleted) VALUES (?, ?, ?)
					ON CONFLICT(id) DO UPDATE SET data = NULL, deleted = excluded.deleted`)
					.run(recordKey(deletion.identity), key, JSON.stringify(deletion.provenance));
			}
		});
	}
	private transaction(work: () => void): void {
		this.db.exec("BEGIN IMMEDIATE");
		try { work(); this.db.exec("COMMIT"); }
		catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}
}

export function assertSource(ref: SessionRef, sourceId: string): void {
	if (ref.sourceId !== sourceId || typeof ref.sessionId !== "string" || !ref.sessionId)
		throw new Error("Adapter emitted an invalid or foreign session identity");
}

function validateSnapshot(expected: SessionRef, snapshot: SessionSnapshot): void {
	assertSource(snapshot.session.identity, expected.sourceId);
	if (sessionKey(snapshot.session.identity) !== sessionKey(expected)) throw new Error("Snapshot session does not match read");
	if (snapshot.mode !== "full" && snapshot.mode !== "partial") throw new Error("Invalid snapshot mode");
	const ids = new Set<string>();
	for (const item of [...snapshot.records, ...snapshot.deleted]) {
		if (sessionKey(item.identity) !== sessionKey(expected) || typeof item.identity.recordId !== "string" || !item.identity.recordId)
			throw new Error("Snapshot contains an invalid or foreign record identity");
		const key = recordKey(item.identity);
		if (ids.has(key)) throw new Error(`Duplicate snapshot identity: ${key}`);
		ids.add(key);
	}
	for (const relationship of snapshot.session.relationships) {
		assertSource(relationship.session, expected.sourceId);
		const linked = relationship.kind === "fork" ? relationship.forkPoint : relationship.spawnedBy;
		if (linked) assertSource(linked, expected.sourceId);
	}
	for (const record of snapshot.records) {
		if (record.origin) assertSource(record.origin, expected.sourceId);
		const linked = record.kind === "model-request" ? record.prompt : record.kind === "tool-execution" ? record.request
			: record.kind === "trace-event" ? record.subject : null;
		if (linked) assertSource(linked, expected.sourceId);
	}
}
