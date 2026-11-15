# Architecture & Cross-Module Contracts

This file is the integration contract between modules. TASK.md is the product spec; this
file fixes the interfaces so that modules built in parallel fit together. Shared TypeScript
types live in `runner/types.ts`.

## Repository layout and ownership

| Area | Paths | Owner |
|---|---|---|
| Benchmark (visible to coding agent) | `benchmark/spec/`, `benchmark/starter/`, `benchmark/docker/` | benchmark |
| Reference implementation (hidden) | `evaluator/reference-app/` | benchmark |
| Design generation | `scripts/generate-design.ts`, `scripts/build-image.ts` | benchmark |
| Runner | `runner/**`, `configs/baseline/**`, `configs/baseline-api/**` | runner |
| Evaluator (hidden) | `evaluator/**` except `reference-app/` | evaluator |
| Storage | `storage/**` | research |
| Researcher | `researcher/**` | research |
| CLI | `scripts/run-benchmark.ts`, `scripts/start-research.ts`, `scripts/results.ts`, `scripts/generate-report.ts` | research |
| Dashboard | `dashboard/**`, `scripts/dashboard.ts` | dashboard |
| Tests | `tests/<area>/*.test.ts` (vitest) | each owner for its area |

Root `package.json` already has all root dependencies (`@anthropic-ai/sdk`, `better-sqlite3`,
`playwright`, `yaml`, `pngjs`, `pixelmatch`, `tsx`, `vitest`, `typescript`) and all npm scripts.
Avoid adding root dependencies. Don't hand-edit root `package.json`. The dashboard and starter have
their own `package.json`.

## Execution model

```
host: researcher loop ──► runBenchmark(config) ──► runCodingAgent ──► evaluateRun ──► storage
                                                     │                  │
                                    agent loop on HOST│                  │ app container (fresh, from snapshot)
                                    tools via docker exec                │ host Playwright chromium → 127.0.0.1:<port>
                                                     ▼                  ▼
                                coding container (network=none)   eval container (no egress, port published to 127.0.0.1 only)
```

* **The agent loop runs on the host.** Model calls go from host → provider. API keys never enter
  any container. Each tool call is executed inside the coding container with `docker exec` as a
  non-root user. That means the coding container needs **no network at all** (`--network none`).
* **Dependency control:** the benchmark image (`frugal-bench:<starterHash>`) bakes
  `benchmark/starter` plus its `node_modules`. The agent can't install new packages because it has no
  network. The allowed dependency set is whatever the starter declares.
* Container limits: `--cpus 2 --memory 2g --pids-limit 512 --read-only` root fs with a writable
  `/workspace` and tmpfs `/tmp`, `--cap-drop ALL`, `--security-opt no-new-privileges`, user `node`
  (uid 1000), no volumes from the host except what the runner explicitly copies, and no Docker socket.
  Labels: `frugal.role=coding|eval`, `frugal.runId=<id>` so cleanup can find abandoned containers.
* **Snapshots:** after the coding run, the runner copies `/workspace` **without node_modules** to
  `results/runs/<runId>/app/`, then destroys the coding container. The evaluator starts a **fresh**
  container from the same image, copies the snapshot over `/workspace` (keeping the image's
  node_modules), runs `npm run build` and `npm start`, and destroys it afterwards.
* The coding container also gets `/spec` (read-only copy of `benchmark/spec/`). It never sees
  `evaluator/`, `researcher/`, `results/`, or `configs/`.
* Disk is limited (~20 GB free on the dev machine). Use `node:22-bookworm-slim`, one shared
  image, remove containers after use, and don't pull large images.

## Coding-agent backends and the subscription gateway

`AgentConfig.backend` is `'api'` (default when absent; `configs/baseline-api`) or `'claude-code'`
(`configs/baseline`). The api backend is the execution model above. The claude-code backend runs the real
Claude Code CLI **inside** the coding container on the user's Claude subscription:

