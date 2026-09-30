import { createHash } from "node:crypto";
import { watch } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ClientAdapter, SessionSnapshot } from "../adapter-contract/index.ts";
import type { Json, ModelRequest, RecordRef, Session, SessionRecord, SourceCapabilities, ToolExecution } from "../core/model/index.ts";
import { estimateCost, type RateCard } from "../core/pricing/index.ts";
import { content, cost, date, measured, number, object, outcome, text, timing, usage } from "./common.ts";

export const capabilities: SourceCapabilities = { requestDetails: true, toolResults: true, traceEvents: true, ttft: true, recordedCosts: true, pricingEstimates: true };
export interface PiConfig { root: string; modelsPath?: string }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Only complete lines are checkpointed; a concurrently written tail is retried. */
export function parseJournal(bytes: Buffer): { entries: Record<string, any>[]; offset: number } {
	const offset = bytes.lastIndexOf(10) + 1;
	const entries: Record<string, any>[] = [];
	for (const line of bytes.subarray(0, offset).toString("utf8").split("\n")) {
		if (!line.trim()) continue;
		// A malformed complete record must fail the read rather than advance its checkpoint.
		entries.push(object(JSON.parse(line)));
	}
	return { entries, offset };
}

export function convertEntries(session: Session, entries: Record<string, any>[], cards: readonly RateCard[] = []): SessionRecord[] {
	const records: SessionRecord[] = [], tools = new Map<string, ToolExecution>();
	const prompts = new Set(entries.filter(e => e.message?.role === "user").map(e => e.id));
	const starts = new Map<string, number>();
	for (const e of entries) {
		if (e.type === "custom" && e.customType === "tool_execution_start" && text(e.data?.toolCallId)) {
			const at = number(e.data?.timestamp) ?? date(e.timestamp);
			if (at !== null) starts.set(e.data.toolCallId, at);
		}
	}
	for (const [index, entry] of entries.entries()) {
		if (entry.type === "session") continue;
		const m = entry.type === "model_usage" ? entry : object(entry.message);
		const identity = { ...session.identity, recordId: text(entry.id) ?? `line:${index}` };
		const provenance = { ...session.provenance, locator: { file: object(session.provenance.locator).file, entryId: identity.recordId } };
		const base = { identity, provenance, origin: null };
		const at = date(entry.timestamp);
		if (m.role === "user" && !m.synthetic) {
			records.push({ ...base, kind: "user-message", at, content: content(m.content) });
		} else if (m.role === "assistant" || entry.type === "model_usage") {
			const u = usage(m.usage, "Pi: disjoint input/output/cache buckets; recorded total includes orchestration when present");
			const raw = object(m.usage), orchestration = object(raw.orchestration);
			for (const key of ["input", "output", "cacheRead"])
				if (number(orchestration[key]) !== null) u.additional[`orchestration.${key}`] = { value: orchestration[key], unit: "tokens" };
			if (number(raw.premiumRequests) !== null) u.additional.premiumRequests = { value: raw.premiumRequests, unit: "requests" };
			const start = number(m.timestamp) ?? at, duration = number(m.duration), ttft = number(m.ttft);
			const t = timing(start, null, null);
			t.durationMs = measured(duration, "Pi timing hook"); t.ttftMs = measured(ttft, "Pi timing hook");
			if (start !== null && duration !== null) t.endedAt = measured(start + duration, "Pi timestamp + timing hook");
			if (start !== null && ttft !== null) t.firstTokenAt = measured(start + ttft, "Pi timestamp + timing hook");
			const request: ModelRequest = { ...base, kind: "model-request", model: { provider: text(m.provider), model: text(m.model), api: text(m.api) },
				prompt: prompts.has(entry.parentId) ? { ...session.identity, recordId: entry.parentId } : null,
				output: content(m.content), usage: u, cost: cost(raw.cost, provenance), timing: t,
				outcome: outcome(m.stopReason, m.errorMessage, typeof m.stopReason === "string"), purpose: text(entry.purpose) };
			request.cost = estimateCost(request, cards);
			records.push(request);
			for (const rawBlock of Array.isArray(m.content) ? m.content : []) {
				const b = object(rawBlock);
				if (b.type !== "toolCall" || !text(b.id)) continue;
				const tool: ToolExecution = { ...base, kind: "tool-execution", identity: { ...session.identity, recordId: JSON.stringify([identity.recordId, "tool", b.id]) },
					request: identity, callId: b.id, name: text(b.name), arguments: "arguments" in b ? { value: b.arguments as Json } : null,
					result: null, outcome: outcome(null, null, false), timing: timing(starts.get(b.id) ?? null, null, null) };
				tools.set(b.id, tool); records.push(tool);
			}
		} else if (m.role !== "toolResult") {
			records.push({ ...base, kind: "trace-event", eventType: text(entry.customType) ?? text(entry.type) ?? "unknown",
				at: measured(at, "journal timestamp"), subject: null, data: entry as Json });
		}
	}
	for (const entry of entries) {
		const m = object(entry.message), tool = tools.get(m.toolCallId);
		if (m.role !== "toolResult" || !tool) continue;
		tool.result = content(m.content); tool.outcome = outcome(m.isError ? "error" : "stop", m.isError ? m.content : null, true);
		tool.timing = timing(tool.timing.startedAt?.value ?? null, date(entry.timestamp), null);
	}
	return records;
}

