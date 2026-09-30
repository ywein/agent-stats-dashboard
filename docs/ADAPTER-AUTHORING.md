# Build an adapter (API v1)

Adapters translate client data into the [normalized model](MODEL.md).
They never import dashboard pages, routes, SQL queries or the SQLite store.
A client integration is optional: the same adapter works with a standalone host.

## Minimal implementation

Copy [the fixture example](../examples/fixture.ts), or import it from
`agent-stats/example`. It has no Pi or OpenCode dependencies,
supplies sessions and usage with missing costs/timing, paginates discovery and
replaces a running request using a stable identity. Its mutation helpers exist
for tests; a real adapter would read its own files or service instead.

Export a **default `ClientAdapter`** with a descriptor containing `id`, `name`,
your adapter's `version`, and `contractVersion: ADAPTER_API_VERSION` (currently 1).
The implementation version and API version are independent. Hosts reject missing
or unsupported API versions before connecting, with adapter-specific remediation.
Breaking contract/model changes require a new API version; additive optional
fields may remain in v1. There is no automatic downgrade or version negotiation.

`connect(config, context)` validates adapter-specific configuration. Use
`context.source.sourceId` for every identity and reference, and return actual
capabilities on the connection. Use stable client IDs, not titles, list positions,
timestamps of observation or credential-bearing paths. Different source instances
may safely emit identical local IDs.

Implement `listSessions`, `readSession` and idempotent `close`. Watches are optional.
An unpaginated adapter returns `nextCursor: null`; paginated adapters use opaque,
noncycling cursors. Honor operation and connection abort signals, release timers,
sockets/watchers on close, and reject transport/authentication failures instead of
returning empty successful data. The host owns bounded retries and reconciliation.

## Accounting and updates

- Unknown is `null`, not zero. Keep recorded zero costs and missing categories.
- Label measured/inferred timing; never fabricate timestamps or token semantics.
- Record identity survives running → completed/failed transitions.
- Return whole-record replacements, not field patches. Scope checkpoints to the
  source/session and treat them as opaque JSON, committed by the host atomically.
- A null checkpoint requires a full snapshot. Full reconciliation does **not**
  delete absent history: supply explicit, provenance-bearing tombstones only when
  the source confirms deletion. Failed scans and API retention are not deletions.
- Keep credentials out of provenance and logs. Forks/subagents use explicit links.

See [the full boundary semantics](ADAPTER-CONTRACT.md) and [ingestion lifecycle](INGESTION.md).

## Install without changing the host

Use Node 22.13+ and install your package alongside the dashboard. Source modules
must be runnable by Node (plain JavaScript, or erasable TypeScript on supported
Node versions outside `node_modules`; publish compiled JavaScript for installed
packages). This package ships compiled JavaScript for its public API, example and
test suite. External modules are loaded at runtime and are not bundled into
the dashboard. For example, save this as `sources.json` beside your installation:

```json
[
  {
    "sourceId": "example:local",
    "clientType": "fixture",
    "label": "Example adapter",
    "adapter": "agent-stats/example",
    "config": {}
  }
]
```

```sh
node node_modules/agent-stats/dist/server.js --sources sources.json
```

`adapter` accepts a package export, an absolute path or a `./relative/module.mjs`
path. Package and relative-path resolution start at the **source configuration
file**, not the dashboard package. The module's default export is validated before
startup. Custom `config` is passed unchanged; resolve adapter-owned paths yourself.
Built-in Pi/OpenCode sources continue to work without an `adapter` field.
Only load trusted code: adapter modules execute with the dashboard's privileges.
Adding an adapter needs no UI, SQL or route changes.

## Reusable contract tests

Import `adapterContractTests` from `agent-stats/testing` in a
Node test file. Pass a factory returning a **fresh backend** for each test:

```js
import { adapterContractTests } from 'agent-stats/testing';
import { createFixtureAdapter, capabilities } from 'agent-stats/example';

adapterContractTests('my adapter', () => ({
  ...createFixtureAdapter(),
  source: { sourceId: 'test', clientType: 'fixture', label: 'Test', capabilities },
  config: {},
}));
```

Replace the example factory with your adapter and controllable fixture service or
filesystem. The fixture needs at least two sessions and a running model request
with unknown output tokens, recorded total and TTFT. Its controls are:

- `advance()`: complete that request under its existing identity.
- `remove()`: confirm deletion of that request and emit a tombstone.
- `failNext()`: make one discovery/read operation reject transiently.
- `cleanup()` (optional): release fixture resources after the test.

The suite checks discovery termination, unique/stable source-scoped identities,
reconnect, incremental replacement, missing values, idempotence, conservative
reconciliation, explicit deletion, coordinator retries, cancellation and shutdown.
It supports single-page adapters; add adapter-specific tests to exercise actual
multi-page boundaries, authentication, malformed data and optional watch replay.
The suite uses an in-memory SQLite store and the real ingestion coordinator;
production adapters must not import this test-only entrypoint.

## Client launchers

Both client integrations use `src/dashboard/launcher.ts` to find/start the
same dashboard runtime, open a URL and report failures. Optional Pi timing hooks
and model-registry snapshots remain in the Pi integration, not in this API.
Configure integration-launched sources with `AGENT_STATS_SOURCES`; select the
opening view with `AGENT_STATS_SOURCE_ID`. The source file must exist before `/stats` runs.
Configuration fingerprints prevent reuse of a differently configured process.
After changing source configuration, `/stats` may start another process on the
next port; stop the old one or allow its idle timeout to expire.
