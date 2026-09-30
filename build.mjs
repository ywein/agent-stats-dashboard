import { chmod, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
await rm(dist, { recursive: true, force: true });
await build({ absWorkingDir: root, entryPoints: { index: "src/dashboard/client/index.tsx" },
	outdir: join(dist, "client"), bundle: true, platform: "browser", format: "esm", target: "es2022",
	minify: true, jsx: "automatic", loader: { ".svg": "file", ".woff2": "file" }, logLevel: "warning" });
await writeFile(join(dist, "client/index.html"), `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agent stats</title><style>:root { color-scheme: light dark; }</style><link rel="stylesheet" href="/index.css"></head>
<body><div id="root" role="status">Loading dashboard…</div><script src="/index.js" type="module"></script></body></html>\n`);
for (const [name, entry] of Object.entries({ server: "src/main.ts", pi: "src/integrations/pi/index.ts",
	opencode: "src/integrations/opencode/index.ts", "adapter-contract": "src/adapter-contract/index.ts",
	model: "src/core/model/index.ts", testing: "src/adapter-contract/testing/index.mjs", example: "examples/fixture.ts" })) {
	await build({ absWorkingDir: root, entryPoints: [entry], outfile: join(dist, `${name}.js`), bundle: true,
		platform: "node", format: "esm", target: "node22", external: ["@opencode/*", "@earendil-works/*"],
		...(name === "server" ? { banner: { js: "#!/usr/bin/env node" } } : {}), logLevel: "warning" });
}
await chmod(join(dist, "server.js"), 0o755);
console.log("Built one server, shared UI, client integrations and adapter API in dist/");
