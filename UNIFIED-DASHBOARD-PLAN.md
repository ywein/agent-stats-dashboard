# Unified Dashboard with Client Adapters

**Current delivery:** All six stages are implemented. The project now lives in
`~/Code/agent-stats` as one installable `agent-stats` package. The earlier workspace
and two-distribution arrangement described in historical milestones has been
consolidated into one source tree, build, server and browser distribution.
See [the current layout and installation guide](README.md).

## Goal

Build one dashboard with pluggable adapters for coding-agent clients. Pi and OpenCode are the first adapters; adding another client should require an adapter and its tests, without changes to dashboard pages or database queries.

Share:

- React UI and charts
- Dashboard API
- Storage and aggregation
- Pricing policies
- Live-update infrastructure

Keep client-specific:

- Session discovery and data access
- Conversion into the common data model
- Change detection
- Client integration, such as `/stats`
- Interpretation of client-specific usage and timing fields

## Target architecture

```text
Pi files ──────── Pi adapter ────────┐
                                   │
OpenCode API ─── OpenCode adapter ──┼── Ingestion → Storage → Dashboard API → UI
                                   │
Future client ── Future adapter ────┘
```

Client launchers are separate from data adapters. A Pi extension or OpenCode plugin can open the dashboard, but the dashboard must also work standalone.

Current repository structure:

```text
src/
  dashboard/client/         # Shared React UI
  dashboard/server/         # HTTP API and live status
  core/model/               # Normalized domain types
  core/ingestion/
  core/storage/
  core/aggregation/
  core/pricing/
  adapter-contract/         # Adapter API and reusable tests
  adapters/                 # Pi, OpenCode and source-module loading
  integrations/pi/          # Pi /stats command
  integrations/opencode/    # OpenCode /stats command
  main.ts                   # One server entrypoint
examples/                   # Minimal independent adapter
test/
docs/
dist/                       # One bundled distribution
```

One package ships bundled distribution artifacts, so installation does not depend
on sibling source directories or separately published workspace packages.

## Stage 1 — Establish a baseline and share the UI

**Objective:** Eliminate UI duplication with minimal backend changes.

**Status:** Implemented. Shared sources and HTTP response types are in
`src/dashboard`; the universal package builds its compiled assets once. Runtime
presentation settings come from `/api/config`, and mutating requests use
`X-Dashboard-Action: 1`. See the [workspace guide](README.md) and
[API baseline](test/contract/README.md).

Validation: workspace build and type checks, existing backend tests, fixture API
contract tests, isolated tarball installation/rebuild/run tests, and browser smoke
checks for Overview, Requests (including details), Tools and Traces on both backends.

### Work

1. Capture the existing dashboard API contract and representative responses.
2. Move both copies of `src/client/` into one shared package.
3. Make both backend builds consume the same client build.
4. Replace client-specific branding and strings with runtime configuration:
   - Dashboard title and logo
   - Source labels
   - Available features
5. Standardize shared HTTP conventions, including action headers.
6. Preserve the existing standalone launch paths for Pi and OpenCode.

The OpenCode transcript mirror remains an implementation detail during this stage.

### Acceptance criteria

- Exactly one source copy of each dashboard page and component.
- Both backends serve the shared UI.
- Overview, Requests, Tools, and Traces work against both backends.
- Each distribution builds and runs independently.

## Stage 2 — Define a client-neutral data model

**Objective:** Define what an adapter supplies without baking Pi’s transcript layout into the contract.

**Status:** Implemented. The [normalized model](docs/MODEL.md) defines
identities, ownership, usage, cost provenance and timing. The
[adapter boundary](docs/ADAPTER-CONTRACT.md) defines concrete connection,
pagination, snapshot, checkpoint and change types for Stage 3. Typed synthetic
Pi/OpenCode fixtures cover unknown values, zero-cost estimates, lifecycle outcomes,
forks and subagents. Existing backends continue using their Stage 1 pipeline until
the migration in Stage 4.

### Core records

| Record | Purpose |
|---|---|
| Source | A configured instance of a client connection |
| Session | Identity, project, title, timestamps, and relationships |
| User message | Prompt content and time |
| Model request | Model, usage, cost, outcome, and timing |
| Tool execution | Call identity, arguments, result, outcome, and timing |
| Trace event | Optional detailed lifecycle events |

A source is distinct from a client type: a user could connect two OpenCode servers or multiple Pi session roots.

### Important modeling decisions

- Namespace identities by source: `(sourceId, sessionId, recordId)`.
- Represent parent sessions and forks explicitly.
- Use opaque session IDs rather than filesystem paths.
- Distinguish missing values from zero.
- Preserve usage semantics, especially cache and reasoning tokens.
- Distinguish recorded cost from estimated cost.
- Track cost provenance separately for the total and each category. A recorded total does not imply a recorded input/output/cache breakdown.
- Distinguish measured timing from inferred timing.
- Allow records to change while a request or tool is running.
- Attach provenance sufficient to inspect or refresh a source record.

### Cost totals and breakdowns

