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
- Run eslint on every touched or new javascript file (it also catches unresolved imports and syntax errors), and parse the touched locale json files with node.
- Do NOT start the app, use Playwright, seed users or tokens, or run webpack or npm run build. In earlier runs the live-UI check cost 8-12 extra calls (onboarding modal, login, page choice) and never found a real bug; the evaluator boots the app and checks UI and API itself. Instead make the frontend correct by construction: mirror the closest existing analogue one-to-one, and in ONE batched grep call confirm that every new action, reducer, route, column, navigation entry and component is registered and imported where its analogue is, and that the exact accessible names and locale strings from the spec appear in the component and in en.json.
- Your own rspec specs must cover the API behaviours in the spec (errors, pagination links, ownership, the boost case). Fix any real failure once, then stop.
- Check `git status` for stray files you created in the repo (remove scratch files), and finish.

Finish with a summary of at most three sentences.
