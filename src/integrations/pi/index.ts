// pi-stats-web: `/stats` opens a local web dashboard over ~/.pi/agent/sessions.
// The dashboard runs as a detached node process (dist/server.js) so ingest
// never blocks pi; it exits on its own once no dashboard tab is open.
import { createDashboardLauncher, openDashboardBrowser } from "../../dashboard/launcher.ts";
import { dataDirectory } from "../../paths.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

const APP_ID = "agent-stats";
const BASE_PORT = Number(process.env.AGENT_STATS_PORT ?? process.env.PI_STATS_PORT ?? 3848);
const SERVER_ENTRY = fileURLToPath(new URL("./server.js", import.meta.url));

const dataDir = () => path.join(getAgentDir(), "pi-stats-web");

const launcher = () => createDashboardLauncher({ app: APP_ID, basePort: BASE_PORT,
	serverEntry: SERVER_ENTRY, dataDirectory: dataDirectory(), sourcesFile: process.env.AGENT_STATS_SOURCES ?? process.env.PI_STATS_SOURCES,
	sourceId: process.env.AGENT_STATS_SOURCE_ID ?? process.env.PI_STATS_SOURCE_ID, serverArguments: ["--client", "pi"],
	env: { PI_STATS_AGENT_DIR: getAgentDir() } });

/** Pricing for the server: pi's registry, including custom providers. */
function writeModelsSnapshot(models: Array<{ provider: string; id: string; cost?: unknown }>): void {
	const catalog: Record<string, Record<string, unknown>> = {};
	for (const m of models) {
		if (!m.cost) continue;
		(catalog[m.provider] ??= {})[m.id] = m.cost;
	}
	fs.mkdirSync(dataDir(), { recursive: true });
	fs.writeFileSync(path.join(dataDir(), "models.json"), JSON.stringify(catalog));
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("stats", {
		description: "Open the usage stats dashboard in the browser (`/stats stop` stops it)",
		getArgumentCompletions: prefix =>
			["stop", "url"].filter(a => a.startsWith(prefix)).map(a => ({ value: a, label: a })),
		handler: async (args, ctx) => {
			const arg = args.trim();
			try {
				if (arg === "stop") {
					const server = await launcher().find();
					if (!server) return ctx.ui.notify("Stats dashboard is not running", "info");
					process.kill(server.pid, "SIGTERM");
					return ctx.ui.notify(`Stopped stats dashboard on port ${server.port}`, "info");
				}
				writeModelsSnapshot(ctx.modelRegistry.getAll());
				const url = await launcher().ensure();
				if (arg !== "url") await openDashboardBrowser(url);
				ctx.ui.notify(`Stats dashboard: ${url}`, "info");
			} catch (err) {
				ctx.ui.notify(`Stats dashboard failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	// pi doesn't record request latency. Stamp `duration`/`ttft` (ms, same
	// fields omp writes) onto each assistant message so they land in the
	// transcript and the dashboard's latency/TTFT/TPS columns fill in.
	let requestStart = 0;
	let firstToken = 0;
	pi.on("before_provider_request", () => {
		// Fires per attempt; retries restart the clock.
		requestStart = Date.now();
		firstToken = 0;
	});
	pi.on("message_update", event => {
		if (!firstToken && requestStart && event.assistantMessageEvent.type.endsWith("_delta")) firstToken = Date.now();
	});
	pi.on("message_end", event => {
		const message = event.message;
		if (message.role !== "assistant" || !requestStart || "duration" in message) return;
		const timed = {
			...message,
			duration: Date.now() - requestStart,
			...(firstToken ? { ttft: firstToken - requestStart } : {}),
		};
		requestStart = 0;
		firstToken = 0;
		return { message: timed };
	});
}
