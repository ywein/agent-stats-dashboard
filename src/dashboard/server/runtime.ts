import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { Readable } from "node:stream";
import { IngestionCoordinator, type SourceRegistration } from "../../core/ingestion/index.ts";
import { IngestionStore } from "../../core/storage/index.ts";
import type { DashboardConfig } from "../config.ts";
import { createIngestionStatusBridge } from "./ingestion-status.ts";
import { DashboardQueries } from "./queries.ts";
import { buildTrace, listSessions } from "./traces.ts";
import { frustration, job, noJudge } from "./frustration.ts";
import { metricCoverage } from "./coverage.ts";

export interface RuntimeOptions {
	app: string;
	launcherKey?: string;
	config: DashboardConfig;
	database: string;
	staticDirectory: string;
	sources: SourceRegistration[];
	port: number;
	hostname?: string;
	pollIntervalMs?: number;
}
export async function startDashboard(options: RuntimeOptions) {
	await fs.mkdir(path.dirname(options.database), { recursive: true });
	const store = new IngestionStore(options.database);
	let ingestion: IngestionCoordinator;
	try {
		ingestion = new IngestionCoordinator(store, options.sources, { pollIntervalMs: options.pollIntervalMs ?? 30_000,
			log: (level, message, details) => { if (level === "warn" || level === "error") console.error(message, details ?? ""); } });
	} catch (error) { store.close(); throw error; }
	const live = createIngestionStatusBridge(ingestion);
	const cached = new Map<string, DashboardQueries>();
	let version = -1, lastActivity = Date.now();
	const sources = () => {
		const known = new Map(store.listSources().map(source => [source.sourceId, source]));
		for (const { source } of options.sources) if (!known.has(source.sourceId)) known.set(source.sourceId, source);
		return [...known.values()];
	};
	const queries = (ids: string[]) => {
		const current = ingestion.status().version;
		if (current !== version) { cached.clear(); version = current; }
		const key = JSON.stringify(ids.sort());
		if (!cached.has(key)) {
			if (cached.size >= 128) cached.clear();
			cached.set(key, new DashboardQueries(store, new Set(ids)));
		}
		return cached.get(key)!;
	};
	const streams = new Set<http.ServerResponse>();
	const limit = (url: URL, fallback: number) => {
		const n = Number(url.searchParams.get("limit") ?? fallback);
		return Number.isFinite(n) && n > 0 ? Math.min(10_000, Math.floor(n)) : fallback;
	};
	async function route(req: http.IncomingMessage, url: URL): Promise<Response> {
		const pathname = url.pathname, range = url.searchParams.get("range");
		if (pathname === "/api/health") return Response.json({ app: options.app, version: 1, pid: process.pid, launcherKey: options.launcherKey });
		if (pathname === "/api/config") return Response.json(options.config);
		if (pathname === "/api/status") return Response.json(live.status());
		const allSources = sources();
		const sourceId = url.searchParams.get("sourceId"), clientType = url.searchParams.get("clientType");
		if (sourceId !== null && !allSources.some(s => s.sourceId === sourceId)) return Response.json({ error: "Unknown source" }, { status: 400 });
		if (clientType !== null && !allSources.some(s => s.clientType === clientType)) return Response.json({ error: "Unknown client type" }, { status: 400 });
		const selected = allSources.filter(s => (sourceId === null || s.sourceId === sourceId) && (clientType === null || s.clientType === clientType));
		if (["/api/sync", "/api/frustration/judge", "/api/frustration/cancel"].includes(pathname)) {
			if (req.method !== "POST") return Response.json({ error: "POST required" }, { status: 405 });
			if (req.headers["x-dashboard-action"] !== "1") return Response.json({ error: "X-Dashboard-Action: 1 header required" }, { status: 403 });
			if (pathname === "/api/frustration/judge") return Response.json({ error: noJudge.reason }, { status: 503 });
			if (pathname === "/api/frustration/cancel") return Response.json(job);
			const configured = new Set(options.sources.map(s => s.source.sourceId));
			if (sourceId !== null && !configured.has(sourceId)) return Response.json({ error: "Source is not configured for refresh" }, { status: 409 });
			for (const source of selected) if (configured.has(source.sourceId)) void live.requestSync(source.sourceId).catch(() => {});
			return Response.json(live.status(), { status: 202 });
		}
		if (pathname.startsWith("/api/")) {
			const q = queries(selected.map(s => s.sourceId));
			if (pathname === "/api/sources") return Response.json({ sources: allSources.map(s => ({ ...s, status: ingestion.status().sources.find(status => status.sourceId === s.sourceId) ?? null })),
				selectedSourceIds: selected.map(s => s.sourceId), coverage: metricCoverage(q.select(range)) });
			if (pathname === "/api/stats/recent") return Response.json(q.recent(limit(url, 50)));
			if (pathname === "/api/stats/errors") return Response.json(q.recent(limit(url, 100), true, range));
			if (pathname === "/api/stats/tools") return Response.json(q.toolDashboard(range));
			if (pathname === "/api/stats/providers") return Response.json(q.providers(range));
			if (pathname === "/api/stats/provider-windows") return Response.json({ windowInsights: [], usageSeries: [] });
			if (pathname === "/api/stats/frustration") return Response.json(frustration(q, range));
			if (pathname === "/api/frustration/estimate") return Response.json(noJudge);
			if (pathname.startsWith("/api/request/")) {
				const id = Number(pathname.slice("/api/request/".length));
				const details = Number.isSafeInteger(id) ? q.details(id) : null;
				return details ? Response.json(details) : new Response("Not Found", { status: 404 });
			}
			if (pathname === "/api/sessions") return Response.json(listSessions(q, limit(url, 100), url.searchParams.get("q") ?? ""));
			if (pathname === "/api/session/trace" || pathname === "/api/session/entry") {
				const key = url.searchParams.get("file");
				if (!key) return Response.json({ error: "file required" }, { status: 400 });
				if (pathname.endsWith("/entry")) {
					const id = url.searchParams.get("id");
					if (!id) return Response.json({ error: "id required" }, { status: 400 });
					const entry = q.forSession(key).find(r => r.identity.recordId === id);
					return entry ? Response.json({ entry }) : new Response("Not Found", { status: 404 });
				}
				const trace = buildTrace(q, key);
				if (!trace) return new Response("Not Found", { status: 404 });
				const etag = `"normalized-1:${trace.etag}"`;
				return req.headers["if-none-match"] === etag ? new Response(null, { status: 304 }) : Response.json(trace, { headers: { ETag: etag } });
			}
			const d = q.dashboard(range);
			const responses: Record<string, unknown> = { "/api/stats": d, "/api/stats/overview": { overall: d.overall, byAgentType: d.byAgentType, timeSeries: d.timeSeries, spend: d.spend },
				"/api/stats/model-dashboard": { byModel: d.byModel, modelSeries: d.modelSeries, modelPerformanceSeries: d.modelPerformanceSeries },
				"/api/stats/costs": { costSeries: d.costSeries, spend: d.spend }, "/api/stats/models": d.byModel, "/api/stats/folders": d.byFolder, "/api/stats/timeseries": d.timeSeries };
			return pathname in responses ? Response.json(responses[pathname]) : new Response("Not Found", { status: 404 });
		}
		const relative = path.normalize(pathname).replace(/^[/\\]+/, "");
		const candidates = relative && !relative.startsWith("..") ? [relative, "index.html"] : ["index.html"];
		for (const file of candidates) {
			try {
				const bytes = await fs.readFile(path.join(options.staticDirectory, file));
				const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
				return new Response(bytes, { headers: { "Content-Type": mime[path.extname(file)] ?? "application/octet-stream" } });
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		return new Response("Dashboard client not built", { status: 404 });
	}
	const server = http.createServer(async (req, res) => {
		const port = (server.address() as { port: number }).port;
		if (![ `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}` ].includes(req.headers.host?.toLowerCase() ?? "")) { res.writeHead(403).end("Forbidden host"); return; }
		lastActivity = Date.now();
		try {
			const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
			if (url.pathname === "/api/events") {
				res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
				streams.add(res);
				const send = (status: ReturnType<typeof live.status>) => {
					if (res.writableLength > 65536) { res.destroy(); return; }
					res.write(`data: ${JSON.stringify(status)}\n\n`);
				};
				send(live.status());
				let pending: ReturnType<typeof setTimeout> | null = null;
				const unsubscribe = live.subscribe(() => { pending ??= setTimeout(() => { pending = null; send(live.status()); }, 200); });
				const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
				res.on("close", () => { unsubscribe(); if (pending) clearTimeout(pending); clearInterval(heartbeat); streams.delete(res); lastActivity = Date.now(); });
				return;
			}
			const response = await route(req, url);
			res.writeHead(response.status, Object.fromEntries(response.headers));
			if (!response.body) { res.end(); return; }
			const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
			res.on("close", () => stream.destroy()); stream.on("error", () => res.destroy()); stream.pipe(res);
		} catch (error) { console.error("Dashboard request failed", error); if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Dashboard request failed" })); }
	});
	server.requestTimeout = 0;
	try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, options.hostname ?? "127.0.0.1", () => { server.off("error", reject); resolve(); }); }); }
	catch (error) { store.close(); throw error; }
	ingestion.start();
	let stopping: Promise<void> | null = null;
	return { hostname: options.hostname ?? "127.0.0.1", port: (server.address() as { port: number }).port, idleMs: () => streams.size ? 0 : Date.now() - lastActivity,
		stop(): Promise<void> { return stopping ??= (async () => { const closed = new Promise<void>(resolve => server.close(() => resolve())); for (const stream of streams) stream.end(); server.closeAllConnections(); await ingestion.stop(); await closed; store.close(); })(); } };
}
