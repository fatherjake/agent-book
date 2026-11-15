# tiny tasks: shared images

All `tiny-*` tasks start from the same checkpoint of [tiny](https://github.com/fatherjake/tiny), a small
perpetual-futures exchange (Python validator sim + FastAPI/WebSocket API in `core/` and `sim/`, React +
TypeScript UI in `ui/`). The repo was created after the coding model's training cutoff, and every task's
feature is invented for the benchmark: its reference implementation lives only in the hidden
`evaluator/tasks/<id>/reference.diff`. **Never push a reference implementation to the public repo:** this
repo is public, so `evaluator/tasks/*/reference.diff` is gitignored and exists only on the machine that
built it (keep a private backup). Without it everything still runs; only `cli.ts --reference`, `ref-tree`
and the anti-cheat similarity check against the reference need it.

| Image | Contents |
|---|---|
| `frugal-task-tiny:<sha256>` | Python 3.12 + Node 22 + uv; `/workspace` = checkpoint (single commit, author's agent files stripped), `.venv`, `ui/node_modules`, Playwright/Chromium. Evaluator base image. |
| `frugal-task-tiny-cc:<h>` | + Claude Code (`CLAUDE_CODE_VERSION` in runner/claude-code.ts). Coding image. |

Inputs: `build.json` (repo, commit, stripped paths, versions), `docker/`. Tags are content hashes, so any input
change gives a new tag. Builds refuse below `FRUGAL_MIN_FREE_GB` (default 12) free disk.

```
npx tsx benchmark/tasks/tiny/image.ts tags
npx tsx benchmark/tasks/tiny/image.ts task | cc [--force]
npx tsx benchmark/tasks/tiny/image.ts checkpoint-tree <dir>         # the checkpoint on the host
npx tsx benchmark/tasks/tiny/image.ts ref-tree <taskId> <dir>       # HIDDEN: + reference.diff, staged
```

In the container: `/opt/frugal/task/app start|stop|status|logs [--port 3000] [--bots 20] [--no-build]` (sim +
built UI via `vite preview`, API proxied), `/opt/frugal/task/pw-node <script.js>` (Playwright), and
`/opt/frugal/task/services` (a no-op check: tiny needs no background services).

To add a task: copy `benchmark/tasks/tiny-depth/` (task.json, prompt.md, spec/, docker/image.ts) and
`evaluator/tasks/tiny-depth/`, build the reference implementation in a `checkpoint-tree`, save its
`git diff --cached --binary` as `reference.diff`, and validate as in `tiny-depth/VALIDATION.md`.
