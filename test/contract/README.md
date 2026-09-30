# Shared dashboard HTTP contract

This protocol began with Stage 1 and now projects common normalized records.
Both launchers serve the shared runtime at a loopback origin. The browser uses
relative `/api` URLs and hash routes (`#/requests?range=all`).

## Types and examples

- `src/dashboard/shared-types.ts`: aggregation, live status, tool and trace response types.
- `src/dashboard/client/types.ts`: request, usage, time-range and page response types.
- `src/dashboard/config.ts`: runtime presentation settings returned by `/api/config`.
- `pi.json`, `opencode.json`: representative full responses for one successful
  request with a tool call. Generated from synthetic inputs, with data roots
  replaced by `<data>`. Trace fingerprints and database IDs are opaque.

Both examples contain 10 input, 20 output, 30 cache-read and 5 cache-write tokens,
a recorded $0.75 total, 1,400 ms duration and 200 ms TTFT. The OpenCode input runs
directly through the normalized adapter. OpenCode's absent recorded categories
are null; Pi's explicitly recorded category zeros remain zero. See
[Stage 4 corrections](../../docs/MIGRATION.md) for changes from the original baseline.

The contract test checks complete response field/type shapes and key numeric
invariants. It also checks packaging, static assets, action headers, trace ETags,
errors and the live stream. To intentionally refresh examples after reviewing a
contract change, run `UPDATE_CONTRACT=1 node --test test/dashboard.test.mjs` from
the workspace root.

## Reads

| Endpoint | Query | Response |
|---|---|---|
| `/api/health` | — | `{ app, version, pid }`; client-specific identity retained for launchers |
| `/api/config` | — | `DashboardConfig` |
| `/api/status` | — | `LiveStatus` |
| `/api/sources` | `range`, source filters | `SourceDashboard`: identities, capabilities, status, selected IDs and actual-record coverage |
| `/api/events` | — | SSE `data: <LiveStatus JSON>\n\n`, plus keep-alive comments |
| `/api/stats` | `range` | `DashboardStats` |
| `/api/stats/overview` | `range` | `OverviewStats` |
| `/api/stats/model-dashboard` | `range` | `ModelDashboardStats` |
| `/api/stats/costs` | `range` | `CostDashboardStats` |
| `/api/stats/tools` | `range` | `ToolDashboardStats` |
| `/api/stats/providers` | `range` | `ProviderDashboardStats` |
| `/api/stats/provider-windows` | `range`, optional `provider` | `ProviderWindowStats` |
| `/api/stats/frustration` | `range` | `FrustrationDashboardStats` |
| `/api/frustration/estimate` | `range` | `FrustrationEstimate` |
| `/api/stats/recent` | `limit` (default 50) | `MessageStats[]`; newest requests, range filtering in the UI |
| `/api/stats/errors` | `range`, `limit` | `MessageStats[]` |
| `/api/stats/models` | `range` | `ModelStats[]` |
| `/api/stats/folders` | `range` | `FolderStats[]` |
| `/api/stats/timeseries` | `range` | `TimeSeriesPoint[]` |
| `/api/request/:id` | numeric database ID | `RequestDetails` with session entry and output |
| `/api/sessions` | `limit` (default 100), optional `q` | `SessionSummary[]` |
| `/api/session/trace` | required `file` | `SessionTrace`, with `ETag` |
| `/api/session/entry` | required `file`, `id` | `{ entry: unknown }` |

Ranges: `1h`, `24h`, `7d`, `30d`, `90d`, `all`. Numeric timestamps are epoch
milliseconds, durations are milliseconds, costs are USD. Identity fields such as
`sessionFile` are opaque encoded source/session tuples, never paths to read.
URL-encode them. Details/entries contain normalized request, cost, timing, content
and tool records. Unknown values are null.

Stage 5 data reads also accept optional `sourceId` and `clientType` filters,
intersected when both are present. Unknown selections return 400. Record and
trace lookups outside the selected scope return 404. Request rows include public
source metadata. Aggregates include `coverage`; cost points include separately
nullable `recordedCost` and `estimatedCost` (the latter excludes requests with a
recorded total). Cache rate is null when no request has suitable cache counters.
See [source selection and accounting](../../docs/SOURCES.md) for coverage semantics.

Trace reads accept `If-None-Match` and return an empty `304` on an unchanged
root/child fingerprint. Other successful reads return `200` JSON. SSE sends the
current state immediately, then sync/data-version changes; clients refresh active
queries when the data version changes.

Stage 3 adds `src/dashboard/server/ingestion-status.ts`, a shared bridge from the
normalized coordinator to this protocol. It adds optional per-source `sources`
to `LiveStatus` and presents labeled source failures through `sync.error` for the
existing Live chip. Stage 4 connects both production hosts to this bridge and
updates the synthetic response fixtures to normalized payloads.

## Actions and errors

Every mutating action requires `POST` and **`X-Dashboard-Action: 1`**:

| Endpoint | Query | Response |
|---|---|---|
| `/api/sync` | optional `sourceId`, `clientType` | `202 LiveStatus`; schedules selected configured sources; explicit cached-only source returns 409 |
| `/api/frustration/judge` | `range` | `202 FrustrationJobStatus` when available; currently `503 { error }` |
| `/api/frustration/cancel` | — | `200 FrustrationJobStatus` |

Stage 1 replaces `X-Pi-Stats-Action` and `X-OpenCode-Stats-Action` with the common
header, including sync. Wrong method returns `405 { error }`; missing/incorrect
header returns `403 { error }`. Neither server approves cross-origin preflights.
Launchers keep their original health identities and protocol version.

Missing trace arguments and rejected paths return `400 { error }`. Missing
sessions/entries return `404 { error }`; missing request IDs and unknown routes
may return plain-text `404`. Unexpected failures return `500 { error }`. The
browser prefers JSON `error` text and falls back to HTTP status for text errors.
Requests addressed to a non-loopback Host are rejected with `403`.
