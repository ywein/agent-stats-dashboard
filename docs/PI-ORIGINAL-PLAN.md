# pi-stats-web — plan

> **Status (2026-09-29): Phase 1 and Phase 2 are implemented** as a standalone extension (no omp or Bun). See README.md. Validated against omp's own ingest of the same sessions: identical request, token, tool-call and cost totals, and the same main/subagent split. Additionally, claude-bridge is priced ($31.12 that omp reported as $0), and project folders use exact paths. Remaining work is Phase 3 (Traces is already ported; the frustration judge and model taxonomy are not).

Goal: bring omp's `omp stats` web dashboard (http://127.0.0.1:3847) to pi as an extension:
`/stats` starts a local server over `~/.pi/agent/sessions` and opens the browser.

## What exists

| | omp-stats (`can1357/oh-my-pi/packages/stats`, MIT) | pi-stats-ext (installed) |
|---|---|---|
| UI | React web app, 11 pages (Overview, Models, Providers, Costs, Requests, Errors, Traces, Tools, Frustration, Projects, Gain) | TUI overlay: Overview/Models/Projects/Sessions |
| Storage | `bun:sqlite` `~/.omp/stats.db`, raw tables + hourly rollups + triggers | JSON cache `~/.pi/agent/pi-stats/cache.json` |
| Size | ~7.8k server + ~11k client LOC (without tests) | ~1.3k LOC |
| Runtime | **Bun only** (`bun:sqlite`, `Bun.serve`, Bun build of client) | Node (pi) |

So the gap vs. what you already have is: the web UI, per-request latency/TTFT/TPS, errors, tool stats, traces, and frustration/gain.

## Findings that drive the design

1. **The session format is ~compatible.** Both use `session` v3 JSONL with `message` entries (`role: assistant`, `usage{input,output,cacheRead,cacheWrite,totalTokens,cost}`, `stopReason`, `errorMessage`, `toolCall` blocks, `toolResult`). omp adds entry types (`title`, `credential_pin`, …) that pi doesn't have, which is harmless.
2. **pi records no `duration` / `ttft`.** omp's parser just reads `msg.duration`/`msg.ttft`. Pi messages don't have them, so latency, TTFT and TPS columns would be empty unless we capture them live (see Phase 2).
3. **Cost is often 0 in pi.** `claude-bridge` (245 msgs), some `openai`/`anthropic` messages are unpriced. omp reprices from `pi-catalog`. We use `ctx.modelRegistry` model `cost` instead.
4. **Subagent layout differs.** pi-subagents writes `<project>/<session>/<uuid>/run-N/session.jsonl`, plus untyped `recordType` lines that must be skipped. omp's "depth > 2 = subagent" rule still works.
5. **Node 26 has `node:sqlite`**, so the omp schema and SQL port over almost verbatim. `Bun.serve` becomes `node:http`, which is small.
6. omp's `pi-utils` honors `PI_CONFIG_DIR`, so `PI_CONFIG_DIR=.pi omp stats --port 3848` may already work on pi data. That makes it a zero-code spike (step 0).

## Approach: port omp-stats, don't rewrite it

Vendor the omp server and client, swap the Bun and omp deps for Node and pi equivalents, and drop the omp-only features. Keep the SQL schema and API shape so the React client works unchanged.

### Phase 0: spike (≈30 min, no code)
- Run `PI_CONFIG_DIR=.pi omp stats --port 3848`. It writes `~/.pi/stats.db`, so delete that afterwards.
- Check which pages render with pi data and which are empty. This confirms findings 1–4 and becomes the acceptance checklist.

#### Phase 0 results (2026-09-29, omp 18.4.3)
`PI_CONFIG_DIR=.pi omp stats --port 3848` works on pi data. It writes only `~/.pi/stats.db*` and `~/.pi/logs`, and leaves `~/.omp` alone.
- **Totals match a direct count of the JSONL files**: 156 files, $500.85, 727M tokens, 5,903 main requests. Subagent messages: 627 in omp vs 645 counted directly (likely fork dedup).
- **Pages with real data**: Overview, Models, Providers, Costs, Requests, Errors, **Traces** (subagents folded in), Tools, Projects. Live sync picks up the current session.
- **Latency / TTFT / Tokens/s**: `-` everywhere, as expected (finding 2).
- **claude-bridge (261) and openai (1) show as priced at $0** and "Unpriced requests 0". omp doesn't flag them (finding 3 stands).
- **Frustration**: regex path works (225 messages). Judge not run.
- **Gain**: empty (snapcompact is omp-only).

