import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, access } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";

test("universal package exposes both integrations and has no workspace remnants", async () => {
	const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(manifest.name, "agent-stats");
	assert.equal(manifest.workspaces, undefined);
	assert.deepEqual(manifest.pi.extensions, ["./dist/pi.js"]);
	assert.equal(manifest.exports["."], "./dist/opencode.js");
	assert.ok(!Object.keys(manifest.dependencies).some(name => name.startsWith("@agent-stats/")));
	for (const path of ["../stats", "../opencode-stats", "../packages"]) await assert.rejects(access(new URL(path, import.meta.url)), { code: "ENOENT" });
	const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
	assert.ok(!Object.keys(lock.packages).some(path => /^(packages\/|stats$|opencode-stats$)/.test(path)));
});

test("one CLI accepts both clients, documents combined mode and rejects unknown clients", () => {
	const server = new URL("../dist/server.js", import.meta.url).pathname;
	const help = execFileSync(process.execPath, [server, "--help"], { encoding: "utf8" });
	assert.match(help, /--client pi\|opencode\|all/);
	const invalid = spawnSync(process.execPath, [server, "--client", "unknown"], { encoding: "utf8" });
	assert.notEqual(invalid.status, 0);
	assert.match(invalid.stderr, /--client must be pi, opencode or all/);
});
