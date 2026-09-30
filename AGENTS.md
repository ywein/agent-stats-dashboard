# Repository guidance

## Commands and verification

- Use Node 24+ for development/tests: tests import `.ts` directly and the OpenCode fixture uses `node:module` `registerHooks`. The bundled server supports Node 22.13+ and uses built-in `node:sqlite`.
- From the root: `npm install`, then `npm run build && npm run check && npm test`. Build before tests that launch `dist/server.js` (`layout`, Pi e2e); `npm test` itself does not build first.
- Focused unit test: `node --test test/core/ingestion.test.mjs`. Filter by name with `node --test --test-name-pattern='pattern' test/core/ingestion.test.mjs` (flags precede the file).
- `npm run check` is TypeScript checking only. There are no configured lint/formatter scripts or dev/watch server; rebuild to update served browser assets.
- `test/dashboard.test.mjs` is an expensive packaging/HTTP contract test: it runs `npm pack`, installs production dependencies in a temporary directory, deletes that installed package's `dist`, then rebuilds it. It needs npm registry access unless dependencies are cached; OpenCode itself is replaced by a fixture HTTP service.
- Refresh HTTP examples only for an intentional contract change: `UPDATE_CONTRACT=1 node --test test/dashboard.test.mjs`. This rewrites `test/contract/pi.json` and `test/contract/opencode.json`; see `test/contract/README.md`.
- `npm pack` triggers the `prepack` build. `build.mjs` deletes and recreates all of `dist/`; never put hand-maintained files there.

## Architecture boundaries

- This is one npm package, not a monorepo. Ignored `.legacy/` contains old repositories/task metadata, not active implementation.
- `src/main.ts` wires sources into `src/dashboard/server/runtime.ts`; the runtime owns the ingestion coordinator, SQLite store, HTTP API and shared UI serving. Both client integrations use `src/dashboard/launcher.ts` to start the same built server, not separate backends.
- Package default export is the OpenCode plugin (`dist/opencode.js`), not the CLI. Pi metadata loads `dist/pi.js`; the CLI runs `dist/server.js`. `build.mjs` is the entrypoint map.
- Client-specific parsing belongs in `src/adapters/`. Core ingestion/storage and dashboard queries consume normalized records; external adapters should work without adding client-specific dashboard branches. Public adapter APIs are declared in `package.json` exports; see `docs/ADAPTER-AUTHORING.md` and `examples/fixture.ts`.
- Preserve unknown metrics as `null`, not zero. Recorded cost totals take precedence; estimates contribute only when recorded totals are absent (`src/core/aggregation/index.ts`).
- API `sessionFile`/`file` values are opaque encoded source/session identities, not filesystem paths. URL-encode them; mutating endpoints require `POST` with `X-Dashboard-Action: 1` (`test/contract/README.md`).

## Data and runtime safety

- `node dist/server.js` defaults to both clients and can discover/start the user's local OpenCode service. For fixture work, use an explicit `--sources` file; `--client pi` avoids OpenCode discovery but still reads the default Pi sessions unless overridden.
- Isolate manual runs with `AGENT_STATS_DIR` and, if needed, `AGENT_STATS_DB`; for Pi fixtures set `PI_STATS_AGENT_DIR`. Use `--port 0` for an ephemeral port and `AGENT_STATS_IDLE_MS=0` to disable idle shutdown. The server prints its URL as JSON on stdout.
- Normalized databases contain prompts, responses and tool results. Never run competing coordinators against the same cache file; default filenames are configuration-profile-specific, but `AGENT_STATS_DB` bypasses that isolation. Do not mutate client databases or legacy caches.
- Source-file Pi paths and external adapter module paths resolve relative to the sources file, not the shell's working directory (`src/adapters/sources.ts`). `--sources` takes precedence over `AGENT_STATS_SOURCES`.
