# Multi-task benchmark: design contract (binding for the build team)

Status: design for the Mastodon upgrade. The todo benchmark becomes task `todo`; two Mastodon
"brownfield" tasks are added. Everything here is a contract between three work streams
(env, core, checks). Change it only by agreement (message the lead).

## 1. Goals

* Measure coding-agent tokens on **implementing a feature in an existing, large codebase**
  (Mastodon, Rails + React/Redux), where navigation, context hygiene and test loops dominate.
* **Dev task:** `mastodon-bookmarks`: re-implement Bookmarks (upstream PR #7107, squash commit
  `dfea7368c934f600bd0b6b93b4a6c008a4e265b0`, merged 2019-11-13). Checkpoint = its first parent.
* **Holdout task:** `mastodon-filters`: re-implement keyword/phrase filtering (upstream PR #7905,
  merged 2018-06-29). Checkpoint = first parent of its merge commit. The research agent never sees
  anything about this task: not its name, prompt, results, checks or transcripts. It sees one
  pass/fail bit per promoted experiment, as with today's holdout.
* `todo` keeps working **unchanged**: same image, spec, evaluator, scores and tests.
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
  id: string;                         // 'todo' | 'mastodon-bookmarks' | 'mastodon-filters'
  title: string;
  kind: 'greenfield' | 'brownfield';
  promptFile: string;                 // relative to the task dir; todo: keep current prompt logic
  specDir: string;                    // copied to /spec
  image: { builder: string };         // module exporting ensureTaskImage(): Promise<ImageInfo>
  workspace: { path: '/workspace'; snapshot: 'tree' | 'git-diff' };  // todo: tree; mastodon: git-diff
  sandbox: { cpus: number; memory: string; pidsLimit: number;
             extraVolumes?: string[];   // anonymous writable volumes, e.g. ['/data'] for Postgres/Redis
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

`configs/research.json` gains `devTask` (default `'todo'`) and `holdoutTask` (default `'todo'`,
which means today's behaviour: same task, holdout suite). Mastodon research uses
`devTask: 'mastodon-bookmarks', holdoutTask: 'mastodon-filters'`. CLIs get `--task <id>`
(benchmark) and `--dev-task/--holdout-task` (research).

## 3. Image contract (env stream). Brownfield tasks

Base image `frugal-task-<taskId>:<hash>`; Claude Code layer `frugal-task-<taskId>-cc:<hash>`.

* `/workspace` is the Mastodon repo at the checkpoint, owned by uid 1000. Git history is
  **truncated to a single commit** ("checkpoint"), so nothing about the future is reachable
  (no other refs, packs or reflogs). Gems and node_modules are preinstalled, and the repo is clean
  (`git status` empty) after setup.
* Postgres and Redis are inside the same container, running as uid 1000. Their data lives in
  `/data` (an anonymous volume; the template is copied at start if empty). The dev and test
  databases are created and the schema loaded at build time.
  `/opt/frugal/task/services start|stop|status` is idempotent; the sandbox runs it at creation.
* Environment (baked in): `RAILS_ENV=development`, the DB/Redis connection vars, `LOCAL_DOMAIN`,
  secrets, and anything the app needs offline. `bundle exec rspec <file>` and `bin/rails` work
  with no network.
* **Claude Code needs Node >= 18 but this Mastodon needs Node 10/12.** Install Claude Code with its
  own runtime (e.g. under `/opt/claude` with a private node), so `claude` works while `node`/`yarn`
  on PATH stay the project's versions.
* **Headless browser for the coding agent's own verification.** The image includes Chromium plus
  Playwright, running on the private modern Node runtime (not the project's Node 10/12).
  `/opt/frugal/task/pw-node <script.js>` runs a Node script with `require('playwright')`
  resolvable and Chromium preconfigured (headless, no sandbox flags needed under cap-drop, no
  network beyond localhost). It's documented in the task prompt as an available tool, so configs
  and skills can build UI checks on it. The evaluator does NOT use this browser: hidden UI checks
  run with the host's Playwright.
* Must work under the existing hardening: `--read-only` root, cap-drop ALL, non-root uid 1000,
  no network, writable only `/workspace`, `/data`, tmpfs `/tmp` and the declared tmpfs.
* arm64 host (Apple Silicon). Prefer native arm64; if a 2018/2019 native dependency can't be built,
  document the workaround (patch the lockfile version, or as a last resort `--platform linux/amd64`).
* `/opt/frugal/task/app start` (evaluator only): runs migrations, precompiles assets (or another
  documented way to serve the web UI), and serves the app on a port with the web UI working.
* **Disk:** the host is short on disk. Before any `docker build`, check free space and don't
  build below 12 GB free (`FRUGAL_MIN_FREE_GB`; a full rebuild needs ~8 GB). Reuse layers: both tasks share a base where possible.
* Snapshot for `git-diff` tasks: after the run the runner stores `results/runs/<id>/workspace.patch`
  (`git add -A && git diff --cached --binary` against the checkpoint, excluding log/ tmp/ node_modules
  vendor/ public/packs*). The evaluator applies it to a fresh container from the base image.

## 4. Evaluator contract (checks stream)

`evaluator/tasks/<taskId>/index.ts` exports
`evaluateTask(opts: { runId; patchFile; suite; seed; outDir; image }) => Promise<EvaluationResult>`
(the same `EvaluationResult` / `CheckResult` types; categories reuse `startup | backend | ui | browser`).
The dispatcher in `evaluator/index.ts` routes by task; `todo` keeps the current code path.

Mastodon checks (deterministic; `browserAgent: 'none'`):

1. **startup**: the patch applies cleanly, migrations run, and the app boots and serves the web UI.
2. **backend**: HTTP API checks against the running app with seeded users, OAuth apps, tokens and
   statuses (public, unlisted, private and direct, from several authors). These are written from
   the **public** feature spec in `spec/` plus the upstream API documentation. Never test something
   the public spec doesn't state.
3. **upstream**: the upstream PR's own spec files (hidden copies in `evaluator/tasks/<id>/upstream/`)
   are copied into the patched tree and run with rspec. Each example is a check.
4. **regression**: a curated, fast subset of existing specs near the touched code must still pass.
5. **ui**: Playwright against the web UI. Log in as a seeded user, do the feature end to end, and
   check persistence across a reload. Use the accessible names the public spec defines.

Validation (required before done): the **upstream reference** (checkpoint + upstream squash diff)
passes 100% of mandatory checks; the **bare checkpoint** fails the feature checks and passes
startup and regression. Record both in `evaluator/tasks/<id>/VALIDATION.md`.

Public spec (`benchmark/tasks/<id>/spec/feature.md` + `prompt.md`) is written like a good GitHub
issue plus the API doc: endpoints, params, responses, scopes, visibility rules, the UI entry
points, and the accessible names the UI must use. It must not paste upstream code.

## 5. Core changes (core stream)

* `runner/tasks.ts`: load and validate the registry, `getTask(id)`, `ensureTaskImage(task)`.
* `runCodingAgent({ task, ... })`: the task drives image, prompt, spec dir, sandbox resources,
  extra mounts, limit ceilings, the services start hook, snapshot mode, and `taskId` in run.json and
  usage records.
* `runBenchmark({ taskId, ... })` → coding run → `evaluateRun({ taskId, ... })` dispatch.
* Storage migration v5: `runs.task_id` and `experiments.task_id` (default `'todo'`), plus summaries
  and filters by task. The dashboard shows the task in the experiments table.
* Research loop: verification and quick runs use `devTask`; holdout = `holdoutTask` (if it equals
  `devTask`, the old behaviour is the `holdout` suite). The best and promotion are **per dev task**
  (the best for todo and the best for mastodon-bookmarks are independent), as is the baseline
  bootstrap.
* Promotion: `passRate >= task.minPassRate` (todo 1.0, so unchanged) **and** the median coding
  tokens of all verification runs < the best median. The quick run must pass.
  `browserAgent: 'none'` tasks are promotable without the LLM browser agent; `'required'` tasks keep
  the current NO-BROWSER-AGENT rule.
* Research workspace: for a brownfield dev task, mount a **read-only copy of the checkpoint
  source** at `/research/codebase` (no node_modules, vendor or .git), so the researcher can build
  feature maps and codebase guides. Nothing from the holdout task may enter the workspace or the
  digest.
* Config surface: add `docs/` (any files, up to 32 KB each and 256 KB in total). They're installed
  read-only at `/opt/frugal/docs` in the coding container and **not** loaded into context unless
  the agent reads them. Always-loaded files keep their current limits.
* **Guard safeguards:**
  1. **Banned terms:** the union of `bannedTerms` of every non-todo task (dev and holdout). Any
     config file containing one is rejected (case-insensitive, word-ish match).
     Bookmarks: `bookmark`. Filters: `custom_filter`, `CustomFilter`, `keyword filter`,
     `phrase filter`, `filters_controller`.
  2. **Reference corpus:** every task's `referenceDiffs` (the added lines of the upstream diffs) join
     the similarity corpus.
  3. **Human flagging** (`npm run results -- --flag-cheating`) already exists. Keep it working per task.
* Everything else (gateway, isolation, accounting, the dashboard, the CLIs) keeps working. `todo`
  tests stay green and the todo numbers are unchanged.

## 6. Ownership

| Stream | Owns | Must not touch |
|---|---|---|
| env | `benchmark/tasks/mastodon-*/docker/**`, `benchmark/tasks/mastodon-*/task.json` (sandbox/image fields), image builder modules, `/opt/frugal/task/*` scripts, reference.diff extraction | runner/researcher/storage internals |
| core | `runner/**`, `researcher/**`, `storage/**`, `scripts/**`, `dashboard/**`, `evaluator/index.ts` dispatch, `benchmark/tasks/todo/` | Mastodon image internals, hidden checks |
| checks | `evaluator/tasks/mastodon-*/**`, `benchmark/tasks/mastodon-*/{prompt.md,spec/}`, `task.json` (bannedTerms/minPassRate fields) | runner internals |

Nobody commits; the lead commits. Tests use temp DBs, never `results/benchmark.db`.

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
  that PATH (e.g. a wrapper in `/usr/local/bin` that runs Claude Code with its private node).
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
  <sha> -- . <excludes>`, excludes `log tmp node_modules vendor public/packs*`). An empty patch file means "no
  change" and is still evaluated.
* **evaluateTask options:** `{ runId, patchFile /* absolute */, suite, seed, outDir /* absolute, created */, image
  /* baseImage */, taskId, experimentId? }`. Holdout-task runs (holdoutTask ≠ devTask) are evaluated with suite
  `'holdout'` and stored with phase `holdout`. A thrown error becomes an evaluator-failure result. For
  `browserAgent: 'none'` the dispatcher forces `browserAgentSkipped: false`. Check categories stay in the
  existing union (`startup | backend | functional | browser | visual`): UI checks use `functional`, upstream and
  regression specs use `backend` (ids distinguish them).
* **Research settings:** `holdoutTask` defaults to `devTask` when not set anywhere (so `--dev-task X` alone means
  X's holdout suite). Bests are published to `results/best-config` (todo) and `results/best-config-<task>`.
* **Banned terms** are read from the raw task.json of every non-todo task (validated or not), so a task under
  construction already protects its feature. Matching: case-insensitive; word parts (split at spaces, `_`, `-`,
  camelCase) may be joined by spaces, `_` or `-`; substrings match. File names are checked too.
