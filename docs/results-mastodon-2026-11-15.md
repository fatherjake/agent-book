# Mastodon research results, 2026-11-15

These are the first research sessions on the brownfield Mastodon task. The dev task was
`mastodon-bookmarks` (upstream PR #7107), with holdout runs on `mastodon-filters` (PR #7905). The
coding agent was Claude Code with Sonnet 5.5, on a subscription. Runs went one at a time because the
Docker VM has 8 GB. Raw data is in `results/` (local only); the configs are in `configs/experiments/`.

## Outcome

| Experiment | Config | Change | Verified median tokens | Pass (verify) | Holdout | vs baseline |
|---|---|---|---|---|---|---|
| exp-0001 | `baseline` | none (todo-tuned baseline) | 1,666,389 | 5/5 | pass | n/a |
| exp-0002 | `experiments/006` | task-neutral system prompt, no todo checklist skill | 1,097,438 | 4/5* | not run* | −34% |
| exp-0005 | `experiments/007` | + `tools: ["Bash"]` only | 880,748 | 5/5 | pass (647k) | −47% |
| exp-0006 | `experiments/008` | + `uiseed` helper skill for UI self-checks | quick run 1.08M, not verified | n/a | n/a | rejected |
| exp-0007 | `experiments/009` | + no live-UI self-check (static grep, plus eslint and rspec) | **441,495** | 5/5 | pass (430k) | **−74%** |

\* exp-0002's last verification run and its holdout were broken by an infrastructure error: the
image inputs were edited mid-session, which forced a rebuild that the disk guard then refused. The
loop also gave exp-0003 and exp-0004 the same error and recorded them as failures.

## What moved the number

1. **The context described the wrong task (−34%).** The baseline config was tuned on the todo task.
   Its appended system prompt described a Node/Express app, and it loaded a todo checklist skill, so
   every call carried misleading context.
2. **Unused tool definitions (−20% on top).** The agent only ever used Bash. Leaving out the other 22
   tool definitions and the skill list cut about 12k tokens of fixed prefix that was re-read on
   every call.
3. **The agent checking its own UI (−50% on top).** After about 1.5 minutes of real implementation,
   runs spent 8–15 more calls (each carrying 45–56k of context) seeding a user, getting past the
   onboarding modal and debugging hand-written Playwright scripts. That tail never found a real bug,
   and the hidden evaluator's UI checks still pass without it. Making the harness easier (exp-0006,
   a `uiseed` helper) didn't help; removing the step did.

## Time

Coding time per run fell from about 7.7 minutes (baseline) to about 2.4 minutes (exp-0007), because
the slow part was the agent's own Playwright work, not the build. A cold `app start` takes about 18 s,
13 s of it webpack. Precompiling packs into the image cut that to about 6 s; this was tried and
reverted, because it wasn't worth changing the environment mid-research. One verification stage
(5 runs) now takes about 14 minutes, down from about 40. Running in parallel (`--concurrency`) is the
next lever. It needs about 4 GB of Docker memory per parallel run at peak.

## Fixes found during calibration

- git-diff snapshots failed on repos whose `.gitignore` covers the excluded paths (`03691f2`).
- Bullseye packages moved to archive.debian.org. The evaluator's seed user needed `agreement`, and
  the image needed ffmpeg (a regression spec was flaky without it). Two filters UI checks were
  stricter than upstream's own UI.
- The disk guard default went from 30 GB to 12 GB; a full rebuild needs about 8 GB.
