You are working autonomously on a benchmark task in a sandboxed container. Nobody will answer questions, so decide yourself and keep going until the job is done. There is no network; use only what is installed. The task prompt and /spec/feature.md are the contract.

Cost model: every tool call re-sends the whole conversation, so each extra call costs more than the last. Total cost is roughly (number of calls) x (context size). Aim for about 15-20 calls in total.

How to work:
- Call 1: read /spec/feature.md in the same Bash call that lists the existing analogue files (favourites, pins, mutes: models, controllers, serializers, policies, scopes, routes, specs, redux actions/reducers/components, locales). Do not read the spec again later.
- Call 2-3: read all analogue files you will mirror in one or two big batched commands. Print only the line ranges you need; cap every output with head, tail or grep. Never print whole big files (routes, locales, scss, large reducers) and never re-read a file you have already seen.
- Build by copying the closest analogue with sed or a small Ruby/Node edit script run from Bash, then adjusting. Make many edits per call (backend, migration, specs, frontend, locales, styles all together) rather than one file per call. Prefer one correct whole-file write over several patch-ups.
- Do the backend first, then the frontend, covering every entry point the spec lists (API, scopes, data model, account deletion/export hooks if the spec asks, web UI action bar, column, route, navigation, locale strings with the exact accessible names).
- Use Bash for everything (cat, sed, heredocs); the Read and Edit tools are not needed.

Verification (do each at most once unless it fails; filter output to failures only, e.g. grep for examples/failures/errors):
- Run migrations for development and test (RAILS_ENV=test), then rspec only on your new specs plus the closely related existing spec directories (api controllers, models, services). Do not run the entire suite.
- Run eslint on the touched javascript. Do not run npm run build or a separate webpack build: `/opt/frugal/task/app start` already compiles the assets (several minutes, run it once, give it a long timeout, never poll with sleep, and avoid restarting it).
- After the app is up, run `uiseed` (helper on PATH, one call): it seeds a confirmed user with the onboarding modal already dismissed, an OAuth token and one public status, prints TOKEN/SID/AID/EMAIL/PASSWORD, and writes /tmp/pwlib.js exporting login(page), api(token, method, path), BASE. Do NOT hand-seed users or web settings. Then write ONE combined Playwright script (run via /opt/frugal/task/pw-node, CommonJS, require('/tmp/pwlib.js')) that checks the API with the token and the UI: call login(page), open /web/statuses/<SID> and /web/accounts/<AID> (a status list that reliably shows the seeded status) and check the new toggle in the status action bar and the new list column. Wait for selectors with generous timeouts instead of fixed sleeps. Print only short results. Allow at most one retry of the harness; if the UI check still fails for harness reasons, stop and finish, since the code review of the diff plus the API check is enough. Fix real feature bugs, not harness quirks.
- Then run `app stop`, check `git status` for stray files you created in the repo (remove scratch files), and finish.

Finish with a summary of at most three sentences.
