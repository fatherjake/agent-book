# Evaluator (hidden from the coding agent)

```
evaluateRun(opts) ─► launchApp (fresh eval container) ─► backend tests ─► deterministic UI scenarios
                  ─► browser agent (LLM) ─► visual ─► scoreEvaluation (score.ts, the ONLY pass/fail)
```

Manual use:

```
tsx evaluator/cli.ts --app <dir> [--suite dev|holdout] [--seed N] [--skip-browser-agent] [--json]
```

The exit code is 0 for pass, 1 for an app failure and 2 for an evaluator failure. The report goes
to `results/runs/<runId>/eval/<suite>/` (`report.json`, `screenshots/`, `browser-trace.jsonl`,
`usage.jsonl` with the evaluator role, and `app.log`).

## Files

| File | Purpose |
|---|---|
| `index.ts` | `evaluateRun()`: orchestration, infra retries (2), report, containers stopped in `finally` |
| `score.ts` | `scoreEvaluation()`, `VISUAL_THRESHOLD = 95` |
| `app-launcher.ts` | `launchApp()`: fresh container, snapshot copy, build/start, `readDb/queryDb/writeDb/dbSchema/restart/resetDb/stop/logs` |
| `fixtures.ts` | fixture loading (dev = `benchmark/spec/fixtures.json`, holdout = `evaluator/holdout/fixtures.json`), seeded PRNG variants, API seeding |
| `backend-tests.ts` | API + DB tests |
| `scenarios/ui-scenarios.ts` | deterministic Playwright scenarios (accessible-name contract only) |
| `ui-helpers.ts` | role/name locators, aria-snapshot list reader, API+DB state verification |
| `browser-agent.ts` | LLM browser agent: goal scenarios plus deterministic post-assertions, orchestration of both backends, the api-backend tool layer/loop |
| `browser-agent-cc.ts` | claude-code backend: harness-owned CDP Chromium, Playwright MCP config, `claude -p` argv (no built-in tools), one goal phase |
| `fault-proxy.ts` | the HTTP forwarder in front of the app (clean + faultable listener, fault modes) |
| `visual-tests.ts` | screenshots, pixel/SSIM/layout/typography score (see `VISUAL_SCORING.md`) |
| `generate-visual-reference.ts` | writes the frozen `visual-reference.json` from the reference app |
| `calibrate-visual.ts` | visual calibration against degraded variants |

## Isolation of the app under test

* App container: same flags as the coding container (`--read-only`, `--cap-drop ALL`,
  `no-new-privileges`, user `node`, `--cpus 2 --memory 2g --pids-limit 512`, tmpfs `/tmp`). It also
  gets an anonymous volume on `/workspace`, so the image's `node_modules` stay and the snapshot is
  copied over them. The labels are `frugal.role=eval` and `frugal.runId`.
* **No egress:** the app container is attached only to a per-run `docker network create --internal`
  network. Internal networks can't publish ports, so a second, evaluator-owned container (the same
  image running the small HTTP forwarder in `fault-proxy.ts`, never app code) joins both that network and
  the default bridge and publishes two `127.0.0.1` ports only: `app.url` (never faulted) and
  `app.agentUrl` (the browser agent's page; fault modes `off | fail-mutations-500 | fail-all-api-500`,
  switched only by the host with `docker exec` writing a mode file on the forwarder's tmpfs). This was tested on Docker Desktop: outbound
  `fetch('https://example.com')` from the app container fails with `EAI_AGAIN`. No iptables are needed.
* The DB lives at `DATABASE_PATH=/workspace/.evaldata/todos.db`. It is read with the image's
  `sqlite3` CLI through `docker exec`. If the CLI is missing, the fallback is `docker cp` plus the
  host's better-sqlite3.
* Leftover networks/containers: `cleanupEvalResources()` in `app-launcher.ts`. Networks carry the
  label `frugal.role=eval`.

## Check IDs

All checks are mandatory unless marked *(optional)*.

* **startup**: `startup.app`
* **backend** (32): `api.list.initial_empty`, `api.frontend.served`, `api.create.valid`,
  `api.create.trims_title`, `api.create.max_length_200`, `api.create.ignores_unknown_fields`,
  `api.validation.invalid_titles`, `api.create.boundary_titles` (holdout: lists from the hidden fixture file),
  `api.validation.create_{empty_title,whitespace_title,too_long_title,missing_title,title_not_string,title_null,malformed_json}`,
  `api.patch.title`, `api.patch.completed`, `api.patch.both_fields_and_unknown`,
  `api.validation.patch_{empty_body,only_unknown_fields,empty_title,too_long_title,title_not_string,completed_not_boolean}`,
  `api.patch.not_found`, `api.delete`, `api.delete.not_found`, `api.id.non_integer`, `api.ordering`,
  `db.schema`, `db.matches_api`, `api.persistence.restart`
* **functional** (23): `ui.initial_render`, `ui.create.enter`, `ui.create.button`,
  `ui.edit.save`, `ui.edit.cancel`, `ui.complete`, `ui.reopen`, `ui.delete`, `ui.filters`,
  `ui.counter_and_empty_state`, `ui.persistence.reload`, `ui.validation.{empty,whitespace,too_long}`,
  `ui.api_error.{create,toggle,edit,delete,initial_load}`, `ui.loading_state`, `ui.keyboard`, `ui.state_consistency`,
  `ui.mobile`
* **browser** (9, LLM agent + deterministic assertions): `browser.{create,edit,complete,reopen,delete,filter,persistence,invalid_input,api_error}`
* **visual**: `visual.capture`, plus `visual.desktop` and `visual.mobile` *(optional, informational)*.
  The pass condition is `visualScore ≥ 95`.

Outcomes: `fail` means the app is at fault. `error` means the evaluator infrastructure failed, for
example docker, a browser crash, or the model provider being unavailable. That makes
`evaluatorFailure` true and `passed` false. Errors are retried up to 2 times, and `attempts` is
recorded for each check.

## Browser agent

* **Default backend: Claude Code + Playwright MCP on the subscription** (see the root README, "Evaluator
  browser agent"). The harness owns a headless Chromium per scenario attempt. Each goal phase is one
  `claude -p` with `--tools ""` (no built-in tools) and only the pinned `@playwright/mcp` attached over CDP.
  There is an allowlist of 14 browser tools, origins are limited to the app, and `file://` is blocked.
  The verdict comes back through `--json-schema`. Tokens come from the gateway (role `evaluator`).
* The default model is `claude-sonnet-5-5` (`$FRUGAL_EVALUATOR_MODEL`). Effort is `$FRUGAL_EVALUATOR_EFFORT`.
  Each phase is limited to 420 s, 400k tokens and 40 model calls. If the deterministic assertions fail,
  the scenario is retried once.
* `browser.api_error` turns on the forwarder's `fail-mutations-500` mode for the agent's URL during
  phase 1 and turns it off for phase 2. The deterministic UI scenarios still use `page.route`.
* The agent's verdict is only recorded. A check passes only when the deterministic API/DB/DOM
  assertions pass. They run on the same page the agent used.
* With no subscription token, all `browser.*` checks get the outcome `error`. A subscription usage limit
  also gives `error`, plus `usageLimitResetAt` on the result. The api backend (explicit `provider`) keeps
  the old tool loop (20 steps and 150k tokens per phase); its mock provider gives `error` unless
  `allowMockBrowserAgent` is set.
* **Validated live** on the reference app (all 9 scenarios pass). The harness is unit-tested with a fake
  headless runner, and the api tool layer with a scripted fake provider.
