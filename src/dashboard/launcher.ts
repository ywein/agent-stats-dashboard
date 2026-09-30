import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export interface LauncherOptions {
	app: string;
	basePort: number;
	serverEntry: string;
	dataDirectory: string;
	sourcesFile?: string;
	sourceId?: string;
	env?: NodeJS.ProcessEnv;
	serverArguments?: string[];
}
type Probe = { kind: "ours"; pid: number } | { kind: "free" | "taken" };

/** Client-neutral process lifecycle; data access stays in adapters. */
export function createDashboardLauncher(options: LauncherOptions) {
	if (!Number.isInteger(options.basePort) || options.basePort < 1 || options.basePort > 65526) throw new Error("Dashboard base port must be an integer from 1 to 65526");
	const sourcesFile = options.sourcesFile ? resolve(options.sourcesFile) : undefined;
	const launcherKey = createHash("sha256").update(JSON.stringify([resolve(options.dataDirectory),
		options.env?.AGENT_STATS_DB ?? process.env.AGENT_STATS_DB, sourcesFile ? null : options.env,
		sourcesFile, sourcesFile ? readFileSync(sourcesFile, "utf8") : null, sourcesFile ? null : options.serverArguments])).digest("hex");
	async function probe(port: number): Promise<Probe> {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
			const body = await response.json() as { app?: string; pid?: number; launcherKey?: string };
			return response.ok && body.app === options.app && body.launcherKey === launcherKey && Number.isSafeInteger(body.pid) && body.pid! > 0
				? { kind: "ours", pid: body.pid! } : { kind: "taken" };
		} catch (error) {
			return { kind: (error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED" ? "free" : "taken" };
		}
	}
	function url(port: number) {
		const value = new URL(`http://127.0.0.1:${port}`);
		if (options.sourceId) value.hash = `/?${new URLSearchParams({ sourceId: options.sourceId })}`;
		return value.href;
	}
	async function find() {
		for (let port = options.basePort; port < options.basePort + 10; port++) {
			const state = await probe(port);
			if (state.kind === "ours") return { port, pid: state.pid };
		}
		return null;
	}
	async function ensure(): Promise<string> {
		for (let port = options.basePort; port < options.basePort + 10; port++) {
			const state = await probe(port);
			if (state.kind === "ours") return url(port);
			if (state.kind === "taken") continue;
			if (!existsSync(options.serverEntry)) throw new Error(`${options.serverEntry} missing; run npm run build in the package`);
			mkdirSync(options.dataDirectory, { recursive: true });
			const logPath = join(options.dataDirectory, "server.log");
			const log = openSync(logPath, "a");
			const processState: { failure: Error | null; exited: boolean } = { failure: null, exited: false };
			try {
				const child = spawn(process.versions.bun ? "node" : process.execPath,
					["--no-warnings", options.serverEntry, "--port", String(port), "--launcher-key", launcherKey, ...(options.serverArguments ?? []), ...(sourcesFile ? ["--sources", sourcesFile] : [])],
					{ detached: true, stdio: ["ignore", log, log], env: { ...process.env, ...options.env } });
				child.on("error", error => { processState.failure = error; });
				child.on("exit", () => { processState.exited = true; });
				child.unref();
			} finally { closeSync(log); }
			for (let attempt = 0; attempt < 100; attempt++) {
				await delay(200);
				if (processState.failure || processState.exited) throw new Error(`Dashboard failed to start${processState.failure ? `: ${processState.failure.message}` : ""}; see ${logPath}`);
				const started = await probe(port);
				if (started.kind === "ours") return url(port);
				if (started.kind === "taken") break;
			}
			throw new Error(`Dashboard did not start; see ${logPath}`);
		}
		throw new Error(`No free dashboard port in ${options.basePort}-${options.basePort + 9}`);
	}
	return { ensure, find };
}

export async function openDashboardBrowser(url: string): Promise<void> {
	const [command, args] = process.platform === "darwin" ? ["open", [url]] :
		process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { stdio: "ignore" });
		child.on("error", reject);
		child.on("exit", code => code === 0 ? resolve() : reject(new Error(`Could not open browser (exit ${code}); open ${url} manually`)));
	});
}
