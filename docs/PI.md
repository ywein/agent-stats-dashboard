# Pi integration

Pi is an integration inside the universal `agent-stats` package, not a separate
dashboard. Build at the project root and load the compiled extension:

```sh
npm run build
pi --extension /Users/eugene/Code/agent-stats/dist/pi.js
```

The package also advertises `dist/pi.js` through its `pi.extensions` metadata.

```text
/stats        start/locate the dashboard and open the browser
/stats url    start/locate it and print its URL without opening the browser
/stats stop   stop the matching dashboard process
```

The integration launches the common `dist/server.js` with `--client pi` unless a
source configuration replaces the defaults. It uses `AGENT_STATS_PORT` (default
3848, next free port on collision) and the [shared source settings](SOURCES.md).
`PI_STATS_PORT`, `PI_STATS_SOURCES` and `PI_STATS_SOURCE_ID` are legacy fallbacks.
Errors identify the log or manual-opening URL rather than being silently ignored.

## Pi-specific data

- Session discovery/conversion is in `src/adapters/pi.ts`.
- The integration snapshots Pi's model registry to
  `<Pi agent directory>/pi-stats-web/models.json` for pricing, including custom
  providers. This remains Pi-specific rather than entering the adapter contract.
- Timing hooks stamp `duration`/`ttft` in milliseconds on assistant messages.
  Only requests captured with these hooks have measured latency/TTFT/tokens/s.
- Projects use header `cwd`; forks/subagents use explicit ownership links.
- Recorded spend, including zero, wins. Separate estimates never overwrite it.

The dashboard log and normalized cache live under `AGENT_STATS_DIR`, not the old
per-client dashboard directory. Source transcripts and old caches are untouched.
See [cache migration](MIGRATION.md) and [adapter authoring](ADAPTER-AUTHORING.md).
