# Multi-task benchmark: design contract

Status: the brownfield benchmark runs on **tiny** (github.com/fatherjake/tiny), a small perpetual-futures
exchange (Python validator sim + FastAPI/WebSocket API, React + TypeScript UI) created on 2026-10-30, after
the coding model's training cutoff, so neither the codebase nor the features can come from the model's
training data. The todo benchmark is task `todo` and keeps working unchanged.

## 1. Goals

* Measure coding-agent tokens on **implementing a feature in an existing codebase the model has never
  seen**, so navigation, context hygiene and test loops are real work and nothing can be recalled.
* Features are invented for the benchmark and **never published**: the public tiny repo only ever has the
  checkpoint; each reference implementation lives only in the hidden `evaluator/tasks/<id>/reference.diff`.
  Don't push them anywhere public (a future model would train on them).
* **Dev task:** `tiny-depth`: a depth chart tab in the order book card (frontend only: the book data already
  reaches the UI). Holdout: the task's own holdout suite (different pinned books and viewport). A second tiny
  feature task can become the holdout task later (`holdoutTask`); the research agent then sees nothing about
  it but one pass/fail bit per promoted experiment.
* Token accounting is unchanged. Only the coding run's own model calls count. Config artifacts
  (skills, CLAUDE.md, docs, bin tools, hooks) are produced by the research agent (role
  `research`) and are free for the run, except that whatever the run loads into context is paid
  on every call, as today.

## 2. Task registry

```
benchmark/tasks/<taskId>/task.json      public task definition (see schema)
benchmark/tasks/<taskId>/prompt.md      task prompt given to the coding agent (public)
benchmark/tasks/<taskId>/spec/          files copied to /spec in the coding container (public)
benchmark/tasks/<taskId>/docker/        image build context (env stream)
evaluator/tasks/<taskId>/               HIDDEN: checks, seed scripts, upstream tests, reference.diff
```

`todo` gets a `benchmark/tasks/todo/task.json` that points at the existing `benchmark/spec`,
`benchmark/starter`, `benchmark/docker` and the existing evaluator. Don't move todo files.

`task.json` schema (TypeScript `TaskDefinition` in `runner/tasks.ts`):

```ts
interface TaskDefinition {
  id: string;                         // 'todo' | 'tiny-depth' | ...
  title: string;
  kind: 'greenfield' | 'brownfield';
  promptFile: string;                 // relative to the task dir; todo: keep current prompt logic
  specDir: string;                    // copied to /spec
  image: { builder: string };         // module exporting ensureTaskImage(): Promise<ImageInfo>
  workspace: { path: '/workspace'; snapshot: 'tree' | 'git-diff' };  // todo: tree; tiny: git-diff
  sandbox: { cpus: number; memory: string; pidsLimit: number;
             extraVolumes?: string[];   // anonymous writable volumes (tiny needs none)
             extraTmpfs?: string[];     // e.g. ['/run/postgresql:rw,nosuid,size=1m,uid=1000']
             shmSize?: string };        // /dev/shm size (--shm-size), e.g. '512m' for Chromium
  limits?: Partial<RunLimits>;        // task budget: each field replaces the config's limit; run overrides only tighten (§7)
  evaluator: string;                  // module path exporting evaluateTask(opts) -> EvaluationResult
  browserAgent: 'required' | 'none';  // 'none' => deterministic checks only, still promotable
  minPassRate: number;                // promotion threshold over verification runs (todo: 1.0)
  bannedTerms: string[];              // case-insensitive; any config text containing one is rejected
  referenceDiffs: string[];           // HIDDEN paths (evaluator/tasks/...) added to the guard's similarity corpus
}
```

`configs/research.json` has `devTask` (built-in default `'todo'`; the file sets `'tiny-depth'`) and
`holdoutTask` (default: the dev task, i.e. its holdout suite). CLIs take `--task <id>` (benchmark) and
`--dev-task/--holdout-task` (research).

## 3. Image contract (tiny tasks)

`benchmark/tasks/tiny/image.ts` builds two images shared by every tiny-* task (inputs in
`benchmark/tasks/tiny/build.json`; tags are content hashes of the inputs):

* `frugal-task-tiny:<sha256>` (task / evaluator base image): `python:3.12-slim-bookworm` + Node 22 + uv +
  build-essential. `/workspace` is tiny at the pinned commit with the author's agent files stripped
  (`CLAUDE.md`, `AGENTS.md`, `.agents`, `.cursor`, `.codex`), git history **truncated to a single commit**
  ("checkpoint"), owned by uid 1000, `.venv` (`uv sync --frozen`) and `ui/node_modules` (`npm ci`)
  preinstalled, `git status` clean. Playwright + Chromium at `/opt/frugal/pw` for the agent's own checks.
