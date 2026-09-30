import { setTimeout as delay } from "node:timers/promises";
import type { AdapterConnection, AdapterContext, ClientAdapter, SourceChange } from "../../adapter-contract/index.ts";
import { assertAdapterCompatible } from "../../adapter-contract/index.ts";
import type { SessionRef, Source } from "../model/index.ts";
import { assertSource, IngestionStore } from "../storage/index.ts";

export interface SourceRegistration { source: Source; adapter: ClientAdapter; config: unknown }
export interface SourceIngestionStatus {
	sourceId: string;
	label: string;
	phase: "connecting" | "syncing" | "idle" | "error" | "stopped";
	operation: "connect" | "discover" | "read" | "watch" | "commit" | "close" | null;
	error: string | null;
	attempt: number;
	current: number;
	total: number;
	lastSyncedAt: number | null;
}
export interface IngestionStatus { version: number; sources: SourceIngestionStatus[] }
export interface IngestionOptions {
	pollIntervalMs?: number;
	reconcileIntervalMs?: number;
	retryDelayMs?: number;
	maxAttempts?: number;
	log?: AdapterContext["log"];
}
interface Worker {
	registration: SourceRegistration;
	status: SourceIngestionStatus;
	connection: AdapterConnection | null;
	signal: AbortSignal;
	queue: Promise<void>;
	task: Promise<void>;
}

/** One serial write lane per source; independent source workers never share failure fate. */
export class IngestionCoordinator {
	private readonly controller = new AbortController();
	private readonly workers = new Map<string, Worker>();
	private readonly listeners = new Set<(status: IngestionStatus) => void>();
	private version = 0;
	private started = false;
	private stopping: Promise<void> | null = null;
	private readonly options: Required<IngestionOptions>;
	private readonly store: IngestionStore;

	constructor(store: IngestionStore, registrations: SourceRegistration[], options: IngestionOptions = {}) {
		this.store = store;
		this.options = { pollIntervalMs: 30_000, reconcileIntervalMs: 300_000, retryDelayMs: 1000,
			maxAttempts: 3, log: () => {}, ...options };
		for (const key of ["pollIntervalMs", "reconcileIntervalMs", "retryDelayMs", "maxAttempts"] as const) {
			if (!Number.isSafeInteger(this.options[key]) || this.options[key] < 1) throw new Error(`Invalid ${key}`);
		}
		for (const registration of registrations) {
			const { source, adapter } = registration;
			if (!source.sourceId || this.workers.has(source.sourceId)) throw new Error(`Duplicate or empty source ID: ${source.sourceId}`);
			assertAdapterCompatible(adapter);
			this.workers.set(source.sourceId, { registration, connection: null, signal: this.controller.signal,
				queue: Promise.resolve(), task: Promise.resolve(), status: { sourceId: source.sourceId, label: source.label,
					phase: "stopped", operation: null, error: null, attempt: 0, current: 0, total: 0, lastSyncedAt: null } });
		}
	}