```
coding container (frugal-bench-cc:<hash>; per-run `--internal` network only)
  claude -p … ANTHROPIC_BASE_URL=http://frugal-gateway:8080 CLAUDE_CODE_OAUTH_TOKEN=<placeholder>
      │
forwarder container (same benchmark image, node TCP one-liner; internal net + default bridge)
      │  host.docker.internal:<port>  (Docker Desktop → host loopback)
gateway on host 127.0.0.1:<port> (runner/gateway.ts) ── Bearer <real token> ──► https://api.anthropic.com only
```

* `runner/gateway.ts` is the **only** code that reads the real token (`CLAUDE_CODE_OAUTH_TOKEN` from `.env`,
  created by `claude setup-token`).
  * It replaces the placeholder bearer, strips other credential headers, refuses non origin-form request
    targets, and streams responses through byte-for-byte.
  * It records one `UsageRecord` per `/v1/messages` call, for the gateway's role and runId. The purpose is
    `agent-turn`, `background` (another model) or `count-tokens` (0 tokens).
  * It enforces `maxTotalTokens` and `maxModelCalls` (a 400 once reached) and detects subscription
    usage-limit 429s.
  * It logs paths and status codes only.
* Host-side Claude Code (the research agent and the browser agent) uses
  `runClaudeHeadless({cwd, prompt, gateway, args, env, timeoutSec, streamFile, signal})` from
  `runner/claude-code.ts`. It isolates the process with a temp `HOME` and `CLAUDE_CONFIG_DIR`,
  `--setting-sources ""`, `--strict-mcp-config` and a minimal env.
  * Research agent (`researcher/research-agent-claude-code.ts`, gateway role `research`): empty temp
    cwd, `--tools ""`, no MCP, `--json-schema` proposal → `validateProposal` (one retry).
  * Browser agent (`evaluator/browser-agent-cc.ts`, gateway role `evaluator`): empty temp cwd,
    `--tools ""`, only `@playwright/mcp` via `--mcp-config` attached over CDP to a harness-owned
    Chromium (the harness asserts on the same page), allowlisted MCP browser tools, `--json-schema`
    verdict. `LaunchedApp` gains `agentUrl` (faultable listener of the eval HTTP forwarder,
    `evaluator/fault-proxy.ts`) and `setFaultMode(off | fail-mutations-500 | fail-all-api-500)`
    (host-only, via `docker exec`); `app.url` is never faulted.
  * `EvaluationResult.usageLimitResetAt` and `ResearchProposalError.usageLimitResetAt` signal a
    subscription usage limit; the research loop waits for the reset and retries.
* Coding runs: `runCodingAgent` → `startGateway({role:'coding', limits})` → `createGatewayNetwork`
  (runner/gateway-network.ts) → `createSandbox(cc image, network, tmpfs /home/node)` → skills and CLAUDE.md
  go to `/home/node/.claude` → `runClaudeCodeInSandbox` → `streamToTrace` → snapshot → destroy the
  container, network, forwarder and gateway.
* `CodingRunResult` gains `backend`, `usageLimitResetAt` (with status `infra_error` and failureReason
  `usage_limit…`) and `usageCrossCheck` (gateway totals vs Claude Code's `result` totals; the gateway is
  authoritative).
* The image is `frugal-bench-cc:<sha256(benchmark tag + runner/docker/claude-code.Dockerfile + version)[:32]>`:
  the benchmark image (unchanged) plus `@anthropic-ai/claude-code@2.1.325` in `/usr/local`. The Claude Code
  version must equal the host CLI's (`CLAUDE_CODE_VERSION` in runner/claude-code.ts).
* Forwarder containers and networks carry `frugal.role=coding` and `frugal.runId`.
  `cleanupAbandonedContainers()` also removes matching coding networks.

## Benchmark app contract (also stated in `benchmark/spec/requirements.md`)

* Working dir `/workspace`. `npm run build` builds the frontend. `npm start` starts ONE Node
  process that serves the API under `/api` and the built frontend at `/`.