Implication: the cheapest real plugin is a ~20-line `/stats` command that spawns this. It needs `omp` installed. Phase 1 is only worth doing to drop that dependency or to fix pricing and latency.

### Phase 1: MVP extension (Overview, Models, Costs, Projects, Requests, Errors, Tools)
```text
package.json          pi.extensions: ["./src/index.ts"]; deps: react, react-dom, lucide-react
src/index.ts          registerCommand("stats"): start server once per process, open URL; session_shutdown → close
src/server.ts         node:http port of omp server.ts (routes /api/stats*, /api/sync, /api/events SSE, static client)
src/db.ts             omp db.ts + rollup.ts on node:sqlite (DB at ~/.pi/agent/pi-stats/stats.db)
src/parser.ts         omp parser.ts; sessionsDir = join(getAgentDir(), "sessions"); skip untyped lines
src/aggregator.ts     omp aggregator; drop worker threads + file-lock (single process, WAL is enough)
src/pricing.ts        fill cost when usage.cost.total == 0 using modelRegistry.find(provider, model).cost
client/               omp src/client, prebuilt with esbuild into dist/client (committed or built on prepublish)
```
Dep swaps:
- `@oh-my-pi/pi-utils` (`getSessionsDir`, `readLines`, `logger`, formatters) → `getAgentDir()` from pi plus ~30 lines of local helpers.
- `@oh-my-pi/pi-catalog` (`classifyModel`, bundled prices) → drop `classifyModel` (only used for grouping/labels) and use `ctx.modelRegistry` for prices.
- `@oh-my-pi/pi-ai` types → `@earendil-works/pi-ai` types (same lineage).

Port 3847 collides with omp, so default to **3848**, with omp's `port-conflict.ts` fallback reduced to "try next port".

### Phase 2: latency capture (Requests TTFT/TPS, Models speed)
Small live hook in the same extension:
- `before_provider_request` → t0; first `message_update` → ttft; `message_end` → duration.
- Append `{sessionFile, timestamp, responseId, duration, ttft}` to `~/.pi/agent/pi-stats/timings.jsonl`. This avoids bloating the transcript; `appendEntry` is the alternative if you want it in-session.
- The parser joins on `responseId` (fallback: message timestamp). Historical sessions stay without latency, which is unavoidable.

### Phase 3: optional, only if missed
- **Traces** (`trace.ts` 1.2k LOC + timeline canvas): needs tool timings, which can come from `tool_execution_start/end` into the same sidecar.
- **Frustration** (LLM judge via pi-ai `Judge`) is the least portable part; reimplement it with `ctx.modelRegistry` + `complete()` or skip it.
- **Providers / usage windows**: depends on omp's auth-broker, so skip. `@narumitw/pi-usage` already covers quota windows.
- **Gain**: omp-specific tool-savings metric, so skip.

## Risks
- **Drift from upstream.** Keep the vendored files as close to upstream as possible and put the swaps in a `compat.ts` so omp updates can be re-pulled.
- **jiti + React/TSX.** Extensions load TS via jiti, so the client must be prebuilt; never import the client from `index.ts`.
- **Cost of initial sync.** With ~160 pi sessions it's fine. omp's newest-first background sync + SSE progress comes along for free.
- **License.** omp-stats is MIT, so keep its LICENSE/attribution in the vendored dirs.

## Alternative (cheaper): extend pi-stats-ext
If you only want the numbers and not the web UI, add Requests/Errors/Tools views to pi-stats-ext's TUI (≈300–500 LOC, possibly upstream as a PR). Phase 2's timing capture applies either way.

## Acceptance
- `/stats` opens the dashboard; the Overview totals match a `python`/`sqlite` recount over `~/.pi/agent/sessions`.
- claude-bridge usage shows non-zero cost (or is explicitly flagged unpriced).
- Subagent runs show up as `agent_type=subagent`, not as separate projects.
- New turns show up without a manual refresh (watcher + SSE).
- After Phase 2, new requests have TTFT/duration.