* `frugal-task-tiny-cc:<h>`: + Claude Code (`CLAUDE_CODE_VERSION`), linked into `/usr/local/bin`.
* Offline at run time: `UV_OFFLINE=1 UV_FROZEN=1` (so `uv run` uses the baked `.venv`), `npm_config_offline`.
* `/opt/frugal/task/services start` only checks the dependencies are present (no background services).
* `/opt/frugal/task/app start|stop|status|logs [--port 3000] [--bots 20] [--no-build]`: the sim (4 validators,
  N bots, seeded price feed, API on 127.0.0.1:8000, no block log), `npm run build`, then `vite preview` on
  0.0.0.0:PORT, which serves `ui/dist` and proxies the API routes and `/ws` to :8000.
* `/opt/frugal/task/pw-node <script.js>`: Node with `require('playwright')` and headless Chromium.
* Must work under the sandbox hardening: `--read-only` root, cap-drop ALL, non-root uid 1000, no network,
  writable only `/workspace` and tmpfs `/tmp`.
* **Disk:** builds refuse below `FRUGAL_MIN_FREE_GB` (default 12) free. The task image is ~3 GB.
* Host helpers: `image.ts checkpoint-tree <dir>` (the checkpoint, byte-identical, same commit id) and
  `image.ts ref-tree <taskId> <dir>` (HIDDEN: + the reference diff, staged).

## 4. Evaluator contract (tiny tasks)

`evaluator/tasks/<taskId>/index.ts` exports `evaluateTask(opts) => Promise<EvaluationResult>`; the shared
pipeline is `evaluator/tasks/tiny-common/evaluate.ts`:

1. **startup**: fresh container from the base image, the patch applies (`startup.patch`), `npm run build`
   passes (`startup.build`), `app start --no-build` serves the UI and the API through the forwarder
   (`startup.app`).