OpenCode may supply a recorded request total without category-level costs. The adapter must preserve that total and represent absent input, output, cache-read, and cache-write costs as unknown, not zero.

When token counts and suitable model rates are available, the shared pricing layer may calculate a separately labeled estimated breakdown. Retain the pricing basis used, including the model, rates, applicable context tier, and whether the rates are current rather than historical. Do not silently substitute a base rate when an applicable tier cannot be determined.

- Keep recorded totals and estimated totals/breakdowns as separate values.
- Preserve an explicitly recorded zero; do not silently replace it with an API-equivalent estimate.
- An estimated breakdown need not sum to the recorded total. Expose the difference rather than rescaling the estimates or implying they are exact.
- If pricing or usage is insufficient, leave the relevant estimate unavailable.
- Apply these rules to every adapter, not only OpenCode.

### Acceptance criteria

- Real Pi and OpenCode examples can be represented without fabricated fields.
- Missing timing or cost remains unknown.
- A recorded total with no breakdown retains unknown category costs, while optional estimates carry explicit provenance.
- Recorded zero-cost requests stay zero even when an API-equivalent estimate is available.
- Forks and subagents have defined attribution rules.
- Fixtures cover successful, failed, interrupted, and incomplete requests.

## Stage 3 — Introduce the adapter contract and shared ingestion

**Objective:** Move client-specific behavior behind a clear boundary.

**Status:** Implemented. The [shared ingestion engine](docs/INGESTION.md)
provides independent source workers, paginated discovery, incremental reads,
durable checkpoints, bounded retries, optional watches and periodic full
reconciliation. A normalized SQLite store atomically applies records and session
checkpoints. The [dashboard status bridge](src/dashboard/server/ingestion-status.ts)
maps source connection/ingestion failures into the live dashboard protocol.
Pi/OpenCode host wiring and data conversion use this engine in Stage 4.

Validation: fixture-adapter tests cover durable restart, atomic rollback,
idempotent imports, lifecycle updates, source isolation, watch replay/gaps,
conservative deletion, status reporting and cancellation. Workspace type checks,
builds and existing backend/distribution tests cover compatibility.

The contract should cover these responsibilities:

```ts
interface ClientAdapter {
  descriptor: AdapterDescriptor;

  connect(
    config: unknown,
    context: AdapterContext,
  ): Promise<AdapterConnection>;
}

interface AdapterConnection {
  capabilities: SourceCapabilities;

  listSessions(input: SessionPageInput): Promise<SessionPage>;
  readSession(input: SessionReadInput): Promise<SessionSnapshot>;

  // Optional optimization; polling/reconciliation remains supported.
  watchChanges?(input: WatchInput): AsyncIterable<SourceChange>;

  close(): Promise<void>;
}
```

Finalize the concrete types in Stage 2. Avoid making streaming, filesystem access, or API pagination mandatory for every adapter.

### Work

1. Build a shared ingestion coordinator:
   - Initial discovery
   - Pagination
   - Incremental refresh
   - Checkpoints and retries
   - Cancellation and shutdown
   - Periodic reconciliation
2. Let adapters describe changes; let the core own database writes.
3. Persist checkpoints only after successful ingestion.
4. Support idempotent updates to existing records.
5. Define full-snapshot versus partial-update semantics.
6. Define deletion behavior explicitly so an incomplete scan cannot erase history.

### Acceptance criteria

- Repeated imports do not duplicate usage.
- Interrupted imports resume safely.
- Running requests can transition to completed or failed.
- One source failure does not block other sources.
- Source connection and ingestion errors appear in dashboard status.

## Stage 4 — Migrate Pi and OpenCode to the common pipeline

**Objective:** Replace two backend implementations with one.

**Status:** Implemented. Both integrations use `src/dashboard/server/runtime.ts`
and the Stage 3 ingestion coordinator/store. `src/adapters` supplies Pi JSONL
and OpenCode V2 API connections; the duplicate backends and OpenCode journal mirror
have been removed. Core pricing preserves recorded totals (including zero) and
separate estimates. Request details, entries and traces read normalized records.

Validation covers pagination/authentication, complete-line checkpoints, restart,
lifecycle replacement, fork/subagent ownership, overlapping source IDs, cost
provenance, child-only trace invalidation, fixture totals, workspace checks/builds,
isolated tarball rebuilds, and headless browser checks of all ten pages on both
launchers. See [migration and accounting corrections](docs/MIGRATION.md).

### Pi adapter

Move these responsibilities into the adapter:

- Filesystem discovery and watching
- JSONL parsing and offsets
- Project metadata extraction
- Pi-specific timing and tool-event interpretation
- Subagent and fork identification

### OpenCode adapter

Move these responsibilities into the adapter:

- Service discovery and authentication
- API pagination
- Session/message conversion
- Polling and optional event subscription
- OpenCode-specific token and timing interpretation

Correct the current port's cost handling during migration: missing category costs currently default to zero, and the inherited pricing fallback can replace recorded zero totals with estimates. Map recorded totals faithfully and route optional category estimates through the shared pricing layer instead.

Remove the Pi-shaped OpenCode mirror once the shared store supports request details and traces.

### Shared backend

