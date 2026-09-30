# Multiple sources and metric coverage

Both standalone launchers accept a JSON source list:

```sh
node dist/server.js --port 3848 --sources ./sources.json
```

```json
[
  {
    "sourceId": "pi-home",
    "clientType": "pi",
    "label": "Home Pi",
    "config": { "root": "/Users/me/.pi/agent/sessions" }
  },
  {
    "sourceId": "opencode-work",
    "clientType": "opencode",
    "label": "Work OpenCode",
    "config": { "url": "http://127.0.0.1:4096" }
  }
]
```

The file replaces the launcher's default source list. IDs must be nonempty and
unique. Keep each ID stable across restarts: it namespaces sessions, records and
checkpoints. A changed ID imports a distinct source. Pi `root` and optional
`modelsPath` resolve relative to the configuration file (use explicit paths;
shell `~` expansion does not apply inside JSON). OpenCode accepts optional
`headers` for authentication, or an empty configuration for local service
discovery. Connection configuration is not included in the source-list API.

Existing cached sources remain visible after removal from the configuration.
Their history is retained and their refresh control is disabled. Do not configure
the same upstream data under two different IDs unless separate attribution is
intended; cross-source deduplication is not performed.

Custom adapters can pass `SourceRegistration[]` directly to `startDashboard`.
The JSON loader knows the two bundled adapters; the runtime and dashboard do not
branch on client type.

## Selection and refresh

Every page has an All sources / Client type / Individual source selector.
Selection is stored in the hash URL and retained across page and range changes.
Changing selection closes request details and clears the trace deep link. Query
caches are namespaced by selection and pages remount, preventing rows from the
previous source from appearing under a new selection.

Data endpoints accept `sourceId` and `clientType`; supplying both intersects
the filters. Unknown IDs/types return 400; a valid empty intersection returns
empty data. Request handles, session entries and trace lookups obey the same
scope, returning 404 when the record is outside it.

- `GET /api/sources?range=all`: public source identities, capabilities, individual
  status (null for cached-only sources), selected IDs and actual metric coverage.
- `POST /api/sync?sourceId=…`: refresh one configured source.
- `POST /api/sync?clientType=…`: refresh configured sources of that type.
- `POST /api/sync`: refresh all configured sources.

Refresh requires `X-Dashboard-Action: 1` and returns 202. Completion and per-source
errors appear in `/api/status` and the existing `/api/events` stream. A cached-only
source cannot be explicitly refreshed (409).

## Capabilities and accounting

Capabilities describe possible request details, tool results, detailed trace
events, TTFT, recorded costs and pricing estimates. They do not guarantee that
every record contains those values. Capability gaps are explained per source;
Requests, Tools and Traces also show mixed-support notices. Usage metadata and
basic session views remain accessible for minimal adapters.

Coverage counts **owned requests in the selected time range**. Fork context does
not contribute. Latency reports measured and inferred counts separately. Missing
timestamps cannot be assigned to a bounded range; use All time to include them.
The request list and trace session list retain their existing all-time scope;
the coverage panel is explicitly range-scoped.

Cost presentation keeps these bases separate:

- **Recorded spend** includes recorded zero and never substitutes estimates.
- **Estimated-only spend** includes estimates only for requests with no recorded
  total. These are API-equivalent prices, not evidence of billed charges.
- **Estimated category breakdowns** include independently available estimates,
  including estimates on requests with recorded totals. Each category has its
  own coverage count; unknown amounts display as N/A. They are not additive with
  the two spend totals above.

The Costs chart defaults to separate recorded and estimated-only series. Model
splits combine those bases with an explicit label. Recorded component charts are
shown only with complete recorded category coverage. The source panel discloses
rate source, current/historical basis, tier kind and the estimate-minus-recorded
difference for requests with a complete comparable breakdown. Request details
retain the exact pricing basis and rates in the normalized record.

Legacy numeric aggregate sums still add available values; use their `coverage`
metadata to interpret partial data. An available zero is different from a null
coverage total. Coverage-bearing cost summaries and unknown metric displays
preserve this distinction.

## Validation

`test/multi-source.test.mjs` exercises a fixture adapter with three overlapping
identity namespaces, including a usage-only source, recorded zero and estimated
costs. It checks reconciled totals, scope enforcement on details/entries/traces,
client-type selection, unknown filters, missing coverage and targeted refresh.
`test/adapters/sources.test.mjs` checks configuration loading.
`test/smoke-server.mjs` serves Pi, OpenCode and mixed-source browser fixtures.
# External adapters and client launchers

Sources may specify an `adapter` module (default `ClientAdapter` export) in
addition to `sourceId`, `clientType`, `label` and `config`. Package exports resolve
from the source file; `./` paths resolve relative to it. No dashboard route or SQL
changes are needed. Only load trusted modules. See the
[API v1 author guide and runnable example](ADAPTER-AUTHORING.md).

For `/stats`, set `AGENT_STATS_SOURCES` to the source file
and optionally `AGENT_STATS_SOURCE_ID` to the opening
selection. Both integrations share startup/probing/browser behavior, check the
configuration before reusing a server, and report errors with the server log path.
