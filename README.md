# Frugal: autonomous token-efficiency benchmark

Frugal searches for the **most token-efficient configuration of an AI coding agent** that still
builds a complete, visually faithful full-stack todo app (React/Vite + Express + better-sqlite3).

It repeats this loop unattended:

1. A **research agent** proposes a change to the coding agent's configuration (system prompt,
   skills, tool settings, a few whitelisted config fields).
2. The **coding agent** builds the app from a starter repo inside a fresh, network-less Docker container.
3. A hidden **evaluator** starts the app in another fresh container and runs API/DB tests,
   deterministic Playwright UI scenarios, an independent **LLM browser agent**, and a visual comparison
   against a frozen reference design.
4. Every coding-agent token is recorded. A candidate replaces the current best only when **all
   verification runs pass every mandatory check** and its **median** token count is lower.

Everything lands in SQLite (`results/benchmark.db`) plus on-disk artifacts, and is viewable with a
CLI, Markdown reports and a read-only dashboard.

> **Status in one line:** the pipeline is verified end to end. The first real run of the Claude Code
> baseline (subscription, `--skip-browser-agent`) **passed 59/59 checks with visual score 100.0 using
> 161,546 coding tokens** (2026-11-15). The api backend (`baseline-api`) has still never called a real
> model. See [Status](#status-what-is-and-isnt-verified).

---

## Architecture

```
host: researcher loop ──► runBenchmark(config) ──► runCodingAgent ──► evaluateRun ──► storage (SQLite + results/)
                                                     │                  │
                                    agent loop on HOST│                  │ app container (fresh, from snapshot)
                                    tools via docker exec                │ host Playwright chromium → 127.0.0.1:<port>
                                                     ▼                  ▼
                                coding container (network=none)   eval container (no egress, port published to 127.0.0.1 only)
```

* **Two coding-agent backends** (`backend` in the config, see [Coding-agent backends](#coding-agent-backends)):
  * `claude-code` (the **baseline**): the real **Claude Code CLI** runs *inside* the coding container on
    your Claude **subscription**. Its only network path is a per-run forwarder to the host **gateway**
    (`runner/gateway.ts`), which swaps a placeholder token for the real one and records every call's usage.
  * `api` (`configs/baseline-api`): the runner's own agent loop runs **on the host** and calls the
    Anthropic API with `ANTHROPIC_API_KEY`. Each tool call runs inside the coding container
    (`--network none`) via `docker exec` as the non-root user `node`.
* No API key or subscription token ever enters a container.
* One shared image, `frugal-bench:<starterHash>` (`node:22-bookworm-slim` + `benchmark/starter` +
  its `node_modules`). The coding container has no network, so the agent can only use the starter's dependencies.
* After the coding run, `/workspace` (without `node_modules`) is copied to `results/runs/<runId>/app/`
  and the coding container is destroyed. The evaluator starts a **fresh** container from the same
  image, copies the snapshot in, runs `npm run build` and `npm start`, evaluates it, and destroys it.
* The contracts between modules are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), the shared types
  in `runner/types.ts`, and the product spec in `TASK.md`.

| Directory | What it contains |
|---|---|
| `benchmark/spec/` | What the coding agent sees: requirements, API contract, design tokens, `design.png`, `design-mobile.png`, fixtures; frozen by `FROZEN.json` (sha256) |
| `benchmark/starter/` | The starter repo baked into the image |
| `benchmark/docker/` | Dockerfile and `ensureImage()` |
| `runner/` | Agent loop, tools, providers (`anthropic`, `mock`), `TokenTracker`, Docker sandbox |
| `evaluator/` | Hidden evaluator, scoring (`score.ts`), visual scoring, holdout suite, reference app |
| `researcher/` | Research loop, research agent, whitelist/optimizer, history digest |
| `storage/` | SQLite schema + queries (append-only) |
| `dashboard/` | Read-only React dashboard + its HTTP server |
| `configs/` | `baseline/`, `experiments/NNN/` (created by the loop, read-only), `research.json` |
| `scripts/` | CLI entry points (`npm run …`) |
| `results/` | All outputs (gitignored) |

---

## Setup

Requirements: **Node.js ≥ 22**, **Docker** (Docker Desktop works), about 2 GB of free disk for the
image plus results.

```bash
npm install
npx playwright install chromium     # host browser used by the evaluator
npm run build:image                 # builds frugal-bench:<starterHash> (reused if present; --force rebuilds)
cp .env.example .env
claude setup-token                  # Claude Code 2.1.325 on the host; log in with your Claude subscription
#   → add the printed long-lived token to .env:  CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
npm run dry-run                     # checks everything; makes no model calls
```

The default (`baseline`) coding agent is Claude Code on your **subscription**, so no API key is needed.
`ANTHROPIC_API_KEY` is only needed for `configs/baseline-api` (the api backend). The first claude-code
run builds the coding image `frugal-bench-cc:<hash>` (about 20 s; the benchmark image plus Claude Code).
For `baseline`, the dry run also checks `CLAUDE_CODE_OAUTH_TOKEN`, the host Claude Code version (it must
be the pinned 2.1.325) and the coding image. A live smoke test that makes two cheap calls:
`npx tsx scripts/cc-smoke.ts` (Claude Code in a fresh container creates `/workspace/hello.txt`).

`npm run dry-run` checks Node, the Docker daemon, the image, the config, the frozen spec hashes,
Playwright Chromium, the DB and the API key. Without a key it prints
`✗ ANTHROPIC_API_KEY  missing — set it in .env` and exits 1. Every other check should be `✓`.

Environment variables (see `.env.example`): `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`; required
for the claude-code backend; read only by the host gateway), `FRUGAL_CLAUDE_BIN` (host `claude` binary,
default `~/.local/bin/claude`), `ANTHROPIC_API_KEY` (required only for the api backend),
`FRUGAL_EVALUATOR_MODEL` (browser agent, default `claude-sonnet-5-5`), `RESEARCH_MODEL` (research agent model;
the research agent itself runs on the Claude Code CLI with your subscription by default, `researchProvider: "claude-code"`),
`FRUGAL_DB_PATH`, `FRUGAL_RESULTS_DIR`, `FRUGAL_NO_CAFFEINATE=1`.

---

## Coding-agent backends

`AgentConfig.backend` is `'api' | 'claude-code'`. A missing value means `'api'`, so older configs behave and hash
exactly as before.

### `claude-code` (Claude Code CLI on a subscription)

```
host: runCodingAgent ──► gateway 127.0.0.1:<port>  ── real token swapped in ──► https://api.anthropic.com (only)
                             ▲  records usage.jsonl (role coding), enforces token/call limits
                             │ host.docker.internal:<port>
          forwarder container (default bridge + per-run --internal net, alias frugal-gateway:8080)
                             ▲
          coding container (frugal-bench-cc image, per-run --internal network ONLY)
            claude -p … --dangerously-skip-permissions   ANTHROPIC_BASE_URL=http://frugal-gateway:8080
                                                         CLAUDE_CODE_OAUTH_TOKEN=<placeholder>
```

* **Image:** `frugal-bench-cc:<hash(benchmark tag + runner/docker/claude-code.Dockerfile + version)>`, built
  idempotently by `ensureClaudeCodeImage()` (`runner/claude-code-image.ts`). It is the frozen benchmark image
  plus `@anthropic-ai/claude-code@2.1.325` installed globally under `/usr/local`, outside `/workspace`. That
  version ships one native binary, which adds about 368 MB uncompressed (about 172 MB compressed) to the image.
* **Invocation** (cwd `/workspace`, user `node`): `claude -p --output-format stream-json --verbose
  --dangerously-skip-permissions --no-session-persistence --strict-mcp-config --model <model> [--effort]
  [--append-system-prompt|--system-prompt <system-prompt.md>] [--tools] [--disallowedTools] [--settings]`.
  The task prompt goes in on stdin. It names `/spec` and `/spec/design.png`; `inlineSpecFiles` are embedded,
  and `designDelivery: inline-image` tells it to view the design first with the Read tool.
* **Config block** `claudeCode` (validated in `runner/config.ts`):
  * `systemPromptMode: 'append' | 'replace'`.
  * `tools?` and `disallowedTools?` (Claude Code tool names).
  * `settings?`: written to a file and passed with `--settings`. The keys `env`, `model`, `apiKeyHelper` and
    other credential, MCP or model keys are rejected.
  * `env?`: restricted to the allowlist `MAX_THINKING_TOKENS`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`,
    `BASH_MAX_OUTPUT_LENGTH`, `BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS`, `MAX_MCP_OUTPUT_TOKENS`,
    `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_SUBAGENT_MODEL`,
    `DISABLE_AUTO_COMPACT` and `DISABLE_COMPACT`. Values must be short tokens.
  * `claudeMd?: boolean`: the config's `CLAUDE.md` goes to `/home/node/.claude/CLAUDE.md`, the user level,
    so it never lands in the snapshot.
* **Other config fields:**
  * `model` and `effort` map to `--model` and `--effort`.
  * `thinkingBudget` maps to `MAX_THINKING_TOKENS`. `maxOutputTokensPerCall` (optional; `0` means Claude
    Code's default) maps to `CLAUDE_CODE_MAX_OUTPUT_TOKENS`.
  * `skills/*.md` become `/home/node/.claude/skills/<name>/SKILL.md`. Frontmatter (`name`, `description`) is
    generated when the file has none.
  * `tools.json` is optional and ignored; it is validated when present.
  * `temperature` and context strategies other than `none` are rejected.
  * `hashConfig` covers all new fields plus the pinned Claude Code version.
* **Limits:**
  * `maxRuntimeSec` is enforced with `timeout` on the process group in the container, plus a host backstop.
  * `maxTotalTokens` and `maxModelCalls` are enforced by the gateway. Once reached, the next call gets a 400
    and the run ends as `limit_exceeded`.
  * A subscription usage limit (a 429 with `anthropic-ratelimit-unified-*` headers, or a stream
    `rate_limit_event` with status `rejected`) stops the run as `infra_error` with failureReason `usage_limit…`
    and `usageLimitResetAt`. The research loop waits and retries instead of counting it as a failed config.
* **Accounting:**
  * The gateway's records (`usage.jsonl`) are authoritative. The purpose is `agent-turn` for the main model,
    `background` for side calls on another model, and `count-tokens`, recorded with 0 tokens because the API
    doesn't bill it.
  * `claude-stream.jsonl` keeps the raw stream. `run.json.usageCrossCheck` compares the gateway totals with
    Claude Code's own final `result` totals.
  * `costUsd` is the **API-equivalent** list price. A subscription has no per-call bill. 1-hour cache writes,
    which Claude Code uses, are priced at 2x input.
* **Trace:** the stream is converted into the usual `trace.jsonl` schema. Each assistant message becomes one
  `model_call`, each tool result one `tool_call` (with input and output), plus `start` and `end`. Subagent
  calls stay on the parent turn and are marked `subagent`.
* `--provider mock` with a claude-code config falls back to the api loop with the mock provider, for
  infra tests.

### Config extensions: helper scripts, hooks, subagents, slash commands (claude-code only)

```
configs/<id>/
  config.json            claudeCode.settings.hooks (validated, see below)
  system-prompt.md  CLAUDE.md  skills/<name>.md
  bin/<name>             helper scripts: name [a-z][a-z0-9_-]{0,31}, shebang required
                         (#!/bin/sh, #!/bin/bash, #!/usr/bin/env sh|bash|node, #!/usr/local/bin/node), max 8
  agents/<name>.md       custom subagents → /home/node/.claude/agents/<name>.md, max 8
  commands/<name>.md     slash commands  → /home/node/.claude/commands/<name>.md, max 8
```

* All of it is loaded by `loadConfig`, included in `hashConfig` (only when present, so existing configs keep
  their hashes) and written by `snapshotConfig`. Nothing goes into `/workspace`, so none of it reaches the app
  snapshot.
* **`bin/`** is installed root-owned and read-only (`0755` files, `0555` dirs) on a tmpfs at `/opt/frugal`.
  `/opt/frugal/bin` is put first on the claude process's `PATH`, and therefore on its Bash tool's and hooks' PATH.
  Each `/opt/frugal/bin/<name>` is a `/bin/sh` audit wrapper around the real script in `/opt/frugal/libexec/<name>`.
  It passes stdin, stdout, stderr and the exit code through, and appends one JSON line per run to
  `/tmp/.frugal/bin-audit.jsonl`: the script, args, exit code, duration, and the files under `/workspace`
  (excluding `node_modules`, `dist`, `.git`, `.vite`) created or modified while it ran. Scripts call each other
  by name or path, never as `node /opt/frugal/bin/x` (that runs the sh wrapper with node).
* **Agents and commands:** frontmatter is optional (agents get a generated `name`/`description`). Allowed
  keys for agents: `name, description, tools, disallowedTools, color, model`. For commands:
  `description, argument-hint, allowed-tools, disable-model-invocation, model`. `model` may only be `inherit`
  in agents, commands and skills (model changes go through the whitelist).
* **Hooks** (`claudeCode.settings.hooks`): `{ "<Event>": [{ "matcher"?: string, "hooks": [{ "type": "command",
  "command": "/opt/frugal/bin/<name> [plain args]", "timeout"?: 1-120 }] }] }`. Allowed events: PreToolUse,
  PostToolUse, PostToolUseFailure, PostToolBatch, Stop, SubagentStart, SubagentStop, SessionStart, SessionEnd,
  UserPromptSubmit, PreCompact, Notification. The rules: only `command` hooks (no prompt, agent or http hooks),
  no shell syntax, every referenced script must exist in `bin/`, and at most 16 handlers. With hooks, the
  runner passes `--include-hook-events`, so hook runs are in the stream, the trace and
  `run.json.configAudit.hookCounts`.
* The settings denylist still rejects `env`, `model`, `apiKeyHelper` and the other credential, MCP and model
  keys. It now also rejects `sandbox`, plugins (`enabledPlugins`, `extraKnownMarketplaces`, `pluginConfigs`),
  managed-policy keys, `skipDangerousModePermissionPrompt`, `subagentStatusLine` and `fileSuggestion`.
  `settings.permissions` may only hold `allow`, `deny` and `ask` rule lists (no `defaultMode` or
  `additionalDirectories`). `claudeCode.env` keeps its allowlist, so there are no `ANTHROPIC_*` overrides.

**What hooks can do, verified live in the container with Claude Code 2.1.325** (cheap runs, 2026-11-15):

| Mechanism | Result |
|---|---|
| Hook input (stdin JSON) | `session_id, transcript_path, cwd, prompt_id, permission_mode, effort, hook_event_name, tool_name, tool_input, tool_use_id, duration_ms`, plus `tool_response` (PostToolUse) or `error` (a string, already cut by Claude Code to about 10k chars) and `is_interrupt` (PostToolUseFailure). Bash `tool_response` is `{stdout, stderr, interrupted, isImage, noOutputExpected}`. |
| **PostToolUse `hookSpecificOutput.updatedToolOutput`** | **Replaces the tool result the model sees.** With `{...tool_response, stdout: <trimmed>}`, a 23,893-char `seq 1 5000` output reached the model as 1,540 chars. Printing nothing leaves the result unchanged. |
| PostToolUseFailure + `updatedToolOutput` | **Ignored.** Failed commands (non-zero exit) reach the model untrimmed (12,265 chars in the test). |
| **PreToolUse `hookSpecificOutput.updatedInput`** (with `permissionDecision: "allow"`) | **Rewrites the command before it runs.** `{ <cmd>\n} 2>&1 \| clip 1200; exit ${PIPESTATUS[0]}` clipped both a succeeding and a failing (exit 3) command to about 1.5k chars and kept the exit code (Bash runs under bash). This is the way to trim noisy failing builds. The model still sees its original command in its tool_use. |
| Stream events | `system` `hook_started` / `hook_response` with `hook_name` (`"PostToolUse:Bash"`), `exit_code`, `outcome`, `stdout`, `stderr`. |

### Anti-cheating guard (`researcher/config-guard.ts`)

TASK.md §9 says the researcher must not reuse application code generated during earlier runs; only configurations
carry forward. The research agent can read past transcripts that contain app code, so every config is checked
by `guardConfig(dir | files, opts) → { ok, violations: {file, rule, detail}[], similarity }`:

* **Where it runs:** in `validateProposal`, where violations come back as validation errors so the research
  agent's single retry can fix them. In `optimizer.applyProposal`, on the merged candidate, before an id is
  reserved. In `loadConfig`, for every config except `baseline-api`, so hand-made configs and `npm run benchmark`
  can't bypass it. And in the dry run (`Config anti-cheat guard`).
* **Size limits (`GUARD_LIMITS`):** 8 KB per markdown file, 4 KB per bin script, 8 KB per JSON file, and 40 KB
  for the whole config. Fenced code is limited to 30 lines per block and 60 per markdown file. String literals
  are limited to 240 chars and script lines to 400.
* **App-code heuristics** run over all text, including code blocks in markdown and JSON string values:
  * Express route definitions, `(req, res)` handlers, `express` / `better-sqlite3` imports.
  * `CREATE TABLE todos`, or two or more kinds of SQL statements on `todos`.
  * React state hooks together with todo data, JSX attribute expressions (3 or more), HTML/JSX markup
    (2 or more tags, or any `aria-label` naming a todo), React entry code.
  * Todo API client functions, browser-relative `fetch('/api…')`.
  * More than 12 CSS declarations in rule blocks, 8 or more hex colors together with 8 or more px values,
    6 or more CSS custom properties.
  * base64, hex, gzip (`H4sI`) or escape blobs, and decoders (`base64 -d`, `Buffer.from(…, 'base64')`, zlib, …).
  * In bin scripts, any write outside `/tmp` (redirects, `tee`, `cp`/`mv`/`sed -i`/…, `fs.writeFile*`).
    Shell comments are ignored, quote-aware. In markdown snippets, writes into
    `frontend/`, `backend/`, `src/`, `/workspace` or app source files.

  Prose that describes the requirements ("validate titles 1–200 chars", "use the exact table schema from the
  spec") and general engineering advice pass.
* **Similarity:** token 12-gram shingles, winnowed with window 4. Each config file is compared with every app
  snapshot under `results/runs/*/app` (source files only; no `node_modules`, `dist` or lockfiles) and with
  `evaluator/reference-app`, in two channels:
  * verbatim: rejected at 80 or more covered tokens, or at least 25% coverage with at least 30 tokens;
  * identifier-renamed (renamed identifiers collapse to one placeholder; keywords, framework APIs, numbers
    and punctuation are kept): rejected at 120 or more tokens, or at least 25% with at least 60.

  A config is also rejected when the covered tokens summed over all its files reach 160 (code split across
  many small files). The renamed channel has the higher bar because stock idioms look alike once names are
  erased. A real smoke-test `fetch` helper overlapped an agent's API client by 56 to 69 tokens. Ignored:
  k-grams that also occur in `benchmark/starter` or `benchmark/spec` (quoting the spec is not reuse), and
  snapshots of runs made with the config's own hash (they post-date it). Corpus fingerprints are cached in
  `results/.cache/config-guard-fingerprints.json`, keyed by path, size and mtime.
* **Runtime audit:** after each claude-code run, `run.json.configAudit` records every bin-script run (from the
  wrapper log), per-script counts, hook counts from the stream, app source files created or modified by a bin
  script, and the config-to-snapshot similarity. A run where a bin script wrote app source, or whose snapshot
  reproduces config content beyond the thresholds, is failed (`agent_error`, `failureReason: config_audit: …`).
  Limitation: the wrapper log lives in the agent-writable `/tmp`, so it is evidence, not proof. The static
  guard is the primary defense.

### Host-side Claude Code (researcher, browser agent)

`runClaudeHeadless()` in `runner/claude-code.ts` runs host `claude -p` through a gateway (`startGateway({ role })`).

* It uses a fresh temporary `HOME` and `CLAUDE_CONFIG_DIR`, `--setting-sources ""` and `--strict-mcp-config`,
  so none of your `~/.claude` (settings, CLAUDE.md, skills, plugins, hooks, MCP servers, memory) leaks in.
* It runs with a minimal env, the placeholder token, and telemetry and autoupdates off.
* It kills the process group on timeout or abort.

### Evaluator browser agent (Claude Code + Playwright MCP)

The 9 `browser.*` scenarios run on the Claude Code CLI with your subscription (`evaluator/browser-agent-cc.ts`).

* **Per scenario attempt** the harness launches its own headless Chromium (temporary profile, desktop
  1280×800 viewport, remote debugging on `127.0.0.1`), seeds the app and opens it.
* **Per goal phase** it runs one `claude -p` through a gateway with role `evaluator`, in an empty temp cwd:
  * `--tools ""`: **no built-in tools at all** (no Bash, Read, Write, Glob or Grep), so the agent can never
    read evaluator source or holdout files. No skills or slash commands either.
  * The only MCP server is the pinned `@playwright/mcp` (root devDependency), passed with `--mcp-config` +
    `--strict-mcp-config`. It attaches to the harness's Chromium over CDP.
  * Origins are restricted to the app, and `file://` navigation is blocked (the MCP default). Screenshots go
    to `eval/<suite>/screenshots/agent-<scenario>-a<attempt>-p<phase>-NN.png`.
  * Only an allowlist of 14 browser tools is enabled: snapshot, screenshot, click, type, press key, select,
    fill form, hover, navigate, back, wait, dialog, find and console. JS evaluation, `run_code`, file upload,
    tabs, routes, cookies and storage are disallowed.
* **Goals stay high-level**, as before. The verdict comes back through `--json-schema`
  `{success, observations}`. It is recorded but never trusted alone.
* **Deterministic assertions decide.** After each phase the harness runs the same API/DB/DOM assertions as
  before, on the very page the agent used (the MCP and the harness share it), so the filter state,
  reload and `role="alert"` recorder checks are unchanged.
* **Fault injection** (`browser.api_error`): the eval forwarder is a small HTTP-aware proxy
  (`evaluator/fault-proxy.ts`) with two listeners.
  * `app.url` is never faulted. It is used by the harness, the backend tests and the deterministic UI
    scenarios, which keep using `page.route`.
  * `app.agentUrl` serves the agent's page and can be switched between `off`, `fail-mutations-500` and
    `fail-all-api-500`.
  * Only the host can switch modes: a `docker exec` writes a mode file on the proxy's tmpfs. There is no
    network control channel.
* **Artifacts:** each phase's full stream-json transcript goes to `eval/<suite>/browser-agent/<scenario>-a<attempt>-p<phase>.jsonl`.
  `browser-trace.jsonl` gets goal, tool calls and results, verdict and assertion lines as before.
  Evaluator tokens are the gateway's UsageRecords, in `eval/<suite>/usage.jsonl` and `EvaluationResult.evaluatorUsage`.
* **Limits per phase:** 420 s, 400k tokens and 40 model calls. When one is hit, the verdict is empty and the
  assertions still decide.
* **Model and effort:** `FRUGAL_EVALUATOR_MODEL` (default `claude-sonnet-5-5`) and `FRUGAL_EVALUATOR_EFFORT`
  (default: the model's own).
* **No token:** without `CLAUDE_CODE_OAUTH_TOKEN` every browser check is `error` with a clear message.
  That is an evaluator failure, never a fake pass. A usage limit also gives `error`, and sets
  `EvaluationResult.usageLimitResetAt` so the research loop waits and retries the run.
* **api backend:** the old API tool loop is still used when `evaluateRun` gets an explicit `provider`
  (tests and infra only).

### Research agent (Claude Code)

`researchProvider: "claude-code"` (the default) runs each proposal attempt as one `claude -p`
(`researcher/research-agent-claude-code.ts`), through a gateway with role `research`.

* It runs in an empty temp cwd with `--tools ""`, no MCP servers and no skills. The only tool is Claude
  Code's `StructuredOutput`, so it cannot read the repo, the evaluator, the holdout suite or results.
* **Input:** the full context is in the prompt: the best config's files, the history digest and the
  allowed modification surface.
* **Output:** the answer comes back through `--json-schema`. It is then checked by the same strict
  whitelist validation as before, with one retry (a new conversation that includes the rejected answer
  and the reasons).
* **Tokens:** research tokens are the gateway's UsageRecords (role `research`), stored exactly as before
  (`results/research/usage.jsonl` plus the DB). Transcripts go to `results/research/streams/`.
* **Prompt for claude-code configs:** the research agent's system prompt names the levers specific to Claude Code:
  * the roughly 20–25k-token built-in system prompt and tool definitions paid on every call (`replace`
    vs `append`, restricting `claudeCode.tools`);
  * effort;
  * autocompaction thresholds;
  * Bash and file-read output lengths;
  * subagents;
  * skills vs `CLAUDE.md`.

---

## Commands

### `npm run benchmark -- [flags]`

Runs one configuration N times in sequence, evaluates every snapshot, and stores everything. Each
invocation is recorded as a `manual` experiment, so it shows up in `results` and in the dashboard.

| Flag | Meaning |
|---|---|
| `--config <id>` | `baseline` (default) or `experiments/NNN` |
| `--runs <n>` | Sequential runs (default 1) |
| `--suite dev\|holdout` | Evaluation suite (default `dev`) |
| `--provider mock\|anthropic` | Override the config's provider. `mock` makes no API calls; results are `[MOCK]` |
| `--mock-script default\|reference-app` | **Infra test only** (needs `--provider mock`). `default` writes one trivial file (expected: clean app failure). `reference-app` pushes the hidden reference app through `write_file` calls (expected: all deterministic + visual checks pass) |
| `--skip-browser-agent` | Skip the LLM browser agent. Results are `[NO-BROWSER-AGENT]` and never count toward promotion. Implied by `--provider mock`, with a warning |
| `--dry-run` | Environment check, no model calls |
| `--db <path>` | SQLite path (default `results/benchmark.db` or `$FRUGAL_DB_PATH`) |

Exit codes: 0 means all runs passed, 2 means some runs failed, 130 means interrupted, 1 means an error.

### `npm run research -- [flags]`

The unattended research loop. Settings come from `configs/research.json`; flags override them.

| Flag | Meaning |
|---|---|
| `--max-experiments <n>` | Max candidate experiments this session |
| `--max-total-tokens <n>` | Max tokens this session, all roles combined (coding + evaluator + research) |
| `--max-coding-tokens <n>` | Max coding-agent tokens this session (all runs combined) |
| `--max-cost <usd>` | Max **API-equivalent** cost this session (local price table; nothing is billed per token on a subscription). Off by default |
| `--max-usage-limit-wait <t>` | Longest wait for a subscription usage-limit reset, e.g. `6h` (default 6 h); a reset further away stops the loop |
| `--max-duration <t>` | Max active time, e.g. `3600`, `90m`, `8h` |
| `--max-runtime-per-experiment <t>` | Abort an experiment after this long |
| `--verification-runs <n>` | Verification runs per promising candidate |
| `--max-tokens-per-run <n>` | Per-run coding token cap (can only tighten the config's limit; config files untouched) |
| `--noise-margin <pct>` | Required improvement over the best median, in percent |
| `--resume` | Continue the latest session (its tokens, API-equivalent cost and time count against the budgets) |
| `--dry-run` | Print the effective settings and check the environment |
| `--provider mock\|anthropic` | Coding + evaluator provider override (`mock` ⇒ `[MOCK]`, never promoted; implies `--skip-browser-agent`) |
| `--mock-script default\|reference-app` | Infra test only, see above |
| `--research-provider claude-code\|anthropic\|mock` | Research agent provider. `claude-code` (default) runs the Claude Code CLI on your subscription (needs `CLAUDE_CODE_OAUTH_TOKEN`; the agent has no file or shell tools). `anthropic` uses `ANTHROPIC_API_KEY`. `mock` is a scripted `[MOCK]` agent that proposes a trivial skill file `skills/mock-note-N.md` (infra tests only) |
| `--research-model <id>` | Research agent model |
| `--skip-browser-agent` | Results `[NO-BROWSER-AGENT]`; nothing can be promoted |
| `--settings <file>` | Settings file (default `configs/research.json`) |
| `--db <path>` | SQLite path |

* **Pause:** `touch results/research.pause`. The loop finishes the current run, then waits. `rm results/research.pause` resumes it.
* **Stop:** Ctrl-C (or SIGTERM) once. The in-flight coding run is aborted, an in-flight evaluation is
  allowed to finish (usually under a minute without the browser agent), the experiment and session are
  marked `interrupted`, containers are removed, and the exit code is 130. A **second** Ctrl-C quits
  immediately; leftovers are recovered and cleaned up on the next start.
* **Subscription usage limits:** if a coding run, an evaluation or a research proposal stops because the
  Claude subscription hit its usage limit, the loop does **not** count it as a failure. It logs the hit,
  waits until the reported reset plus `usageLimitMarginSec` (120 s; 15 min if no reset time is known),
  then retries the same run or proposal. Ctrl-C interrupts the wait immediately, and the pause file
  holds the retry. Waits are recorded in the `usage_limit_waits` table (shown per session in
  `npm run report`). Waiting time is **not** counted against `--max-duration` or the per-experiment
  timeout. If the reset is more than `maxUsageLimitWaitSec` away, or limits recur 6 times in a row
  without progress, the loop stops with `usage_limit` (resume later with `--resume`).
* **Resume:** `npm run research -- --resume`. Interrupted experiments are not retried; they still
  count toward `--max-experiments`, so raise it if needed.
* **Keep the machine awake.** On macOS both CLIs automatically run `caffeinate -i -s` for their own
  lifetime. That does **not** stop sleep when a laptop lid is closed. Host sleep freezes the Docker VM,
  and after wake its clock lags, which caused spurious check failures (`createdAt … is not close to the
  current time`, `app not ready within 60s`) during development. Plug in and keep the lid open, or use
  a desktop or server.
* Don't run `benchmark` and `research` at the same time. Startup cleanup removes **all** leftover
  evaluation containers and networks (`frugal.role=eval`).

### `npm run results -- [flags]`

Terminal view: overview, experiment table, `--experiment exp-0003` detail (checks, diff, artifacts),
`--runs` (per-run tokens in/out/cacheRead/cacheWrite), `--limit N`, `--json`, `--db`.

### `npm run report -- [--out dir] [--db path]`

Writes `results/reports/<timestamp>.md` and `.json`: best config, best-over-time, experiment
history, tokens and API-equivalent cost by role, pass rate by config, sessions (with token budgets and usage-limit waits).

### `npm run dashboard -- [--port 4173] [--host 127.0.0.1] [--db path] [--no-build]`

A read-only dashboard (the DB is opened with `query_only`). It has an overview (best, baseline,
improvement, API-equivalent cost by role), an experiment history table, experiment detail (hypothesis, config diff,
runs, all checks, evaluation screenshots from `results/runs/<runId>/eval/<suite>/screenshots`, and an
agent-trace viewer grouped by turn), and charts (best tokens over time, tokens vs. visual score, pass
rate per config, cumulative cost). It builds `dashboard/dist` automatically the first time.
API: `/api/overview`, `/api/experiments`, `/api/experiments/:id`, `/api/runs/:id`, `/api/charts`,
`/artifacts/<path under results/>`.

### Other

`npm run build:image [-- --force]`, `npm run design:generate` (regenerates the frozen design
images from the reference app; refuses without `--force`), `npm run typecheck`, `npm test`.
`tsx evaluator/cli.ts --app <dir> [--suite dev|holdout] [--skip-browser-agent]` evaluates any app directory.

### Markers

* **`[MOCK]`**: produced by the mock provider. The token counts are synthetic (chars/4, flagged as estimated) and the cost is $0. Never promoted.
* **`[NO-BROWSER-AGENT]`**: evaluated without the LLM browser agent. The evaluation is incomplete, so
  `meetsQualityRequirements` is false. `db.recordPromotion` refuses such a summary, and it also refuses
  when any stored evaluation of the experiment has `browser_agent_skipped = 1`.

---

## How scoring works

`evaluator/score.ts` is the **only** place where pass/fail is decided. An evaluation passes iff:

* the app started (`startup.app`);
* every **mandatory** check passed. That means 32 backend/DB checks, 23 deterministic UI scenarios
  and 9 browser-agent scenarios (`browser.create/edit/complete/reopen/delete/filter/persistence/invalid_input/api_error`);
  a browser-agent check passes only if its deterministic API/DB/DOM post-assertions pass;
* no mandatory check has outcome `error` (an evaluator infrastructure failure, retried up to 2 times;
  such a run is reported as `evaluatorFailure`, not as an app failure);
* **visual score ≥ 95**. The threshold is fixed in code; callers may only make it stricter.

The full list of check IDs is in [`evaluator/README.md`](evaluator/README.md).

### Visual score

Per viewport: `score = 100 × (0.35·P + 0.25·S + 0.25·L + 0.15·T)`, where P is pixel match with
1 px tolerance (normalised by ink pixels), S is multi-scale SSIM, L is layout (bounding boxes of
key elements vs. the reference) and T is typography (font family, size and weight). Overall:
`0.6 × desktop (1280×800) + 0.4 × mobile (390×844)`. Details are in [`evaluator/VISUAL_SCORING.md`](evaluator/VISUAL_SCORING.md).

Calibration (the reference app with CSS degradations injected):

| Variant | Score |
|---|---|
| reference | **100.00** |
| card border-radius 4 px | 99.99 |
| Add button 4 px wider | 99.28 |
| shift 1 px | 97.64 |
| text colour gray-700 | 97.27 |
| *threshold* | *95* |
| accent colour green | 93.99 |
| shift 2 px | 91.06 |
| Arial instead of Inter | 88.10 |
| larger text | 85.35 |
| shift 4 px | 83.91 |
| tighter rows | 72.16 |
| narrow 480 px | 69.20 |
| empty starter | 47.61 |
| shift down 32 px | 47.13 |
| dark theme | 42.87 |
| unstyled | 40.63 |

In practice, 95 means following `design-tokens.md` exactly, to within about 1 px.

### Ranking

A configuration's metric is the **median coding-agent total tokens** over its verification runs.
A candidate is promoted only if **every** verification run passed, nothing was mock, the browser agent
ran, and `median < best median × (1 − noiseMargin)`. A cheap but failing config is worthless by construction.

---

## Token accounting

`runner/token-tracker.ts` is the single source of truth, and the research agent can't modify it.

* Every provider call is recorded as a `UsageRecord`. That includes agent turns, compaction,
  tool-output summarisation and **billed failed attempts** (`purpose: 'retry'`).
* `totalTokens = input + output + cacheRead + cacheWrite` (+ reasoning only when the provider reports it
  separately from output).
* Usage reported by the provider is authoritative. Anything estimated is flagged `usageEstimated` and
  shown as `(est.)`. Cost comes from a local price table (`PRICES`), so it's always flagged `costEstimated`.
* With Claude Code (the `claude-code` backend and the host-side agents), every `/v1/messages` call passes
  through the gateway (`runner/gateway.ts`). The gateway parses the usage from the SSE or JSON response
  and records it through the same `TokenTracker`, so nothing Claude Code does internally, such as
  subagents, background calls or compaction, escapes accounting.
* Roles are tracked separately: **coding** (the optimisation metric), **evaluator** (browser agent),
  **research**. They are never summed into the metric. Raw records live in `usage.jsonl` files and the `usage_records` table.

---

## Research loop and budgets

```
recover interrupted state + clean up containers → session → baseline verification (if no verified best)
loop while budgets allow:
  propose (research agent; history digest; whitelist) → new read-only configs/experiments/NNN
  → quick run (1) → verification (N) → promote? → holdout run on promotion (only a pass/fail bit is stored)
```

* The research agent may change only `system-prompt.md`, `skills/*.md` and approved `config.json` fields:
  * effort, designDelivery, inlineSpecFiles, maxOutputTokensPerCall, thinkingBudget, promptCaching and context;
  * `model` only if `allowModelChange`.

  What else it may change depends on the parent config's **backend**, which it can never change:
  * **api** configs: also `tools.json` and temperature.
  * **claude-code** configs: also `CLAUDE.md` and the `claudeCode` block (systemPromptMode, tools,
    disallowedTools, settings, allowlisted env, claudeMd). This block is validated by the same code as
    `runner/config.ts`, and it replaces the parent's block as a whole. `context.strategy` must stay `none`.

  It can't touch backend, limits, provider, the evaluator, the benchmark, thresholds or token accounting.
  Every candidate must also load with the runner's strict config validation before it is accepted.
* For the first `singleVariableExperiments` (8) experiments, a proposal may change one variable only.
* The **history digest** (`researcher/history.ts`) reads only DB rows, never files. For holdout runs it
  exposes a single passed/failed bit; holdout checks, messages and reports are never read. Messages
  from browser checks are dropped as well.
* Every experiment gets a new directory `configs/experiments/NNN`, which is hashed and made read-only.
  The current best is copied to `results/best-config/` (`summary.json` included; earlier copies go to `results/best-config-history/`).

`configs/research.json` defaults:

| Setting | Default |
|---|---|
| researchProvider / researchModel / effort | claude-code / `claude-sonnet-5-5` / high |
| maxExperiments | 20 |
| maxTotalTokens (all roles) / maxCodingTokens | null / null (no cap) |
| maxResearchCostUsd (API-equivalent) | null (off) |
| maxTokensPerCodingRun | 3,000,000 |
| maxRuntimePerExperimentSec | 14,400 (4 h) |
| maxTotalDurationSec | 86,400 (24 h active) |
| verificationRuns / quickRuns | 5 / 1 |
| noiseMarginPct | 0 |
| quickRunMaxTokenRatio | 1.5 (skip verification if the quick run used > 1.5× the best median) |
| holdout | 1 run on each promotion |
| maxConsecutiveProposalFailures | 3 |
| maxUsageLimitWaitSec / usageLimitMarginSec / usageLimitUnknownResetWaitSec | 21,600 (6 h) / 120 / 900 |

**Budgets on a subscription.** With the Claude Code providers (`claude-code`) nothing is billed per
token: the subscription has usage limits instead (handled by waiting, see `npm run research` above).
So the meaningful budgets are **tokens**: `maxTotalTokens` (coding + evaluator + research, the whole
session) and `maxCodingTokens` (coding runs only), plus `maxExperiments` and `maxTotalDurationSec`.
`maxResearchCostUsd` is kept as an **API-equivalent cost** cap (tokens priced with the local price
table: what the same usage would cost on the API) and is off (`null`) by default; set it, or pass
`--max-cost`, only if you want that proxy as a stop condition (e.g. when using the `anthropic` providers).
Budget stop reasons: `max_experiments`, `max_total_tokens`, `max_coding_tokens`, `max_cost`,
`max_duration`, plus `usage_limit`, `interrupted`, `research_agent_failing`, `baseline_failed_to_run`.

### Estimated API-equivalent cost (an estimate, not a measurement)

These come from the price table in `runner/token-tracker.ts` (claude-sonnet-5-5: $2/M input,
$10/M output, $0.10/M cache read, $2.50/M cache write) and the configured limits. They are what the
usage would cost on the API; on a Claude subscription it is not billed per token (the token counts
are what matter there, and how fast you reach the subscription's usage limits). No real run has
happened yet, so the "typical" token profiles are **assumptions**.

| Item | Assumed profile | ≈ API-equivalent cost |
|---|---|---|
| Coding run, typical | ~1.2M total tokens with caching (1.0M cache read, 120k cache write, 30k input, 50k output) | **≈ $1** |
| Coding run, worst case | 3M token cap, no cache hits (2.85M input + 150k output) | ≈ $7 |
| Browser-agent evaluation, typical | 9 scenarios × ~25k tokens (screenshot-heavy input) | ≈ $0.6 |
| Browser-agent evaluation, cap | 9 scenarios × 2 attempts × 150k tokens | ≈ $6 |
| Research proposal | 10–30k input, ≤ 16k output | ≈ $0.1–0.25 |
| **One benchmark run** (coding + evaluation) | typical / worst | **≈ $1.6 / ≈ $13** |
| **Experiment reaching verification** (1 quick + 5 verify + proposal) | typical / worst | **≈ $10 / ≈ $80** |
| Experiment rejected at the quick run | typical | ≈ $2 |
| Baseline bootstrap (5 runs + 1 holdout) | typical | ≈ $10 |

---

## Security and isolation

* **Coding container:** `--network none`, user `node` (uid 1000), `--read-only` root fs with a writable
  `/workspace` and tmpfs `/tmp`, `--cap-drop ALL`, `no-new-privileges`, `--cpus 2 --memory 2g
  --pids-limit 512`, no host mounts and no Docker socket. `/spec` is a root-owned read-only copy of
  `benchmark/spec`. The container never sees `evaluator/`, `researcher/`, `results/` or `configs/`.
* **Eval container:** the same hardening, attached only to a per-run `--internal` Docker network
  (no egress). A small evaluator-owned HTTP forwarder container (`evaluator/fault-proxy.ts`, read-only,
  no capabilities) publishes the app on `127.0.0.1` only, on two ports: a clean one and a faultable one
  for the browser agent. Its fault mode can be changed only from the host, through `docker exec`.
* **Browser and research agents have no file or shell tools.** Both run host `claude -p` with `--tools ""`
  in an empty temp cwd, with an isolated `HOME` and `CLAUDE_CONFIG_DIR`.
  * The research agent has no MCP servers. Its only tool is `StructuredOutput`.
  * The browser agent has only the Playwright MCP, attached to a harness-owned Chromium: origins limited
    to the app, `file://` blocked, an allowlist of browser tools, and no JS evaluation or file upload.
  * Verified live: neither agent could read a local file. The tests in `tests/researcher/research-agent-cc.test.ts`
    and `tests/evaluator/browser-agent-cc.test.ts` run with `FRUGAL_LIVE_CLAUDE=1`.
* **claude-code coding container:** the same hardening, plus a tmpfs `/home/node`. It is attached only to a
  per-run `--internal` network, whose single other member is a trusted forwarder (a node one-liner, read-only,
  no capabilities) that relays TCP to the host gateway and nowhere else. Verified: from inside,
  `https://example.com` and `1.1.1.1:443` fail, and the gateway is reachable.
* **Credentials:** the real subscription token (`CLAUDE_CODE_OAUTH_TOKEN`) is read only by the host gateway,
  and it is written only into the outgoing upstream `Authorization` header.
  * Every claude process, on the host or in a container, gets a worthless placeholder token. The gateway
    replaces the bearer only when it equals that placeholder, and drops other credential-like headers.
  * The gateway forwards only to `https://api.anthropic.com`. Absolute-form and `//host` request targets
    are refused.
  * It listens on `127.0.0.1` only and logs paths and status codes, never headers or bodies.
* API keys stay in the host process.
* Every container carries the labels `frugal.role=coding|eval` and `frugal.runId`, so abandoned
  containers and networks can be found and cleaned up at startup and shutdown.

**Known limitations**

* **Disk quota:** Docker Desktop's overlayfs doesn't support `--storage-opt size=`. The runner falls back
  to a `du` check of `/workspace` every 10 tool calls (limit 2 GB), so an agent could briefly exceed the limit between checks.
* **Egress blocking** relies on Docker's `--network none` / `--internal` networks rather than host
  firewall rules. That was verified on Docker Desktop (outbound fetch fails with `EAI_AGAIN`). The
  forwarder container is on the default bridge, but it runs fixed evaluator code, never app code.
* **claude-code backend needs Docker Desktop** (macOS or Windows). The coding container reaches the gateway
  through `host.docker.internal`, which Docker Desktop forwards to the host loopback, so the gateway can stay
  on `127.0.0.1`. Plain Linux Docker would need the gateway on the bridge IP, which isn't implemented.
* Claude Code's Bash tool may leave background processes, such as a smoke-test server, running when it
  exits. They die with the container, after the snapshot.
* Containers share the Docker VM's kernel. This is isolation for benchmarking hygiene, not a hardened sandbox for hostile code.
* An in-flight evaluation can't be aborted (Ctrl-C waits for it). With the browser agent that can take several minutes.
* Host sleep (see above) degrades results. The CLIs prevent idle sleep on macOS, but not sleep from closing the lid.

---

## Results layout

```
results/
  benchmark.db                 SQLite (schema v2; append-only via triggers)
  experiments.jsonl            one line per experiment state change
  logs/<date>.jsonl            structured logs
  runs/<runId>/
    run.json  trace.jsonl  usage.jsonl  config/  app/
    claude-stream.jsonl        (claude-code backend) raw Claude Code stream-json
    eval/<suite>/report.json  screenshots/  browser-trace.jsonl  usage.jsonl  app.log
  research/usage.jsonl         research-agent usage records
  best-config/                 current best config + summary.json
  reports/<timestamp>.{md,json}
  _infra-test/                 mock infrastructure-test results from the build (see Status)
```

`trace.jsonl` lines look like `{ts, type, turn, …}` with type `start`, `model_call`, `tool_call`
(`tool`, `input`, `output`, `isError`, `durationMs`), `compaction` or `end`.

---

## Tests

```bash
npm run typecheck      # tsc --noEmit
npm test               # vitest: unit + Docker integration (~5 min; Docker tests skip if no daemon)
```

The tests cover the runner (agent loop, tools, Anthropic mapping, token tracker, Docker sandbox),
the evaluator (scoring, visual maths, fixtures, browser-agent tool layer, the claude-code browser
harness with a fake headless runner, the fault proxy modes, and a full Docker integration test
where the reference app must pass and a broken copy must fail), storage
(append-only rules, accounting per role), the researcher (loop, promotion rules, whitelist,
history/holdout isolation, `[NO-BROWSER-AGENT]` guards, mock research agent, the claude-code research
provider with a fake runner, usage-limit waits, token budgets), the CLI parser and the dashboard server.
`FRUGAL_LIVE_CLAUDE=1` additionally runs two cheap live checks on your subscription: the research and
browser agents' real argv cannot read files.

---

## Status: what is and isn't verified

**Verified (2026-11-14, this machine, Docker Desktop on macOS):**

* `npm run typecheck` is clean and `npm test` passes, including the Docker integration tests.
* **End-to-end infrastructure test, mock provider:**
  `npm run benchmark -- --provider mock --mock-script reference-app` sends the hidden reference app
  through the real pipeline (fresh coding container → 12 `write_file` tool calls in 3 mock turns →
  snapshot → fresh eval container → checks → SQLite → artifacts). Result: **57/57 mandatory checks
  passed** (startup 1, backend 32, UI 23, visual capture 1), **visual score 100.0**, browser agent
  skipped. The coding tokens were **77,804 [MOCK]**: synthetic chars/4 estimates, not real usage. The
  run was marked `[MOCK] [NO-BROWSER-AGENT]` and was not eligible for promotion.
* `--mock-script default` (one trivial file) was recorded as a clean **app failure**
  (`startup.app`: the starter's API returns 501), not an evaluator crash.
* **Research loop with a mock coding provider and a mock research agent:** it bootstrapped the baseline (2/2 pass, not
  promotable), proposed and applied candidates into new read-only `configs/experiments/NNN`,
  ran quick and verification runs, recorded everything in the DB, respected `max_experiments`, and
  promoted nothing. Pause/resume via `results/research.pause`, graceful SIGINT, and `--resume`
  with recovery of interrupted state and container cleanup were all exercised.
* `npm run results`, `npm run report` and the dashboard (API + rendered pages, including screenshots and
  the trace viewer) were checked against those results.
* These mock results are kept in `results/_infra-test/` (`benchmark-cli/` and `research/`, the
  latter including the mock `configs/experiments/001–004`), so `results/benchmark.db` and
  `configs/experiments/` start empty. The artifact paths stored inside those DBs point to the original `results/runs/…` locations.

**Verified (2026-11-15), the claude-code backend on the Claude subscription:**

* **Gateway, live:** host `claude -p` through the gateway. The gateway's per-call usage equalled Claude Code's
  own `result.usage` exactly, and the API-equivalent cost with 1-hour cache-write pricing equalled Claude
  Code's `total_cost_usd`.
* **Live sandbox smoke test** (`scripts/cc-smoke.ts`): Claude Code in a fresh container created
  `/workspace/hello.txt` through the gateway, with the real token swapped in on the host.
  * 2 calls, 33,233 tokens (input 4, output 105, cache read 16,503, cache write 16,621), `usageCrossCheck.match = true`.
  * trace.jsonl was written, and the token appeared in no result or log file.
* **Full baseline run:** `npm run benchmark -- --config baseline --runs 1 --skip-browser-agent`, with the
  system prompt before the curl fix noted below (config hash `bd7fdb6d211f`).
  * Coding: `completed` in 45.5 s, 5 model calls, 5 tool calls.
  * **161,546 coding tokens**: input 10, output 7,032, cache read 131,229, cache write 23,275.
  * API-equivalent cost: $0.18.
  * Evaluation: **PASS**, 59/59 checks, visual 100.0, `[NO-BROWSER-AGENT]`.
  * After that run, the baseline prompt was corrected to say that curl isn't installed in the image
    (the agent had noticed and used node instead). The new hash is `8855ad5f8741`.
* **Offline Docker tests** (fake upstream, the real CLI in the container):
  * Egress is blocked and the gateway is reachable; `claude --version` reports 2.1.325.
  * A full `runCodingAgent` run completes.
  * The gateway call limit gives `limit_exceeded`.
  * A usage-limit 429 gives `infra_error` / `usage_limit` with the reset time.

**Not verified:**

* **The api backend (`baseline-api`) has never called a real model** (there is no API key on this machine).
  The claude-code coding agent is verified live (see above). The browser agent and the research agent are being moved to Claude Code separately.
  Only one real baseline run exists so far: the variance across runs, and the browser-agent result, are unknown.
* The holdout suite has been exercised only through unit tests and the mock pipeline.
* The cost figures above are estimates.

Suggested first real steps: `npm run dry-run` → `npm run benchmark -- --runs 1` (check that the
cost and pass status are sensible) → `npm run research -- --max-experiments 3 --max-total-tokens 30000000`.
