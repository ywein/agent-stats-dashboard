import { fileURLToPath } from "node:url";
import { Plugin } from "@opencode/plugin";
import { createDashboardLauncher, openDashboardBrowser } from "../../dashboard/launcher.ts";
import { dataDirectory } from "../../paths.ts";

export default Plugin.define({
	id: "agent-stats",
	async setup(ctx) {
		await ctx.command.transform(editor => editor.add({
			name: "stats",
			description: "Open the local OpenCode usage dashboard",
			async execute() {
				try {
					const launcher = createDashboardLauncher({ app: "agent-stats",
						basePort: Number(process.env.AGENT_STATS_PORT ?? process.env.OPENCODE_STATS_PORT ?? 3848),
						serverEntry: fileURLToPath(new URL("./server.js", import.meta.url)), dataDirectory: dataDirectory(),
						serverArguments: ["--client", "opencode"], sourcesFile: process.env.AGENT_STATS_SOURCES ?? process.env.OPENCODE_STATS_SOURCES,
						sourceId: process.env.AGENT_STATS_SOURCE_ID ?? process.env.OPENCODE_STATS_SOURCE_ID });
					const url = await launcher.ensure();
					console.log(`OpenCode stats: ${url}`);
					await openDashboardBrowser(url);
				} catch (error) {
					console.error(`Stats dashboard failed: ${error instanceof Error ? error.message : String(error)}`);
					throw error;
				}
			},
		}));
	},
});
