# Client-neutral core

Import `agent-stats/model`. This entrypoint defines the ingestion model;
the Stage 1 dashboard HTTP types remain a separate presentation contract.
The public model entrypoint ships compiled JavaScript and TypeScript source types;
installed consumers do not need a TypeScript-capable runtime.
The host's `src/core/ingestion` and `src/core/storage` implement ingestion/storage;
see [the ingestion guide](INGESTION.md) for lifecycle, persistence and host wiring.

## Identity, ownership and relationships

- Source IDs identify configured connections, not client types. Two Pi roots or
  two OpenCode endpoints receive distinct, persistent source IDs. Reconnecting
  must reuse that ID. Configuration and secrets live outside the model.
- Session IDs are opaque and stable. Paths belong in project metadata or adapter
  provenance. Moving a transcript must not create a new session identity.
- Records use `(sourceId, sessionId, recordId)`. IDs must be unique across record
  kinds within a session; adapters namespace native IDs when necessary. Use the
  tuple key helpers rather than delimiter concatenation.
- References can resolve later. Do not fabricate parents, prompt links or request
  links when the source does not supply evidence. A generic parent relationship
  does not prove a fork or subagent. In particular, OpenCode `parentID` alone maps
  to `parent`; Pi directory nesting can classify an agent without identifying its
  parent. Record a specific relationship only when its identity is known.
- A subagent's requests belong to its own session. Parent-inclusive views may
  traverse the relationship, but count each canonical request once. Tools and
  trace events never add model spend; any allocation to tools is a derived metric.
- Forks reference their original session and optional branch-point record.
  Copied history carries `origin` pointing directly to the canonical original,
  not another copy. Copies are context, excluded from usage/spend aggregation;
  new post-fork requests have `origin: null`. Do not deduplicate merely by equal
  content, timestamps or token counts. Adapters unable to identify copied history
  must omit ambiguous copies from billable request records (they can retain them
  as context/trace data), rather than claim they are newly executed requests.

## Unknowns, content and lifecycle

All unknown metric fields are explicit `null`, never zero, empty text, epoch time,
or a made-up model. Known-empty content is `[]`; unavailable content is `null`.
An opaque content block preserves client-specific data without requiring Pi
message envelopes. JSON values must be finite; counters and durations must be
nonnegative. Timestamps are Unix milliseconds. These are contract invariants,
not runtime validation supplied by this stage.

An outcome describes the request, not the overall conversation. `toolUse` /
`tool-calls` can be successful requests. Use `interrupted` only with evidence of
cancellation, `incomplete` for truncated observations, and `unknown` when no
state can be determined. A missing finish field alone does not mean aborted.
Running requests/tools retain their identity as output, usage, timing and state
change. Provenance includes an adapter-owned refresh/inspection locator,
observation time and optional revision. Revisions are opaque equality tokens.

## Usage, costs and timing

Token counters preserve native accounting. Input may include cache tokens;
output may include reasoning. The two overlap flags and `semantics` document
this. Never sum counters when overlap is unknown. `total` is a reported total,
not an automatic sum. Additional counters retain named units, for example
premium requests or orchestration tokens. Missing reasoning is not zero.

Recorded and estimated costs have independent totals and category values.
Every recorded amount has source provenance; every estimate has its complete
pricing basis. A recorded total does not imply any recorded categories.
`preferredTotal` preserves recorded zero, and returns a basis label that must
survive aggregation/presentation. Do not silently mix recorded and estimated
spend into an unlabeled total, or combine currencies without explicit conversion.

The pricing layer must normalize overlapping token counters before pricing.
Cost categories are **disjoint monetary allocations**: if reasoning is included
in output cost, leave the reasoning cost null rather than charging it twice.
An estimate requires known applicable rates and usage semantics. Zero rates are
valid; unknown rates are null. A context-priced model requires the actual tier
bounds and known context-token count; an unknown tier must not fall back to a
flat/base rate. `current` pricing must not be labeled historical. Rate source,
retrieval time, model, currency, method and all rates travel with each estimate.

`estimatedBreakdownDifference` exposes estimate minus recorded total when all
four main category estimates exist; otherwise it returns null. Separately priced
reasoning is added if present. Never rescale estimates to match recorded spend.
Missing cost remains null when usage or pricing is insufficient. Stage 2 defines
these rules and structures; actual rate resolution belongs to shared pricing.

Timing fields independently identify measured vs inferred values and their
method. Subtracting recorded request endpoints is measured elapsed time;
estimating from adjacent transcript messages is inferred. Neither implies active
model compute time. Do not synthesize tool duration from request duration.

## Examples and validation

`test/core/fixtures.ts` contains typed, synthetic source-shaped Pi/OpenCode examples
based on the existing parser/synchronizer structures, normalized counterparts,
all six record kinds, running/success/failure/interruption/incomplete cases,
recorded-zero estimates, forks and subagents. These are not captured private
sessions or production adapter implementations. `npm run check` type-checks the
fixtures; `npm test` checks preservation, identity, lifecycle
and pricing precedence. `test/core/ingestion.test.mjs` exercises the shared coordinator,
durable storage and dashboard status bridge with synthetic adapters. Stage 4
production conversion is in `src/adapters`; shared pricing and aggregation
helpers are internal modules in `src/core/pricing` and `src/core/aggregation`.
