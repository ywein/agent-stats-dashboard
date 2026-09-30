# Agent stats

One universal plugin and standalone dashboard for coding-agent usage. Pi and
OpenCode adapters feed the same ingestion engine, SQLite storage, HTTP backend
and React UI. This is a **single npm package**, not a workspace of per-client apps.

## Develop

Requires Node 22.13+ for the bundled server. Use Node 24+ for the test-only OpenCode
discovery hook and direct TypeScript test execution.

```sh
cd ~/Code/agent-stats
npm install
npm run build
npm run check
npm test
```

## Run

```sh
node dist/server.js                      # Both Pi and local OpenCode sources
node dist/server.js --client pi          # Pi only
node dist/server.js --client opencode    # OpenCode only
node dist/server.js --sources sources.json
```

The same `dist/server.js` serves all modes. Default address: `127.0.0.1:3848`.
The server prints its URL when ready. OpenCode discovers or starts its V2 service;
one source's failure does not block other sources. See [source configuration and
metric coverage](docs/SOURCES.md) to combine multiple roots/servers or load an
external adapter.

## Client integrations

### Pi

Load this package with Pi's package manager, or use the built extension locally:

```sh
pi --extension /Users/eugene/Code/agent-stats/dist/pi.js
```

`/stats` opens the dashboard; `/stats url` prints its URL; `/stats stop` stops it.
The package's `pi.extensions` metadata points to `dist/pi.js`.
See [Pi integration and timing hooks](docs/PI.md).

### OpenCode V2

Add the package directory to your OpenCode configuration's `plugins` array,
preserving existing entries:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/Users/eugene/Code/agent-stats"],
}
```

The package's default export is the OpenCode plugin (`dist/opencode.js`);
reload OpenCode, then run `/stats`. See [OpenCode integration](docs/OPENCODE.md).
Each client defaults to its own source; use `AGENT_STATS_SOURCES` for a combined
configuration. Both entrypoints launch the same server, with no per-client build.

## Configuration and data

| Variable | Purpose |
|---|---|
| `AGENT_STATS_PORT` | CLI/integration base port (default 3848) |
| `AGENT_STATS_DIR` | Cache/log directory (default `~/.local/share/agent-stats`) |
| `AGENT_STATS_DB` | Explicit SQLite cache path |
| `AGENT_STATS_SOURCES` | Source file; `--sources` takes precedence |
| `AGENT_STATS_SOURCE_ID` | Source selected when `/stats` opens |
| `AGENT_STATS_IDLE_MS` | Idle timeout; default 900000, `0` disables it |
| `PI_STATS_AGENT_DIR` / `PI_CODING_AGENT_DIR` | Default Pi agent directory |

Each source configuration gets a separate `stats.<profile>.normalized-v1.db`
cache, preventing different configurations from sharing ingestion checkpoints.
If you override `AGENT_STATS_DB`, do not run competing dashboards on that file.
The normalized cache contains prompts, responses and tool results. It is local
dashboard data, not a client database. Old Pi/OpenCode dashboard caches and source
data remain untouched; see [migration and accounting corrections](docs/MIGRATION.md).
Older `PI_STATS_PORT` / `OPENCODE_STATS_PORT`, source-file and source-selection
variables remain integration fallbacks. Use the `AGENT_STATS_*` settings for new
configuration.

## Layout

```text
agent-stats/
  src/
    dashboard/client/       React UI and charts
    dashboard/server/       Shared HTTP runtime and queries
    core/                   Model, ingestion, storage, aggregation, pricing
    adapter-contract/       Versioned adapter API and contract test helpers
    adapters/               Pi and OpenCode data adapters; source loader
    integrations/pi/        Pi /stats command and optional timing hooks
    integrations/opencode/  OpenCode /stats command
    main.ts                 One standalone server entrypoint
  examples/                 Minimal client-independent adapter
  test/                     Unit, API, lifecycle and isolated-package tests
  docs/                     Architecture, adapter guide and integration guides
  dist/                     One generated distribution
  package.json              One installable package
```

The old `stats/`, `opencode-stats/` and `packages/` layout has been removed.
Their Git histories and Pi task metadata are preserved in ignored `.legacy/`
directories; they are not part of the package or active source tree.

## Distribution and adapter development

```sh
npm pack
# Install the resulting agent-stats-0.1.0.tgz outside this project:
npm install /absolute/path/to/agent-stats-0.1.0.tgz
node node_modules/agent-stats/dist/server.js --client pi
```

One tarball includes the server, browser assets, both integrations and the adapter
API/example/tests. It runs without sibling packages or an install-time build.
The CLI is also available as `agent-stats` after installation. The tests install
that tarball outside this project, rebuild it independently and exercise both
adapters and the external-adapter path.

Public adapter-author entrypoints: `agent-stats/adapter-contract`,
`agent-stats/model`, `agent-stats/testing`, `agent-stats/example`.
See [adapter authoring](docs/ADAPTER-AUTHORING.md), [the normalized model](docs/MODEL.md),
[ingestion](docs/INGESTION.md), [the HTTP contract](test/contract/README.md) and
[the completed architecture plan](UNIFIED-DASHBOARD-PLAN.md).
