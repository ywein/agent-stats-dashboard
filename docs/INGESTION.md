# Shared ingestion (Stage 3)

## Host lifecycle

```ts
// Internal host code; external adapters only need the public adapter/model API.
import { IngestionCoordinator } from "../src/core/ingestion/index.ts";
import { IngestionStore } from "../src/core/storage/index.ts";
import { createIngestionStatusBridge } from "../src/dashboard/server/ingestion-status.ts";

// The host creates the parent directory and owns the store's lifetime.
const store = new IngestionStore("/data/normalized-ingestion.sqlite");
const ingestion = new IngestionCoordinator(store, [
  { source, adapter, config }, // ClientAdapter and stable Source supplied by the host
]);
const live = createIngestionStatusBridge(ingestion);

ingestion.start();
// GET /api/status and the first SSE event: live.status()
// Subsequent SSE events: live.subscribe(status => send(status))
// POST /api/sync: schedule live.requestSync(); errors are also exposed in status.
// To refresh one configured source: await live.requestSync(source.sourceId)

// On host shutdown, abort and drain adapters before closing storage:
await ingestion.stop();
store.close();
```

Use one coordinator per store's configured sources. Hosts must not run competing
coordinators for the same source: opaque revisions cannot resolve write ordering.
Configuration/credentials stay in registrations, never the database. The source's
capabilities are updated from its connected adapter. The core imports adapter
interfaces and a small runtime compatibility check; adapter-contract imports the
independent model type-only. There is no runtime module cycle.

The SQLite store uses Node's built-in `node:sqlite`, WAL, full synchronous commits
and a busy timeout. Internal sources are TypeScript; the package bundles them for
its Node 22.13+ server. Use Node 24+ for direct test execution. Use a new normalized
database path; legacy Pi/OpenCode caches and their migration belong to Stage 4.

## Scheduling and recovery

- `start()` is idempotent. Each source independently connects, discovers and reads
  sessions, then polls and optionally watches. One connection failure does not
  prevent other sources from committing.
- A source has one serial lane for discovery, manual refresh, watch handling and
  writes. This also serializes reads of mutable records. Different sources can
  perform asynchronous adapter operations concurrently.
- Discovery follows opaque cursors, including empty intermediate pages. Cyclic
  cursors and foreign identities fail explicitly. Pages are checkpointed only
  after every session in the page commits. On interruption, an unfinished page
  replays, or a completed page resumes at its saved next cursor.
- Polling defaults to 30 seconds. Incremental discovery supplies the last
  successful scan's **start** time as `updatedSince`; incremental session reads
  receive their last committed checkpoints.
- Full reconciliation defaults to every five minutes, is checked on every poll,
  and occurs on connection and manual refresh. Full scans use no time hint and
  full reads use null checkpoints. A resumed partial scan finishes before the
  connection's full scan. Missing sessions are retained.
- Operations retry up to three times by default, with bounded exponential delay
  beginning at one second. Exhausted background failures reconnect after the
  base delay. A failed discovery cursor restarts discovery; cancellation preserves
  its last durable position. Invalid session checkpoints recover on reconnect's
  full read. Options configure polling, reconciliation, delay and attempt count.
- Watch events are consumed with backpressure. Refresh/rescan checkpoints advance
  only after all triggered work commits. A crash between data and watch-checkpoint
  commits replays the event safely. Stream failure/end resets the watch cursor and
  reconnects through full reconciliation. An ingestion failure retains the prior
  watch cursor for replay.
- Every operation receives cancellation. `stop()` is idempotent, aborts pending
  work/backoff, drains workers and closes each connection. Adapters must honor
  cancellation and make `close()` idempotent. A stopped coordinator is not reused.

## Storage semantics

`commitSnapshot` atomically commits session metadata, whole-record upserts,
explicit record tombstones and the session checkpoint. On any error, the whole
transaction rolls back. Keys are collision-safe source/session/record tuples.
Re-importing a request replaces its prior observation rather than adding spend;
running requests and tools can become completed, failed or interrupted under the
same identity. Null fields replace prior known values.

Both `full` and `partial` snapshots retain omitted records. Only explicit record
tombstones remove records from `getRecords`; their provenance and original kind
remain stored. Record kind changes, duplicate identities, conflicting upserts and
deletes, and foreign identities/references are rejected. A later valid upsert can
restore a tombstoned record. Adapters remain responsible for metric/schema
correctness (finite numbers, semantic interpretation and valid normalized fields).

Explicit session deletion marks it unavailable and atomically saves the watch
checkpoint, retaining its records and spend. Even deletion before discovery is
remembered. A later successful read restores availability. Empty, partial or
failed scans never delete sessions or records.

Checkpoint domains are separate: session-read checkpoints, discovery-page
progress, scan watermarks and watch cursors. All are durable. Record JSON retains
unknown values, cost provenance, timing quality and canonical ownership without
Pi-specific transformation. Aggregation/query migration follows in Stage 4.

## Dashboard status

`status()` returns a data `version` and per-source state: label, phase, operation,
error, attempt, discovery progress and last successful sync time. `subscribe()`
reports state changes and commits; observer exceptions cannot fail ingestion.
Refresh rejects with an aggregate error after every selected source settles.

The dashboard's structural status bridge converts this to `LiveStatus`, preserving
source details in optional `sources` and exposing labeled errors in `sync.error`.
Errors take precedence over healthy-source progress, so the existing Live chip
displays failures even while another source syncs. `processed` stays zero because
the legacy inserted-row count is not a normalized-upsert count. Hosts supply the
optional indexing-hours getter. Subscription does not send an initial event;
hosts send `status()` on connection, matching the existing SSE protocol.

Stage 3 tests exercise this bridge with the real coordinator. Stage 4 wires the
Pi/OpenCode hosts to it alongside their adapter and aggregation migration.

## Validation

Run `npm test` and `npm run check` from the project root.
The fixture-adapter suite covers disk reopen/resume, rollback, replay, pagination,
lifecycle updates, source isolation, incremental and full reads, watch order/gaps,
conservative deletion, live status errors and shutdown during active work.