* Env: `PORT` (default 3000) and `DATABASE_PATH` (default `./data/todos.db`). The process must
  create the DB/table if missing.
* Readiness: `GET /api/todos` returns 200.
* Stack: React (Vite) frontend, Express backend, `better-sqlite3`. All are already in the starter.
* Font: Inter via `@fontsource/inter` (bundled in the starter, so no network needed).

### Data model
`Todo = { id: number, title: string, completed: boolean, createdAt: string /* ISO-8601 UTC */ }`

SQLite table (exact, so the evaluator can inspect the DB):
```sql
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
```

### API (full detail in `benchmark/spec/api-contract.yaml`)
* `GET /api/todos` → 200 `Todo[]` ordered by `createdAt` asc, then `id` asc.
* `POST /api/todos` `{title}` → 201 `Todo`. Title is trimmed and must be 1–200 chars. `completed` starts as false.
* `PATCH /api/todos/:id` `{title?, completed?}` (at least one field) → 200 `Todo`.
* `DELETE /api/todos/:id` → 204.
* Errors: `{ "error": { "code": string, "message": string } }`, with codes
  `VALIDATION_ERROR` (400), `NOT_FOUND` (404), `INTERNAL_ERROR` (500). A non-integer id → 404.
  Unknown fields are ignored. Wrong types (title not a string, completed not a boolean) → 400.

### UI accessibility contract (the basis for selectors in the deterministic tests)
* Heading `h1` with the text `Todos`.
* New-todo form: text input with accessible name `New todo`, submit button `Add`. Pressing Enter submits.
  The input clears on success.
* List: `<ul aria-label="Todo list">` with one `<li>` per visible todo.
* Per item: checkbox named `Toggle <title>`, button `Edit <title>`, button `Delete <title>`.
  Completed items show the title with a line-through.
* Edit mode: a text input named `Edit title`, prefilled. Enter or a `Save` button saves; Escape or a `Cancel`
  button cancels.
* Filters: buttons `All`, `Active`, `Completed`, with `aria-pressed="true"` on the current one.
* Counter text: `N item(s) left` (`1 item left`, `0 items left`, `3 items left`).
* Validation errors and API errors appear in an element with `role="alert"`. The app must stay usable
  after an API error. When a mutation fails, the UI must not show the change as succeeded
  (it either reverts or never applies it).
* Loading state: an element with `role="status"` (e.g. "Loading…") while the initial fetch is pending.
* Empty state text when no todos match the filter: `No todos`.

### Visual contract
* Reference images: `benchmark/spec/design.png` (desktop 1280×800, fixtures from `fixtures.json`
  "design" set, filter All) and `benchmark/spec/design-mobile.png` (390×844, same data).
  Both are generated from the hidden reference implementation by `scripts/generate-design.ts`
  and then frozen. `benchmark/spec/design-tokens.md` gives exact colors, sizes and spacing.
* Capture settings: Playwright chromium (the version pinned in the root package.json),
  deviceScaleFactor 1, `animations: 'disabled'`, `caret: 'hide'`, reduced motion, en-US locale, UTC
  timezone. Fixed dates are NOT shown in the UI, so createdAt doesn't affect pixels.

## Module APIs (cross-boundary functions)

