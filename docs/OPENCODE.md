# OpenCode V2 integration

The universal package's default export is its OpenCode plugin. After building
at the project root, add the package directory to `plugins` in your OpenCode
configuration (preserve all existing entries):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/Users/eugene/Code/agent-stats"],
}
```

Reload OpenCode and run `/stats`. The compiled plugin (`dist/opencode.js`) starts
or locates the common `dist/server.js`, then opens its URL. It defaults to
`--client opencode`, port 3848 and the universal cache/log directory. Use
`AGENT_STATS_SOURCES` to replace the default source with a combined configuration;
see [source settings](SOURCES.md). Legacy `OPENCODE_STATS_PORT`,
`OPENCODE_STATS_SOURCES` and `OPENCODE_STATS_SOURCE_ID` remain integration fallbacks.
Startup/browser errors are reported. Standalone use needs no plugin:

```sh
node dist/server.js --client opencode
```

## Data and limitations

`src/adapters/opencode.ts` uses OpenCode's **read-only V2 API**, service discovery
and authentication—not its private database or synthetic Pi transcripts.
Sessions/messages paginate, poll every 30 seconds and reconcile periodically.
Authentication failures appear in per-source status without erasing imported data.

The local dashboard cache includes prompts, responses and tool results. Old
dashboard mirrors/caches and OpenCode's own data remain untouched. Recorded cost
totals, including zero, are authoritative; unknown costs/timing stay unknown.
Independent current-rate estimates carry pricing provenance, and copied fork
history does not add spend. Regex-based frustration scoring is available; paid
LLM judging is not. See [migration/accounting](MIGRATION.md).
