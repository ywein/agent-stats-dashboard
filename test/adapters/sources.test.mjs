import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSources } from "../../src/adapters/sources.ts";

test("external adapters load without a built-in client branch and reject incompatible APIs", async t => {
	const dir = await mkdtemp(join(tmpdir(), "external-adapter-")), file = join(dir, "sources.json");
	t.after(() => rm(dir, { recursive: true, force: true }));
	const entry = { sourceId: "external", clientType: "fixture", label: "External", adapter: "agent-stats/example", config: {} };
	// Package resolution is relative to the configuration file, just like Node.
	entry.adapter = new URL("../../examples/fixture.ts", import.meta.url).pathname;
	await writeFile(file, JSON.stringify([entry]));
	const [registration] = await loadSources(file);
	assert.equal(registration.adapter.descriptor.id, "fixture");
	const connection = await registration.adapter.connect({}, { source: registration.source, signal: new AbortController().signal, log() {} });
	t.after(() => connection.close());
	const page = await connection.listSessions({ cursor: null, updatedSince: null, signal: new AbortController().signal });
	assert.equal(page.sessions[0].identity.sourceId, "external");
	await writeFile(join(dir, "future.mjs"), 'export default { descriptor: { id: "future", contractVersion: 99 } };');
	await writeFile(file, JSON.stringify([{ ...entry, adapter: "./future.mjs" }]));
	await assert.rejects(loadSources(file), /external.*future.*API 99.*upgrade/);
});

test("source configuration resolves Pi paths and rejects ambiguous identities", async t => {
	const dir = await mkdtemp(join(tmpdir(), "source-config-")), file = join(dir, "sources.json");
	t.after(() => rm(dir, { recursive: true, force: true }));
	const entries = [{ sourceId: "pi-one", clientType: "pi", label: "Pi one", config: { root: "sessions", modelsPath: "models.json" } },
		{ sourceId: "oc-one", clientType: "opencode", label: "OpenCode one", config: { url: "http://localhost:4096", headers: { Authorization: "fixture" } } }];
	await writeFile(file, JSON.stringify(entries));
	const sources = await loadSources(file);
	assert.equal(sources[0].config.root, join(dir, "sessions"));
	assert.equal(sources[0].config.modelsPath, join(dir, "models.json"));
	assert.equal(sources[1].adapter.descriptor.id, "opencode");
	assert.equal(JSON.stringify(sources[1].source).includes("Authorization"), false);
	await writeFile(file, JSON.stringify([entries[0], entries[0]]));
	await assert.rejects(loadSources(file), /unique/);
	await writeFile(file, JSON.stringify([{ ...entries[0], config: {} }]));
	await assert.rejects(loadSources(file), /root is required/);
	await writeFile(file, "[]");
	await assert.rejects(loadSources(file), /nonempty array/);
});