```ts
// runner/config.ts
loadConfig(id: string): AgentConfig            // id = 'baseline' | 'experiments/001' (dir under configs/)
hashConfig(cfg: AgentConfig): string           // sha256 over canonical JSON
snapshotConfig(cfg: AgentConfig, destDir: string): void

// runner/providers/index.ts
createProvider(name: string): ModelProvider    // 'anthropic' | 'mock'

// runner/token-tracker.ts
class TokenTracker { constructor(ctx: {role: AgentRole; runId?: string; experimentId?: string; usageFile?: string});
  wrap(provider: ModelProvider, purpose?: string): ModelProvider;  // records every call
  records(): UsageRecord[]; totals(): TokenTotals; }
sumUsage(records: UsageRecord[]): TokenTotals
computeCost(model: string, u: {...tokens}): { costUsd: number; estimated: boolean }

// runner/sandbox.ts
createSandbox(opts: { image: string; runId: string; role: 'coding' | 'eval'; ... }): Promise<Sandbox>
ensureImage(): Promise<{ image: string; imageId: string; starterHash: string }>
cleanupAbandonedContainers(): Promise<number>

// runner/run.ts
runCodingAgent(opts: { config: AgentConfig; runId?: string; experimentId?: string; seed: number;
  provider?: ModelProvider; signal?: AbortSignal }): Promise<CodingRunResult>
  // config.backend 'claude-code' → Claude Code in the container (a mock provider falls back to the api loop)

// runner/gateway.ts  — the only holder of the subscription token
startGateway(opts: { role: AgentRole; runId?; experimentId?; usageFile?; limits?: { maxTotalTokens?; maxModelCalls? };
  onUsageRecord?; mainModel?; onUsageLimit?; onLimitExceeded? }): Promise<GatewayHandle>
  // GatewayHandle { port; hostUrl; containerUrl; tracker; usageLimitResetAt(); limitExceeded(); stats(); stop() }
PLACEHOLDER_OAUTH_TOKEN: string;  hasSubscriptionToken(): boolean

// runner/claude-code.ts
runClaudeHeadless(opts: { cwd; prompt; gateway; args: string[]; env?; timeoutSec; streamFile; signal? }):
  Promise<{ exitCode: number | null; timedOut: boolean; result: any | null; events: any[] }>
runClaudeCodeInSandbox(...); streamToTrace(events, opts?): TraceEntry[]

// runner/claude-code-image.ts
ensureClaudeCodeImage(): Promise<{ image; imageId; starterHash; baseImage }>

// evaluator/index.ts
evaluateRun(opts: { runId: string; appDir: string; suite: 'dev' | 'holdout'; seed: number;
  provider?: ModelProvider; skipBrowserAgent?: boolean; outDir?: string }): Promise<EvaluationResult>
// evaluator/score.ts  — the ONLY place pass/fail is decided
scoreEvaluation(checks: CheckResult[], visualScore: number, threshold: number): { passed: boolean; summary: string }

// storage/db.ts
openDb(path?: string /* default results/benchmark.db */): Db  // insert/update/query helpers

// researcher/experiment.ts
runBenchmark(opts: { configId: string; runs: number; suite?: 'dev' | 'holdout'; experimentId?: string; ... }):
  Promise<{ coding: CodingRunResult; evaluation: EvaluationResult | null }[]>
```

## Results layout (append-only; never overwrite)

```
results/
  benchmark.db                 SQLite (experiments, runs, evaluations, usage_records, artifacts)
  experiments.jsonl            one line per experiment state change
  logs/<date>.jsonl            structured logs (runner/logger.ts)
  runs/<runId>/
    run.json                   CodingRunResult
    trace.jsonl                agent turns + tool calls
    usage.jsonl                raw UsageRecords (coding role)
    claude-stream.jsonl        raw Claude Code stream-json (claude-code backend)
    config/                    config snapshot
    app/                       generated app snapshot (no node_modules)
    eval/<suite>/report.json   EvaluationResult
    eval/<suite>/screenshots/  …
    eval/<suite>/browser-trace.jsonl
  best-config/                 copy of the current best verified config + summary.json
```

## Integrity rules
* `evaluator/`, `benchmark/`, `storage/` schema, `runner/token-tracker.ts`, and thresholds are
  out of bounds for the researcher. The research agent returns a structured proposal. Code in
  `researcher/` checks it against a whitelist (`system-prompt.md`, `skills/*.md`, `tools.json`,
  and approved `config.json` fields only). Each candidate is written to a NEW
  `configs/experiments/<id>/` directory, hashed, and made read-only.
* Results from the mock provider are flagged `usedMockProvider` and can never become the best config.
* The visual threshold (default 95) and verification run count are fixed in
  `evaluator/score.ts` and the research config respectively, and the research agent can't change them.