Move aggregation, pricing, storage, API routes, and status streaming into shared packages. Remove remaining assumptions that session identity means “path to a transcript.”

### Acceptance criteria

- Both adapters feed the same storage and aggregation code.
- Fixture totals match the agreed baseline or have documented corrections.
- OpenCode no longer needs synthetic Pi transcripts.
- Request details and traces use the common model.
- Rebuild/migration behavior for existing dashboard caches is documented.

## Stage 5 — Make capabilities and multiple sources first-class

**Objective:** Keep the UI useful as adapters with different data quality are added.

**Status:** Implemented. Both launchers accept a multi-source configuration file.
All pages share URL-persisted source/client selection, scoped query caches,
per-source status and refresh, capability explanations and actual-record metric
coverage. Cost presentation separates recorded spend, estimated-only spend and
independent category estimates, with coverage and pricing-basis disclosures.
See [multiple sources and metric coverage](docs/SOURCES.md).

Validation covers a minimal fixture adapter, overlapping identities, reconciled
combined/per-source totals, scoped details/entries/traces, targeted refresh,
configuration validation, workspace checks/builds and isolated tarball installs.
Headless browser checks cover selection/cache isolation, unavailable metrics,
request capability explanations and all ten pages on Pi, OpenCode and mixed
source hosts.

### Work

1. Add source selection:
   - All sources
   - Client type
   - Individual source
2. Add per-source status and refresh controls.
3. Define capabilities for features such as:
   - Request details
   - Tool results
   - Detailed traces
   - TTFT
   - Recorded costs
   - Pricing estimates
4. Use capabilities to explain unavailable features.
5. Show coverage for partially available metrics:
   - “Latency available for 68% of requests”
   - Recorded versus estimated spend
   - Separately labeled recorded totals and estimated category breakdowns
   - Unavailable category costs shown as unavailable rather than zero
   - An explanation when estimated categories do not sum to the recorded total
6. Handle mixed-source views where only some sources support a metric.

Capabilities describe what a source can supply; individual records still indicate which fields are actually available.

### Acceptance criteria

- A minimal adapter supplying sessions and usage can render a useful dashboard.
- Unsupported data is shown as unavailable, not zero.
- Sources with overlapping IDs remain isolated.
- Combined totals and per-source totals reconcile.
- Cost charts and summaries disclose their pricing basis and do not silently mix recorded spend with API-equivalent estimates.

## Stage 6 — Stabilize integrations and adapter development

**Objective:** Make future adapters straightforward to build and maintain.

**Status:** Implemented. Pi and OpenCode integrations share the
[dashboard launcher](src/dashboard/launcher.ts), including process
discovery/startup, configuration-aware reuse, source selection, browser opening
and startup error reporting. Pi timing hooks and model snapshots remain in its
integration. The adapter package exports an explicit API v1 compatibility check,
[author documentation](docs/ADAPTER-AUTHORING.md), a standalone
fixture adapter and reusable contract tests. Source files can load external
adapter modules without edits to pages, queries or routes. Public API, example
and test-suite entrypoints ship compiled JavaScript for installed-package use.

Validation: workspace checks/builds and the complete test suite pass. Contract
tests cover pagination/stable identities, reconnect, lifecycle replacement,
missing values, idempotence, retry recovery, conservative reconciliation,
explicit tombstones, cancellation and shutdown. Launcher tests cover reuse,
configuration isolation, occupied ports, source URL selection and startup errors.
Isolated tarball tests rebuild the universal distribution, exercise both clients,
load the published fixture
adapter through the shared runtime and run the published contract suite outside
the project. Post-stage cleanup consolidates all modules into one `agent-stats`
package, with one `dist/server.js`, one UI build and separate compiled client
integration entrypoints. Old Git/task metadata is retained in ignored `.legacy/`.

### Work

1. Reduce Pi and OpenCode integrations to thin launchers:
   - Start or locate the dashboard
   - Select/configure a source
   - Open its URL
   - Report startup errors
2. Keep optional telemetry hooks inside the relevant client integration.
3. Add a versioned adapter API.
4. Publish adapter-author documentation and a minimal example.
5. Create reusable contract tests for:
   - Pagination
   - Stable identity
   - Incremental updates
   - Missing fields
   - Errors and retries
   - Deletions and reconciliation
   - Shutdown
6. Validate extensibility with a small fixture-backed adapter that has no Pi or OpenCode dependencies.

### Acceptance criteria

- A new adapter can be added without editing dashboard pages, SQL queries, or server routes.
- Both client launchers use the same dashboard runtime.
- Adapter compatibility failures produce actionable errors.

## Recommended delivery sequence

| Milestone | Stages | Result |
|---|---|---|
| Shared presentation | 1 | One UI, existing backend behavior |
| Unified engine | 2–4 | One backend with Pi and OpenCode adapters |
| Extensible product | 5–6 | Multiple sources, capability-aware UI, documented adapter API |

The key architectural investment is Stage 2. Sharing React files is easy; defining accurate identities, updates, costs, and timing semantics is what prevents every future adapter from needing special cases throughout the dashboard.
