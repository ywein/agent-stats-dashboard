import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { assertAdapterCompatible } from "../adapter-contract/index.ts";
import type { SourceRegistration } from "../core/ingestion/index.ts";

/** Launcher configuration only; the runtime remains independent of adapter types. */
export async function loadSources(file: string): Promise<SourceRegistration[]> {
	const entries: unknown = JSON.parse(await readFile(file, "utf8"));
	if (!Array.isArray(entries) || !entries.length) throw new Error("Sources file must contain a nonempty array");
	const ids = new Set<string>();
	return Promise.all(entries.map(async (entry, index) => {
		if (!entry || typeof entry !== "object" || typeof entry.sourceId !== "string" || !entry.sourceId.trim() || ids.has(entry.sourceId)) throw new Error(`Source ${index}: sourceId must be unique and nonempty`);
		ids.add(entry.sourceId);
		if (typeof entry.label !== "string" || !entry.label.trim()) throw new Error(`Source ${index}: label is required`);
		if (!entry.config || typeof entry.config !== "object" || Array.isArray(entry.config)) throw new Error(`Source ${index}: config must be an object`);
		const config = { ...entry.config };
		if (entry.adapter !== undefined) {
			if (typeof entry.adapter !== "string" || !entry.adapter.trim()) throw new Error(`Source ${index}: adapter must be a module path or package name`);
			if (typeof entry.clientType !== "string" || !entry.clientType.trim()) throw new Error(`Source ${index}: clientType is required`);
			try {
				const specifier = entry.adapter.startsWith(".") || entry.adapter.startsWith("/")
					? pathToFileURL(resolve(dirname(file), entry.adapter)).href
					: pathToFileURL(createRequire(resolve(file)).resolve(entry.adapter)).href;
				const { default: adapter } = await import(specifier);
				assertAdapterCompatible(adapter);
				// Actual capabilities are supplied by connect; conservative until then.
				const capabilities = { requestDetails: false, toolResults: false, traceEvents: false, ttft: false, recordedCosts: false, pricingEstimates: false };
				return { source: { sourceId: entry.sourceId, clientType: entry.clientType, label: entry.label, capabilities }, adapter, config };
			} catch (error) { throw new Error(`Source "${entry.sourceId}" adapter "${entry.adapter}": ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
		}
		if (entry.clientType === "pi") {
			if (typeof config.root !== "string" || !config.root) throw new Error(`Source ${index}: Pi config.root is required`);
			config.root = resolve(dirname(file), config.root);
			if (config.modelsPath !== undefined) {
				if (typeof config.modelsPath !== "string") throw new Error(`Source ${index}: modelsPath must be a string`);
				config.modelsPath = resolve(dirname(file), config.modelsPath);
			}
			const { piAdapter: adapter, capabilities } = await import("./pi.ts");
			return { source: { sourceId: entry.sourceId, clientType: entry.clientType, label: entry.label, capabilities }, adapter, config };
		}
		if (entry.clientType === "opencode") {
			if (config.url !== undefined && (typeof config.url !== "string" || !/^https?:\/\//.test(config.url))) throw new Error(`Source ${index}: url must be HTTP or HTTPS`);
			if (config.headers !== undefined && (!config.headers || typeof config.headers !== "object" || Array.isArray(config.headers) || Object.values(config.headers).some(value => typeof value !== "string"))) throw new Error(`Source ${index}: headers must contain string values`);
			const { openCodeAdapter: adapter, capabilities } = await import("./opencode.ts");
			return { source: { sourceId: entry.sourceId, clientType: entry.clientType, label: entry.label, capabilities }, adapter, config };
		}
		throw new Error(`Source ${index}: unsupported clientType`);
	}));
}
