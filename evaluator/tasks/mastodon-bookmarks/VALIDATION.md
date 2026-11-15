# Validation: mastodon-bookmarks (HIDDEN)

**Status: NOT VALIDATED END TO END.** No Mastodon image exists yet. The host has about 20 GB free,
and image builds need 30 GB (benchmark/tasks/mastodon/README.md). Everything that can be checked
without an image has been checked (see "What was verified"). The two required runs below are still
open, and so is the runtime measurement.

## Required runs (docs/TASKS.md §4)

```sh
# 1. Upstream reference (checkpoint + evaluator/tasks/mastodon-bookmarks/reference.diff):
#    must pass 100% of mandatory checks.
npx tsx evaluator/tasks/mastodon-common/cli.ts mastodon-bookmarks --reference
# 2. Bare checkpoint (empty patch): must fail the feature checks and pass startup + regression.
npx tsx evaluator/tasks/mastodon-common/cli.ts mastodon-bookmarks --bare
# (optional) any run's patch:
npx tsx evaluator/tasks/mastodon-common/cli.ts mastodon-bookmarks --patch results/runs/<id>/workspace.patch
```

The CLI builds or reuses the task image through `benchmark/tasks/mastodon-bookmarks/docker/image.ts`
(`ensureTaskImage().baseImage`) unless you pass `--image <tag>`. It prints one line per check and
writes `report.json` (with `details.timingsSec`) and `app.log` to
`$TMPDIR/frugal-mastodon-eval/mastodon-bookmarks-<mode>/`. Record the results and
`details.timingsSec.total` below.

| Run | Date | Mandatory passed | Optional passed | passed | Wall time |
|---|---|---|---|---|---|
| reference | not run yet | | | | |
| bare checkpoint | not run yet | | | | |

## Checks and the outcome each run should give

M = mandatory. "ref" is the expected outcome for the upstream reference, "bare" for the
checkpoint. The predictions come from reading the upstream diff and the checkpoint code.

| Check | M | ref | bare | Spec |
|---|---|---|---|---|
| startup.patch | M | pass | pass (empty patch) | §1 migrations / boot |
| startup.migrate | M | pass | pass | §1 |
| startup.app | M | pass | pass | boots, serves the web UI |
| upstream.bookmarks_controller:index.* (6) | M | pass | fail (NameError) | §2.5, §4 |
| upstream.statuses/bookmarks_controller:create.* (3), destroy.* (2) | M | pass | fail | §2.2, §2.3, §4 |
| regression.* (12 files) | M | pass | pass | existing behaviour |
| api.scopes.app_registration | o | pass | **pass** (Doorkeeper 5.2 doesn't enforce scopes on registration) | §2.1 |
| api.scopes.oauth_token | M | pass | fail (invalid_scope) | §2.1 |
| api.auth.unauthenticated | M | pass | fail (404, no route) | §2 errors |
| api.auth.scopes | M | pass | fail | §2.1 |
| api.bookmark.create | M | pass | fail | §2.2, §2.4 |
| api.bookmark.idempotent | M | pass | fail | §2.2 |
| api.bookmark.visibility_allowed | M | pass | fail | §2.2 |
| api.bookmark.visibility_denied | M | pass | fail (the list endpoint is missing) | §2.2 |
| api.bookmark.not_found | M | pass | **pass** (404) | §2 errors |
| api.bookmark.boost | o | pass | fail | §1 boosts, §2.2 |
| api.bookmark.destroy | M | pass | fail | §2.3 |
| api.bookmark.destroy_not_bookmarked | o | pass | **pass** (404) | §2.3 |
| api.list.order | M | pass | fail | §2.5 |
| api.list.pagination | M | pass | fail | §2.5 |
| api.list.empty_no_link | o | pass | fail | §2.5 |
| api.privacy.isolation | M | pass | fail | §2.5, §2.6 |
| api.status.bookmarked_field | M | pass | fail | §2.4 |
| api.status.bookmarked_anonymous | o | pass | **pass** (no field) | §2.4 |
| api.bookmark.status_deleted | o | pass | fail | §1 cascade |
| api.export.archive | o | pass | fail | §2.7 |
| ui.login | M | pass | pass | precondition |
| ui.bookmark.toggle | M | pass | fail | §3.1 |
| ui.bookmark.persist | M | pass | fail | §3.1 |
| ui.bookmarks.navigation | M | pass | fail | §3.3, §3.2 |
| ui.bookmarks.column | M | pass | fail | §3.2 |
| ui.bookmark.untoggle | M | pass | fail | §3.1, §3.2 |
| ui.bookmark.detail | M | pass | fail | §3.1 |

The checks marked **pass** under bare are expected to pass on the checkpoint too. They guard
against regressions (refusing what must be refused) and don't detect the feature itself. The
feature is detected by the other 29 mandatory feature checks (11 upstream, 12 API, 6 UI), so the
bare checkpoint fails overall.

Notes on the reference behaviour the checks depend on (read from the upstream diff):
* Bookmarking a boost works once (the model swaps in the original before validation). A second
  call would hit the uniqueness validation (422), because `find_or_create_by` looks up the boost's
  id. `api.bookmark.boost` therefore calls it once, on a dedicated original.
* Pagination cursors are bookmark ids. `rel="prev"` is present on every non-empty page.
* The detailed-view Bookmark button has no `aria-pressed` upstream, so `ui.bookmark.detail`
  checks the effect through the API only.

## What was verified (without an image)

* `npx vitest run evaluator/tasks`: 22 tests pass. They cover the rspec report mapping (pass, fail,
  missing and load-error examples, per-file regression aggregation), Link header parsing, runner
  output parsing, and the pipeline with a fake container: phase order, `--skip-migrate`, skip
  behaviour when the patch doesn't apply or migrations fail, per-file reruns after an upstream
  load error, and the report. They also check that every expected upstream example's full
  description exists in the hidden upstream copies (computed from the spec files), and that every
  example of the new upstream spec files is a check.
* `npx tsc --noEmit`: clean. `ruby -c`: all hidden Ruby files pass.
* Container plumbing smoke test against `node:22-bookworm-slim`, with the same `docker create`
  flags: read-only root, uid 1000, the `--internal` network has no egress (DNS fails), the TCP
  forwarder reaches the app port, and the Host header is preserved (`127.0.0.1:<port>`).
* The upstream reference was read check by check against the checkpoint code: controllers,
  policy, `cache_collection` ordering, `set_pagination_headers`, Doorkeeper 5.2 scope handling, and
  the IconButton/Icon markup that sets the accessible names.

## Runtime budget (estimate, not measured)

Launch and services about 15 s. Migrate about 20 s. Then `app start` (dev webpack compile 3 to 6 min,
then puma boot) runs alongside the test schema load and the seed (about 20 s each). rspec (about 2 min)
starts only after `app start` returns, because the compile peaks at 3 to 4 GB of a 6 GB container.
It then overlaps the API checks (about 1 min) and the UI checks (1 to 2 min). Expected total: 7 to 10 minutes on 4 CPUs and 6 GB. The pack compile
dominates.