	status(): IngestionStatus { return structuredClone({ version: this.version, sources: [...this.workers.values()].map(w => w.status) }); }
	subscribe(listener: (status: IngestionStatus) => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}
	start(): void {
		if (this.controller.signal.aborted) throw new Error("Coordinator has stopped");
		if (this.started) return;
		this.started = true;
		for (const worker of this.workers.values()) worker.task = this.run(worker);
	}
	/** Refreshes all selected sources independently; status retains individual failures. */
	async refresh(sourceId?: string): Promise<void> {
		if (!this.started || this.controller.signal.aborted) throw new Error("Coordinator is not running");
		const workers = sourceId === undefined ? [...this.workers.values()] : [this.workers.get(sourceId)];
		if (workers.some(w => !w)) throw new Error(`Unknown source: ${sourceId}`);
		const results = await Promise.allSettled(workers.map(w => this.enqueue(w!, () => this.discover(w!, true))));
		const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
		if (failures.length) throw new AggregateError(failures.map(r => r.reason), "Source refresh failed");
	}
	stop(): Promise<void> {
		if (!this.stopping) {
			this.controller.abort();
			this.stopping = Promise.all([...this.workers.values()].map(w => w.task)).then(() => {});
		}
		return this.stopping;
	}
	private emit(): void {
		for (const listener of this.listeners) {
			try { listener(this.status()); } catch { /* Status observers cannot fail ingestion. */ }
		}
	}
	private update(w: Worker, patch: Partial<SourceIngestionStatus>): void { Object.assign(w.status, patch); this.emit(); }
	private committed(): void { this.version++; this.emit(); }
	private enqueue(w: Worker, work: () => Promise<void>): Promise<void> {
		const signal = w.signal;
		const next = w.queue.then(async () => {
			signal.throwIfAborted();
			try { await work(); }
			catch (error) {
				if (!signal.aborted) this.update(w, { phase: "error", error: error instanceof Error ? error.message : String(error) });
				throw error;
			}
		});
		w.queue = next.catch(() => {});
		return next;
	}
	private async retry<T>(w: Worker, operation: SourceIngestionStatus["operation"], work: () => Promise<T> | T): Promise<T> {
		for (let attempt = 1; ; attempt++) {
			w.signal.throwIfAborted();
			this.update(w, { operation, attempt });
			try { return await work(); }
			catch (error) {
				if (w.signal.aborted) throw error;
				this.update(w, { phase: "error", error: error instanceof Error ? error.message : String(error) });
				if (attempt >= this.options.maxAttempts) throw error;
				await delay(this.options.retryDelayMs * 2 ** Math.min(attempt - 1, 6), undefined, { signal: w.signal });
			}
		}
	}
	private async run(w: Worker): Promise<void> {
		const globalSignal = this.controller.signal;
		while (!globalSignal.aborted) {
			const cycle = new AbortController();
			const abort = () => cycle.abort();
			globalSignal.addEventListener("abort", abort, { once: true });
			w.signal = cycle.signal;
			let tasks: Promise<void>[] = [];
			try {
				this.update(w, { phase: "connecting", operation: "connect" });
				const { source, adapter, config } = w.registration;
				w.connection = await this.retry(w, "connect", () => adapter.connect(config, {
					source, signal: w.signal, log: this.options.log,
				}));
				w.signal.throwIfAborted();
				await this.retry(w, "commit", () => this.store.putSource({ ...source, capabilities: w.connection!.capabilities }));
				await this.enqueue(w, () => this.discover(w, true));
				tasks = [this.poll(w)];
				if (w.connection.watchChanges) tasks.push(this.watch(w));
				await Promise.all(tasks);
			} catch (error) {
				if (!globalSignal.aborted) this.update(w, { phase: "error", error: error instanceof Error ? error.message : String(error) });
			} finally {
				cycle.abort();
				await Promise.allSettled(tasks);
				await w.queue;
				try { await w.connection?.close(); }
				catch (error) { this.update(w, { phase: "error", operation: "close", error: String(error) }); }
				w.connection = null;
				globalSignal.removeEventListener("abort", abort);
			}
			if (!globalSignal.aborted) {
				await delay(this.options.retryDelayMs, undefined, { signal: globalSignal }).catch(() => {});
			}
		}
		this.update(w, { phase: "stopped", operation: null });
	}
	private async poll(w: Worker): Promise<void> {
		while (!w.signal.aborted) {
			await delay(this.options.pollIntervalMs, undefined, { signal: w.signal });
			await this.enqueue(w, () => this.discover(w, false));
		}
	}
	private async discover(w: Worker, forceFull: boolean): Promise<void> {
		if (!w.connection) throw new Error("Source is not connected");
		const sourceId = w.registration.source.sourceId;
		const state = this.store.getSourceCheckpoint(sourceId);
		const pending = state.discovery;
		const startedAt = pending?.startedAt ?? Date.now();
		const full = pending?.full ?? (forceFull || state.lastReconciledAt === null || Date.now() - state.lastReconciledAt >= this.options.reconcileIntervalMs);
		let cursor = pending?.cursor ?? null;
		const cursors = new Set<string>();
		this.update(w, { phase: "syncing", current: 0, total: 0 });
		try {
			do {
				if (cursor !== null) {
					if (cursors.has(cursor)) throw new Error("Adapter pagination cursor cycle");
					cursors.add(cursor);
				}
				const page = await this.retry(w, "discover", () => w.connection!.listSessions({ cursor,
					updatedSince: full ? null : state.lastDiscoveryAt, signal: w.signal }));
				w.signal.throwIfAborted();
				if (page.nextCursor !== null && typeof page.nextCursor !== "string") throw new Error("Invalid discovery cursor");
				this.update(w, { total: w.status.total + page.sessions.length });
				for (const session of page.sessions) {
					assertSource(session.identity, sourceId);
					await this.read(w, session.identity, full);
					this.update(w, { current: w.status.current + 1 });
				}
				await this.retry(w, "commit", () => this.store.commitDiscovery(sourceId, page.nextCursor, startedAt, full));
				cursor = page.nextCursor;
			} while (cursor !== null);
		} catch (error) {
			// Preserve a durable page on cancellation; restart expired/broken cursors on the next connection.
			if (!w.signal.aborted) this.store.resetDiscovery(sourceId);
			throw error;
		}
		if (forceFull && !full) return this.discover(w, true);
		this.update(w, { phase: "idle", operation: null, error: null, attempt: 0, lastSyncedAt: Date.now() });
	}
	private async read(w: Worker, ref: SessionRef, full: boolean): Promise<void> {
		assertSource(ref, w.registration.source.sourceId);
		const checkpoint = full ? null : this.store.getSession(ref)?.checkpoint ?? null;
		const snapshot = await this.retry(w, "read", () => w.connection!.readSession({ session: ref, checkpoint, signal: w.signal }));
		w.signal.throwIfAborted();
		if (checkpoint === null && snapshot.mode !== "full") throw new Error("Adapter must return a full snapshot for a null checkpoint");
		await this.retry(w, "commit", () => this.store.commitSnapshot(ref, snapshot));
		this.committed();
	}
	private async watch(w: Worker): Promise<void> {
		const sourceId = w.registration.source.sourceId;
		const changes = w.connection!.watchChanges!({ checkpoint: this.store.getSourceCheckpoint(sourceId).watch, signal: w.signal });
		const iterator = changes[Symbol.asyncIterator]();
		try {
			while (!w.signal.aborted) {
				let event: IteratorResult<SourceChange>;
				try {
					event = await iterator.next();
					if (event.done) throw new Error("Adapter change stream ended; reconnecting");
				} catch (error) {
					if (!w.signal.aborted) {
						// Only a stream failure resets its cursor; failed ingestion must replay the prior cursor.
						this.update(w, { phase: "error", operation: "watch", error: error instanceof Error ? error.message : String(error) });
						await this.enqueue(w, async () => { this.store.commitWatch(sourceId, null); });
					}
					throw error;
				}
				await this.enqueue(w, () => this.applyChange(w, event.value));
			}
		} finally {
			await iterator.return?.();
		}
	}
	private async applyChange(w: Worker, change: SourceChange): Promise<void> {
		const sourceId = w.registration.source.sourceId;
		this.update(w, { phase: "syncing" });
		if (change.kind === "deleted") {
			assertSource(change.session, sourceId);
			await this.retry(w, "commit", () => this.store.markUnavailable(change.session, change.provenance, change.checkpoint));
			this.committed();
		} else {
			if (change.kind === "refresh") await this.read(w, change.session, false);
			else if (change.kind === "rescan") await this.discover(w, true);
			else throw new Error("Invalid source change");
			w.signal.throwIfAborted();
			await this.retry(w, "commit", () => this.store.commitWatch(sourceId, change.checkpoint));
		}
		this.update(w, { phase: "idle", operation: null, error: null, attempt: 0, lastSyncedAt: Date.now() });
	}
}
