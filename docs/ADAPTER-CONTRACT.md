# Adapter boundary

Import types from `agent-stats/adapter-contract`; normalized records come from
`agent-stats/model`. The [shared coordinator](INGESTION.md) implements
this boundary. Production Pi/OpenCode adapters use this pipeline.
See [the adapter-author guide](ADAPTER-AUTHORING.md) for API versioning, external module
loading, a minimal fixture example and reusable contract tests.

## Connection and discovery

`ClientAdapter.connect` validates its own opaque configuration. The host supplies
a stable source identity, cancellation signal and logger, never database access.
The returned capabilities describe possible data, not completeness of any record.
Use the connection's capabilities to update the source descriptor after discovery.
All records/references emitted by a connection must use its assigned source ID.
`close` is idempotent and releases resources, including active watches.

`listSessions` accepts a nullable opaque cursor and returns a nullable next cursor.
An adapter without pagination returns all sessions with `nextCursor: null`.
`updatedSince` is optional optimization via a nullable hint, not a correctness
boundary. Discovery is not necessarily a consistent snapshot. A failed or partial
scan, missing session or empty page **never authorizes deletion**.

Every operation honors its abort signal as well as connection cancellation.
Errors reject the operation rather than returning fabricated empty success data.
The ingestion coordinator owns retries and per-source error reporting. Do not log
credentials or embed them in provenance.

## Reads and updates

`readSession` returns normalized session metadata and records, plus an opaque JSON
checkpoint. Null input checkpoint requests a full read. An adapter may ignore a
checkpoint and return a full read at any time. Checkpoints are scoped to the
source/session; watch checkpoints are separately scoped to the source watch.
A null input checkpoint requires `mode: "full"`; returning a partial update
cannot satisfy an initial read or full reconciliation.

- `full`: every currently observable record is supplied. Historical records absent
  from the snapshot are retained unless explicitly tombstoned. This conservative
  rule supports truncated journals and API retention limits.
- `partial`: only changed records are supplied. Omitted records are unchanged.
- In both modes, a supplied record is a **complete replacement**, not a field
  patch; null explicitly clears prior knowledge. Record kind cannot change for
  an existing identity. Order is not chronology; timestamps and links express it.
- `deleted` contains only source-confirmed tombstones with provenance. Missing
  files, auth failures and interrupted scans are not confirmation. A record may
  not appear in both `records` and `deleted` in one result; identities are unique.
- Checkpoints commit atomically with all updates and tombstones. On failure, retain
  the previous checkpoint and replay. Serialize reads/commits per session; opaque
  revisions cannot order conflicting concurrent reads. Full reads reconcile stale
  mutable requests without creating new identities.

Snapshots contain one session only; record identities must match it. Relationship
references may point to other sessions discovered later. Source-confirmed session
deletion is an explicit watch `deleted` event; retain history and mark the session
unavailable rather than cascade-deleting spend. Adapters without watch support
retain unavailable history through the same non-destructive discovery rule.

## Optional changes

`watchChanges` is an optimization, never required. `refresh` triggers a session
read; `rescan` triggers discovery; neither contains record patches. Advance a
watch checkpoint only after the triggered work commits (and after all preceding
events commit). Replayed events are idempotent. After gaps, disconnects or an
invalid checkpoint, reconcile via discovery and full reads. Polling/reconciliation
remains required even for watching adapters. No filesystem, API transport or
streaming implementation is mandated by this contract.
