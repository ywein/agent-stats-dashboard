import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDashboard } from "./dashboard/server/runtime.ts";
import { piAdapter, capabilities as piCapabilities } from "./adapters/pi.ts";
import { openCodeAdapter, capabilities as openCodeCapabilities } from "./adapters/opencode.ts";
import { loadSources } from "./adapters/sources.ts";
import { dashboardConfig } from "./config.ts";
import { agentDirectory, dataDirectory, piSourceId } from "./paths.ts";
import type { SourceRegistration } from "./core/ingestion/index.ts";

const { values } = parseArgs({ options: {
	port: { type: "string", default: process.env.AGENT_STATS_PORT ?? "3848" },
	host: { type: "string", default: "127.0.0.1" }, sources: { type: "string" },
	client: { type: "string", default: "all" }, "launcher-key": { type: "string" }, help: { type: "boolean" },
} });
if (values.help) {
	console.log("Usage: agent-stats [--client pi|opencode|all] [--sources sources.json] [--port 3848] [--host 127.0.0.1]");
	process.exit(0);
}
if (!["pi", "opencode", "all"].includes(values.client)) throw new Error("--client must be pi, opencode or all");
const root = join(agentDirectory(), "sessions");
const defaults: SourceRegistration[] = [];
if (values.client !== "opencode") defaults.push({ source: { sourceId: piSourceId(root), clientType: "pi", label: "Pi", capabilities: piCapabilities },
	adapter: piAdapter, config: { root, modelsPath: join(agentDirectory(), "pi-stats-web", "models.json") } });
if (values.client !== "pi") defaults.push({ source: { sourceId: "opencode:local", clientType: "opencode", label: "OpenCode", capabilities: openCodeCapabilities },
	adapter: openCodeAdapter, config: {} });
const idleMs = Number(process.env.AGENT_STATS_IDLE_MS ?? 15 * 60 * 1000);
if (!Number.isFinite(idleMs) || idleMs < 0) throw new Error("AGENT_STATS_IDLE_MS must be a nonnegative number");
const sourceFile = values.sources || process.env.AGENT_STATS_SOURCES;
const sources = sourceFile ? await loadSources(sourceFile) : defaults;
// Separate configurations must not run competing coordinators in the same cache.
const profile = createHash("sha256").update(JSON.stringify(sources.map(({ source, adapter, config }) =>
	({ sourceId: source.sourceId, adapter: adapter.descriptor.id, config })))).digest("hex").slice(0, 16);
const handle = await startDashboard({ app: "agent-stats", config: dashboardConfig,
	launcherKey: values["launcher-key"], database: process.env.AGENT_STATS_DB || join(dataDirectory(), `stats.${profile}.normalized-v1.db`),
	staticDirectory: join(dirname(fileURLToPath(import.meta.url)), "client"), port: Number(values.port), hostname: values.host,
	sources });
console.log(JSON.stringify({ url: `http://${handle.hostname}:${handle.port}`, pid: process.pid }));
let stopping = false;
async function shutdown() {
	if (stopping) return;
	stopping = true; await handle.stop(); process.exit(0);
}
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
if (idleMs > 0) setInterval(() => { if (handle.idleMs() > idleMs) void shutdown(); }, 30_000).unref();
