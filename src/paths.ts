import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function agentDirectory(): string {
	const value = process.env.PI_STATS_AGENT_DIR || process.env.PI_CODING_AGENT_DIR;
	return value ? resolve(value.replace(/^~(?=$|[\\/])/, homedir())) : join(homedir(), ".pi", "agent");
}
export function dataDirectory(): string {
	const value = process.env.AGENT_STATS_DIR;
	return value ? resolve(value.replace(/^~(?=$|[\\/])/, homedir())) : join(homedir(), ".local", "share", "agent-stats");
}
export function piSourceId(root: string): string {
	return `pi:${createHash("sha1").update(root).digest("hex").slice(0, 16)}`;
}