2. **regression** (`backend`): the whole vitest suite (`regression.ui`, including the run's own tests) and the
   whole pytest suite (`regression.python`, ~30 s) pass.
3. **ui** (`functional`): host Playwright, written only from the public spec. For tiny-depth the page talks to
   the real sim except that `GET /book/*` and the WebSocket `book` frames are replaced by a **pinned book**
   (fixtures + expectations in `evaluator/tasks/tiny-depth/fixtures.ts`), so every expected tooltip value
   is computed exactly. Requests to anything but the app are aborted.
4. **visual** (`visual`): screenshots of the card compared with the reference implementation's screenshots
   (`evaluator/tasks/<id>/visual/<suite>-<shot>.png`), score = 100 × (0.5 tolerant pixel similarity +
   0.5 multi-scale SSIM). The gate is the task's own calibrated threshold (tiny-depth: 50), a mandatory check;
   the global 95 visual gate of todo does not apply.

Validation (required before done): the **reference** passes 100% of mandatory checks in both suites; the
**bare checkpoint** passes startup and regression and fails the feature checks. Record both in
`evaluator/tasks/<id>/VALIDATION.md`. Manual runs: `npx tsx evaluator/tasks/tiny-common/cli.ts <taskId>
(--reference | --bare | --patch <file>) [--suite holdout]`; `FRUGAL_TINY_WRITE_REFERENCE=1` (reference only)
rewrites the visual references.

Public spec (`benchmark/tasks/<id>/spec/feature.md` + `prompt.md`, plus a design image) is written like a
good issue: where the feature goes, every rule a check depends on (axes, which level is shown, exact texts and
accessible names), never the reference code.

## 5. Core behaviour

* `runner/tasks.ts`: load and validate the registry, `getTask(id)`, `ensureTaskImage(task)`.
* `runCodingAgent({ task, ... })`: the task drives image, prompt, spec dir, sandbox resources, extra mounts,
  limit ceilings, the services start hook, snapshot mode, and `taskId` in run.json and usage records.
* `runBenchmark({ taskId, ... })` → coding run → `evaluateRun({ taskId, ... })` dispatch.
* Storage: `runs.task_id` and `experiments.task_id` (default `'todo'`), summaries and filters by task.
* Research loop: verification and quick runs use `devTask`; holdout = `holdoutTask` (if it equals `devTask`,
  the task's holdout suite). Best and promotion are **per dev task**, as is the baseline bootstrap.
* Promotion: `passRate >= task.minPassRate` (todo 1.0, tiny-depth 0.8) **and** the median coding tokens of all
  verification runs < the best median. The quick run must pass. `browserAgent: 'none'` tasks are promotable
  without the LLM browser agent.
* Research workspace: for a brownfield dev task, a **read-only copy of the checkpoint source** at
  `/research/codebase` (no .git, dependencies, caches or build output). Nothing from a holdout task enters the
  workspace or the digest.
* Config surface: `docs/` (any files, up to 32 KB each and 256 KB in total), installed read-only at
  `/opt/frugal/docs`, not loaded into context unless the agent reads them.
* **Guard safeguards:** banned terms (the union of `bannedTerms` of every non-todo task; tiny-depth:
  `DepthChart`, `No liquidity`, `levelAt`, `depthView`), the reference corpus (every task's `referenceDiffs`),
  and human flagging (`npm run results -- --flag-cheating`).

## 6. Where things live

| Area | Files |
|---|---|
| tiny images | `benchmark/tasks/tiny/**` (image.ts, build.json, docker/) |
| tiny-depth public task | `benchmark/tasks/tiny-depth/{task.json,prompt.md,spec/,docker/image.ts}` |
| shared tiny evaluator | `evaluator/tasks/tiny-common/{evaluate,container,cli}.ts` |
| tiny-depth hidden checks | `evaluator/tasks/tiny-depth/**` (fixtures, ui-checks, visual, visual/*.png, reference.diff, VALIDATION.md) |
| core | `runner/**`, `researcher/**`, `storage/**`, `scripts/**`, `dashboard/**`, `evaluator/index.ts` |

Tests use temp DBs, never `results/benchmark.db`.

## 7. Interface details fixed during the build (core stream)

These refine §2–§5 without changing their intent.

* **Paths in task.json:** `promptFile` and `specDir` are relative to the task dir; `image.builder`, `evaluator`
  and `referenceDiffs` are repo-relative (`evaluator` and `referenceDiffs` must be under `evaluator/`). todo uses
  the sentinel `builtin:todo` for `promptFile`, `image.builder` and `evaluator` (original code paths).
* **Image builder:** `ensureTaskImage(): Promise<{ image /* the -cc tag the coding container runs */, imageId,
  starterHash /* any content hash, stored as runs.starter_hash */, baseImage /* passed to evaluateTask as image */ }>`.
* **Container user:** the runner runs and execs as `node` (uid 1000) with `HOME=/home/node` (a tmpfs), and the
  `claude` process gets `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` (plus `/opt/frugal/bin`
  first when the config has bin scripts). So the image needs a user `node` with uid 1000 and `claude` resolvable on
  that PATH (tiny: Claude Code shares the project's Node 22 and is linked into `/usr/local/bin`).
* **Services hook:** non-todo tasks: right after `docker run` (and the /spec copy) the runner execs
  `/opt/frugal/task/services start` as `node` in `/workspace`, timeout 300 s; non-zero = `infra_error`.
* **/opt/frugal:** for non-todo tasks the runner mounts tmpfs at `/opt/frugal/bin`, `/opt/frugal/libexec` and
  `/opt/frugal/docs` (not at `/opt/frugal`), so the image's `/opt/frugal/task` stays visible. Task images must not
  use those three names.
* **Gateway forwarder:** always the todo benchmark image (`frugal-bench`), whatever the task.
* **Limits:** each `task.limits` field **replaces** the config's limit for runs of that task (configs' limits are
  tuned for todo and the research agent cannot change them); run-time overrides (`maxTokensPerCodingRun`,
  `--max-tokens-per-run`) can only tighten. The research `maxTokensPerCodingRun` (default 3M) still applies.
* **Checkpoint for git-diff:** the runner records `git rev-parse HEAD` right after the services hook and diffs
  against that commit (`git add -A -- . <excludes>` then `git diff --cached --binary --no-color --no-ext-diff
  <sha> -- . <excludes>`, excludes: dependencies, `ui/dist`, caches, `*.sqlite*`, `tmp`; see `GIT_DIFF_EXCLUDES` in runner/snapshot.ts). An empty patch file means "no
  change" and is still evaluated.
* **evaluateTask options:** `{ runId, patchFile /* absolute */, suite, seed, outDir /* absolute, created */, image
  /* baseImage */, taskId, experimentId? }`. Holdout-task runs (holdoutTask ≠ devTask) are evaluated with suite
  `'holdout'` and stored with phase `holdout`. A thrown error becomes an evaluator-failure result. For
  `browserAgent: 'none'` the dispatcher forces `browserAgentSkipped: false`. Check categories stay in the
  existing union (`startup | backend | functional | browser | visual`): UI checks use `functional`, test-suite
  runs use `backend`, the screenshot comparison uses `visual` (ids distinguish them).
* **Research settings:** `holdoutTask` defaults to `devTask` when not set anywhere (so `--dev-task X` alone means
  X's holdout suite). Bests are published to `results/best-config` (todo) and `results/best-config-<task>`.
* **Banned terms** are read from the raw task.json of every non-todo task (validated or not), so a task under
  construction already protects its feature. Matching: case-insensitive; word parts (split at spaces, `_`, `-`,
  camelCase) may be joined by spaces, `_` or `-`; substrings match. File names are checked too.
