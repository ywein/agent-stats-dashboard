# Common backend and universal-package migration

## Runtime and storage

The universal `agent-stats` package now has one `dist/server.js`, one browser build
and two integration entrypoints (`dist/pi.js` and `dist/opencode.js`). The old
workspace packages and separate client distributions are gone. Both integrations
call the same backend; presentation and health identity are now client-neutral
(`agent-stats`). The default port is 3848 for both clients. HTTP handlers never query source files
or APIs. Request details, entries and traces come from normalized SQLite records.

Read-side queries cache a normalized snapshot until ingestion commits another
version. The old per-client databases, parsers, trace builders and materialized
rollup implementations are no longer used. Identity comparisons use
`(sourceId, sessionId, recordId)` tuples. Read-side caching currently holds the
normalized records in memory; this migration does not retain the legacy hourly
rollup optimization.

## Existing caches and rebuilding

The universal cache lives under **`~/.local/share/agent-stats`** (override with
`AGENT_STATS_DIR`). Each effective source configuration gets a stable
`stats.<profile hash>.normalized-v1.db` filename. This isolates checkpoints when
different client/source configurations run concurrently. `AGENT_STATS_DB` overrides
the exact filename; do not point competing dashboards at the same database.
Logs use `server.log` in the same directory.

Previous per-client caches remain untouched and are not migrated:

- Pi: `~/.pi/agent/pi-stats-web/stats.db.normalized-v1`
- OpenCode: `~/.local/share/opencode-stats/dashboard/stats.db.normalized-v1`
- Old `PI_STATS_DB`, `OPENCODE_STATS_DB` and `OPENCODE_STATS_DIR` settings no longer
  select the universal cache. Use `AGENT_STATS_DB` and `AGENT_STATS_DIR` instead.

Stop old dashboard processes before launching the universal build. Update Pi to
load the new package's `dist/pi.js`; update OpenCode's plugin path to the new
package root. The new health ID intentionally does not match old processes, so
the new `/stats stop` will not stop a legacy process. Terminate that old Node
process separately or let its idle timeout expire. First launch
reimports original Pi transcripts or OpenCode API history.
Old `stats.db` files and OpenCode `sessions/` mirrors remain untouched and are never
imported: their lossy costs cannot reconstruct missing categories or recorded zero.

To rebuild, stop the dashboard, remove only its `.normalized-v1.db` database and
matching `-wal`/`-shm` sidecars, then restart. Do not remove source transcripts or
OpenCode's database. Numeric request handles and old deep links can change after
a rebuild. Old dashboard caches can be removed separately after validation.

Sessions absent from discovery are retained rather than treated as deletions.
Outages and incomplete scans cannot erase imported history. A rebuild recovers
only data still available from the source; mirror-only history is not migrated.

## Adapter behavior

### Pi

- Recursively discovers regular JSONL files. Native session IDs are opaque; missing
  IDs fall back to a hash of the relative locator. Symlinks are not traversed.
- Extracts header `cwd` (with same-project header fallback), session-info titles,
  nested subagent links, advisor roles and explicit fork headers. Copied native
  record IDs link to their original session and do not add spend.
- Checkpoints complete-line byte offsets and file revisions. Changed sessions are
  reread conservatively to relink prompts, late tool results and timing events;
  unchanged incremental reads return empty partial snapshots. Incomplete trailing
  lines are retried after append. Malformed complete JSON reports a source error
  without advancing the durable checkpoint.
- Watches known files for targeted refresh and rescans for new files. Polling and
  periodic reconciliation continue if watching is unavailable.
- Preserves timing hooks and explicit tool-start events. Missing timing stays
  unknown. A trace with only one known endpoint renders a point and shows unavailable
  duration in its detail drawer.

### OpenCode

- Uses V2 `Service.ensure()` and `Service.headers()` for discovery/authentication.
  Adapter configuration also accepts an explicit URL and headers.
- Paginates sessions/messages, rejects repeated cursors, polls every 30 seconds,
  and fully reconciles every five minutes. Unchanged completed sessions can skip
  message reads; active requests refresh even without a changed session revision.
- Converts requests, tools, user messages and lifecycle events directly. No
  synthetic Pi transcripts, marker files or model snapshots are written.
- Retains subagent/fork links. Copied native IDs receive canonical ownership.
  Explicit fork history predating the new session with remapped IDs is retained as
  non-billable trace context rather than attributed as fresh usage. Failure to read
  a fork parent reports a source error rather than guessing ownership.
- API errors appear in source status and the Live chip. Imported data remains
  readable. Model-price lookup is optional and cannot block usage import.

## Accounting and API corrections

The common fixture remains one request, 65 conversation tokens, $0.75 recorded
spend, 1,400 ms duration, 200 ms TTFT and one tool call for each client.

Intentional corrections:

1. **Recorded zero wins for both clients.** The Pi bridge test now totals $1.50,
   rather than the old $4.50 that substituted a $3 public price for a free request.
2. Missing token counters, timestamps, timing and cost categories remain `null`.
   OpenCode's $0.75 fixture has four unknown recorded category costs, not zeros.
3. Pricing requires matching provider/model rates and known accounting semantics.
   Estimates retain rates, context-tier bounds, rate source and current-rate
   provenance. Unresolved tiers never fall back to a base rate.
   OpenCode V2 uses disjoint visible-output and reasoning counters, priced at the
   same output rate. Reasoning is counted once. Its context threshold comparison
   is strictly `context > size`, so exact thresholds remain in the lower tier.
4. Estimated categories are never rescaled to a recorded total. Request details
   show them separately. Cost component views report unavailable coverage rather
   than rendering unknown categories as zero. Cache savings is unavailable when
   the comparison cannot be calculated.
5. Running/incomplete observations are not counted as successes or called
   cancelled just because a finish field is absent. OpenCode idle markers supply
   evidence for an incomplete or interrupted terminal observation.
6. Fork context is excluded from totals; subagent work is counted once overall
   and folded into the parent's trace summary.

The compatibility fields `sessionFile`, `file` and trace query parameter `file`
now contain opaque encoded source/session tuples, never paths to read. Details
include normalized `record`, `tools`, `cost`, `outcome` and `timing`; session entry
reads return normalized records. Trace ETags cover root and child records.
Overview/cost payloads expose recorded/estimated/unavailable totals and their policy.

Stage 5 still owns source-selection controls, general metric coverage and fully
capability-aware mixed-source presentation. Legacy aggregate token fields sum
known values; individual records retain unknown values.

OpenCode interpretation was checked against the V2 OpenAPI contract and published
`@opencode/core@2.0.19` implementations `src/session/usage.ts` (counter mapping,
reasoning pricing and tier comparison) and `src/session/projector.ts` (fork copies
remap message IDs while retaining original timestamps). No source database access
is used by the adapter.

## Validation

```sh
npm run build
npm run check
npm test
# Optional disposable fixtures for browser checks:
node test/smoke-server.mjs
```

The browser fixture serves Pi on port 38480 and OpenCode on 38580, using temporary
data removed on SIGINT/SIGTERM. Packed-distribution tests install all shared
packages outside the workspace, rebuild both launchers and check byte-identical
client assets, complete API shapes and fixture totals.