export const piAdapter: ClientAdapter = {
	descriptor: { id: "pi", name: "Pi", version: "1", contractVersion: 1 },
	async connect(config, context) {
		const options = object(config) as PiConfig;
		if (typeof options.root !== "string") throw new Error("Pi adapter requires a session root");
		const root = path.resolve(options.root), sessions = new Map<string, { session: Session; file: string }>();
		const paths = new Map<string, string>();
		let cards: RateCard[] = [];
		async function scan(dir: string, signal: AbortSignal): Promise<string[]> {
			signal.throwIfAborted();
			const entries = await fs.readdir(dir, { withFileTypes: true }).catch(error => {
				if (error.code === "ENOENT" && dir === root) return []; throw error;
			});
			const files: string[] = [];
			for (const e of entries) {
				if (e.isDirectory()) files.push(...await scan(path.join(dir, e.name), signal));
				else if (e.isFile() && e.name.endsWith(".jsonl")) files.push(path.join(dir, e.name));
			}
			return files.sort();
		}
		return { capabilities,
			async listSessions({ signal }) {
				if (options.modelsPath) {
					try {
						const catalog = object(JSON.parse(await fs.readFile(options.modelsPath, "utf8")));
						cards = Object.entries(catalog).flatMap(([provider, models]) => Object.entries(object(models)).map(([model, raw]) => {
							const c = object(raw);
							return { model: { provider, model, api: null }, rates: { input: number(c.input), output: number(c.output), cacheRead: number(c.cacheRead), cacheWrite: number(c.cacheWrite), reasoning: null },
								context: null, rateSource: "Pi model registry snapshot", retrievedAt: Date.now() };
						}));
					} catch (error) { cards = []; context.log("warn", "Pi pricing snapshot unavailable", String(error)); }
				}
				const headers = new Map<string, Record<string, any>>();
				for (const file of await scan(root, signal)) {
					signal.throwIfAborted();
					const handle = await fs.open(file, "r");
					try {
						const stat = await handle.stat(), bytes = Buffer.alloc(Math.min(stat.size, 65536));
						await handle.read(bytes, 0, bytes.length, 0);
						const line = bytes.subarray(0, bytes.indexOf(10) < 0 ? 0 : bytes.indexOf(10)).toString("utf8");
						if (!line) continue;
						const h = object(JSON.parse(line)); headers.set(file, h);
						const id = text(h.id) ?? `pi:${digest(path.relative(root, file))}`;
						if (sessions.has(id) && sessions.get(id)!.file !== file) throw new Error(`Duplicate Pi session ID: ${id}`);
						paths.set(file, id);
						const session: Session = { kind: "session", identity: { sourceId: context.source.sourceId, sessionId: id }, title: text(h.title),
							agentRole: /^__advisor(?:\.|$)/.test(path.basename(file)) ? "advisor" : path.relative(root, file).split(path.sep).length > 2 ? "subagent" : "main",
							project: text(h.cwd) ? { id: null, name: null, directory: h.cwd } : null, createdAt: date(h.timestamp), updatedAt: stat.mtimeMs, relationships: [],
							provenance: { locator: { file }, observedAt: Date.now(), revision: `${stat.ino}:${stat.size}:${stat.mtimeMs}`, adapterVersion: "1" } };
						sessions.set(id, { session, file });
					} finally { await handle.close(); }
				}
				const result: Session[] = [];
				for (const [file, header] of headers) {
					const s = sessions.get(paths.get(file)!)!.session;
					const parentFile = text(header.parentSession);
					let parent = parentFile ? paths.get(path.resolve(path.dirname(file), parentFile)) : undefined;
					if (!parentFile) {
						for (let dir = path.dirname(file); dir !== root && dir.startsWith(`${root}${path.sep}`); dir = path.dirname(dir)) {
							parent = paths.get(`${dir}.jsonl`); if (parent) break;
						}
					}
					if (parent) s.relationships.push(parentFile ? { kind: "fork", session: { ...s.identity, sessionId: parent }, forkPoint: null }
						: { kind: "subagent", session: { ...s.identity, sessionId: parent }, spawnedBy: null });
					if (s.project === null) {
						const projectRoot = path.join(root, path.relative(root, file).split(path.sep)[0]!);
						const cwd = [...headers.entries()].find(([candidate, h]) => path.dirname(candidate) === projectRoot && text(h.cwd))?.[1].cwd;
						if (typeof cwd === "string") s.project = { id: null, name: null, directory: cwd };
					}
					result.push(s);
				}
				return { sessions: result, nextCursor: null };
			},
			async readSession({ session: ref, checkpoint, signal }): Promise<SessionSnapshot> {
				const found = sessions.get(ref.sessionId);
				if (!found) throw new Error("Pi session requires rediscovery");
				const stat = await fs.stat(found.file);
				const revision = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
				found.session = { ...found.session, updatedAt: stat.mtimeMs, provenance: { ...found.session.provenance, observedAt: Date.now(), revision } };
				if (object(checkpoint).revision === revision) return { session: found.session, records: [], mode: "partial", deleted: [], checkpoint };
				const bytes = await fs.readFile(found.file, { signal });
				const parsed = parseJournal(bytes);
				const title = parsed.entries.filter(e => e.type === "session_info" && text(e.name)).at(-1)?.name;
				if (typeof title === "string") found.session = { ...found.session, title };
				const records = convertEntries(found.session, parsed.entries, cards);
				const fork = found.session.relationships.find(r => r.kind === "fork");
				if (fork) {
					const parent = sessions.get(fork.session.sessionId);
					if (parent) {
						const originals = new Set(convertEntries(parent.session, parseJournal(await fs.readFile(parent.file, { signal })).entries).map(r => r.identity.recordId));
						for (const record of records) if (originals.has(record.identity.recordId)) record.origin = { ...fork.session, recordId: record.identity.recordId };
					}
				}
				return { session: found.session, records, mode: "full", deleted: [], checkpoint: { offset: parsed.offset, revision: found.session.provenance.revision } };
			},
			async *watchChanges({ signal }) {
				// Missing roots and platforms without recursive watches still reconcile by polling.
				try {
					for await (const event of watch(root, { recursive: true, signal })) {
						const id = event.filename ? paths.get(path.join(root, String(event.filename))) : undefined;
						if (id && event.eventType === "change") yield { kind: "refresh" as const, session: { sourceId: context.source.sourceId, sessionId: id }, checkpoint: null };
						else if (!event.filename || String(event.filename).endsWith(".jsonl") || event.eventType === "rename") yield { kind: "rescan" as const, checkpoint: null };
					}
				} catch (error) {
					if (signal.aborted) return;
					context.log("warn", "Pi watch unavailable; polling continues", String(error));
					await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
				}
			},
			async close() { sessions.clear(); paths.clear(); },
		};
	},
};
