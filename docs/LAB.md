# The lab: improving a repo's skill files with evidence

The lab measures how well a repository's own skill files (its instruction files, playbooks and
principles) help a coding agent do real work in that repository, proposes edits to them, tests each
edit, and lets a human accept or reject it.

```
setup (once per repo)          session                                      you
──────────────────────         ───────────────────────────────────────────  ───────────
clone, image, skills,          runs: current skills × task suite (N each)
the repo's own commands,   →   analysis: runs → ranked suggestions      →   accept or
instruction sources, skills,   testing: top 3, paired runs per suggestion   reject each
activation probes              (same task, same seed as the session run)    suggestion
```

## Concepts

* **Skills version**: the repo's skill files at the pinned commit plus every accepted suggestion, in
  order. A run receives it as a *workspace overlay*: a patch folded into the checkpoint commit before the
  run starts (`runCodingAgent({ workspaceOverlay })`). It is part of the starting state, never part of
  the graded diff, and git history does not reveal it.
* **Activation recipe**: how the task prompt is wrapped so the skills fire (tiny: "Use saiyan mode.").
  Setup measures each candidate recipe with short probe runs; sessions use the most reliable one.
  Every run records whether the agent actually used the skills (from its tool calls).
* **Task**: a benchmark task (`benchmark/tasks/<id>`: image, prompt, spec, hidden evaluator) plus
  **acceptance criteria**. A criterion is met when all of its evaluator checks pass (or its patch
  check holds). Completion is partial: meeting 7 of 8 criteria is 88%, not a failure.
* **Suggestion**: a small, generic edit to the skill files with a plain-English description and the
  evidence behind it. The analyst returns edits as exact find/replace text; the lab generates the git
  diff itself, so every diff applies.
* **Paired runs**: a suggestion's run reuses the pair key (task, repeat) and so the seed of the
  session run it is compared with. The UI shows each change with a 95% range over the pairs and marks it
  "within noise" (~) when the range includes zero.

## Commands

```
npm run lab -- setup   [--repo tiny] [--probes 3]                 profile for the repo page (probes cost tokens)
npm run lab -- session [--runs-per-task 3] [--concurrency 3] [--test-top 3]
npm run lab -- resume  --session sess-0001                        continue from the next unfinished phase
npm run lab -- status
npm --prefix web run build && npm run lab -- serve                UI + API on http://127.0.0.1:5181/
```

`npm --prefix web run dev` serves the UI with hot reload on :5180 and proxies `/api` to the lab server.

## Where things live

| Path | What |
|---|---|
| `lab/repos.ts` | Repo registry: skill paths and links, activation recipes, the repo's commands, task suite with acceptance criteria |
| `lab/skills.ts` | Clone cache, skills versions, overlay patches, validation that diffs only touch skill files |
| `lab/run.ts` | One run: overlay + recipe → Claude Code → hidden evaluator → grading; did the skills fire |
| `lab/analyse.ts` | The analyst: read-only headless Claude Code over the session's evidence → ranked suggestions |
| `lab/session.ts` | Session phases: runs → analysis → testing the top suggestions (resumable) |
| `lab/setup.ts` | Setup and repo evaluation → repo profile versions |
| `lab/db.ts` | `results/lab.db` (SQLite): repos, profiles, tasks, sessions, suggestions, runs |
| `lab/server.ts` | JSON API + the built web UI |
| `configs/lab/` | The agent config for lab runs: Claude Code with no instructions beyond a sandbox note |
| `web/` | The UI |

## Guarding against overfitting

The analyst is told to keep suggestions generic, and edits may only touch skill files. That alone
cannot tell a general codebase map from a hint for the one task in the suite, so held-out tasks (never
shown to the analyst, used only to confirm accepted suggestions) and a suite with fixes and refactors
are the next step.
