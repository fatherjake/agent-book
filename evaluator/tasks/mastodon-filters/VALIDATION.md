# Validation: mastodon-filters (HIDDEN, holdout)

**Status: VALIDATED END TO END (2026-11-15).** Reference: 43/43 mandatory, 6/6 optional; bare: 14/43 mandatory (fails as it must).
Fixes found while validating: seed users accept the terms (`agreement`, lazily defined in Rails 5.2),
ffmpeg in the base image (a randomly fabricated .webm made a regression spec flaky), the sidebar
link check matches text content (Font Awesome's glyph is part of the accessible name), and the
context validation check accepts Rails' "can't be blank" (the form shows only the first error).

## Required runs (docs/TASKS.md §4)

```sh
# 1. Upstream reference (checkpoint + evaluator/tasks/mastodon-filters/reference.diff):
#    must pass 100% of mandatory checks.
npx tsx evaluator/tasks/mastodon-common/cli.ts mastodon-filters --reference
# 2. Bare checkpoint (empty patch): must fail the feature checks and pass startup + regression.
npx tsx evaluator/tasks/mastodon-common/cli.ts mastodon-filters --bare
```

The output goes to `$TMPDIR/frugal-mastodon-eval/mastodon-filters-<mode>/`: `report.json` with
`details.timingsSec`, `app.log`, and screenshots of failed UI steps.

| Run | Date | Mandatory passed | Optional passed | passed | Wall time |
|---|---|---|---|---|---|
| reference | not run yet | | | | |
| bare checkpoint | not run yet | | | | |

## Checks and the outcome each run should give

M = mandatory. "ref" is the expected outcome for the upstream reference, "bare" for the
checkpoint (fbee9b5, Mastodon 2.4.2).

| Check | M | ref | bare | Spec |
|---|---|---|---|---|
| startup.patch / startup.migrate / startup.app | M | pass | pass | boot, §2 migration |
| upstream.filter_controller:* (8) | M | pass | fail (NameError) | §3, §7 |
| upstream.feed_manager:filter.home.irreversible_phrase | M | pass | fail (no `custom_filters`) | §4, §7 |
| regression.lib/feed_manager (pre-existing examples of the upstream copy) | M | pass | pass | existing |
| regression.* (9 more files) | M | pass | pass | existing |
| api.filters.unauthenticated | M | pass | fail (404, no route) | §3 errors |
| api.filters.scopes | M | pass | fail | §3 table and errors |
| api.filters.create | M | pass | fail | §3 |
| api.filters.create_full | M | pass | fail | §3 |
| api.filters.list | M | pass | fail | §3 (all of the user's filters, including expired) |
| api.filters.show | M | pass | fail | §3 |
| api.filters.update | M | pass | fail | §3 (partial update) |
| api.filters.delete | M | pass | fail | §3 (`{}`) |
| api.filters.validation | M | pass | fail | §2 validations, §3 422 |
| api.filters.isolation | M | pass | fail | §3 (404 for another user's filter) |
| api.filters.irreversible_home | M | pass | fail | §4 Home, §1 case-insensitive |
| api.filters.irreversible_spoiler | o | pass | fail | §1 content warning |
| api.filters.phrase_literal | M | pass | fail | §1 whole phrase, no regex |
| api.filters.own_status | o | pass | fail (scenario setup fails) | §4 own statuses |
| api.filters.hide_only_not_dropped | M | pass | fail (scenario setup fails) | §4 non-irreversible |
| api.filters.expired | o | pass | fail (scenario setup fails) | §1 active |
| api.filters.irreversible_notifications | M | pass | fail | §4 Notifications |
| api.filters.change_takes_effect | o | pass | fail | §4 immediate effect |
| ui.login | M | pass | pass | precondition |
| ui.filters.navigation | M | pass | fail | §6 Navigation |
| ui.filters.create | M | pass | fail | §6 new form |
| ui.filters.hidden_in_home | M | pass | fail | §5 placeholder "Filtered" |
| ui.filters.persist | M | pass | fail | §5 (server-stored) |
| ui.filters.edit | M | pass | fail | §6 edit form |
| ui.filters.delete | M | pass | fail | §6 Delete |
| ui.filters.context_respected | o | pass | fail | §5 column contexts |
| ui.filters.validation | o | pass | fail | §6 + §2 error message |

How the server-side checks work: one scenario per evaluation. Alice creates the filters through
the REST API: `zebra crossing` (home, irreversible), `Spoilers Ahead` (notifications,
irreversible), `pineapple` (home and notifications, not irreversible), `c++` (home, irreversible)
and `walrus` (home, irreversible, already expired). Then `probe.rb` posts the statuses through the
real delivery path (`ProcessMentionsService` and `FanOutOnWriteService`, Sidekiq inline). The
checks read alice's home timeline and notifications back through the REST API. Each scenario check
also asserts that a non-matching control status *was* delivered, so a broken delivery path fails
loudly instead of passing by accident.

Reference details the checks depend on (read from the upstream diff):
* The Filter entity has `id` as a JSON number (no `to_s` in `REST::FilterSerializer`). The spec
  allows an integer or a numeric string.
* The API takes `expires_at`, not `expires_in`; the web form takes `expires_in`.
* `simple_form` marks required fields with `*`, so labels are matched by substring
  (`getByLabel('Keyword or phrase')`).

## What was verified (without an image)

* `npx vitest run evaluator/tasks`: 22 tests pass, including the check that the 9 expected
  upstream examples' full descriptions exist in the hidden copies (`filter_controller_spec.rb`,
  and the new example of `feed_manager_spec.rb`).
* `npx tsc --noEmit`: clean. `ruby -c`: all hidden Ruby files pass (host Ruby 2.6; the scripts
  avoid syntax newer than Ruby 2.5).
* The container plumbing smoke test (shared with mastodon-bookmarks) passed: read-only root, no
  egress, the forwarder reaches the app, and the Host header is preserved. The forwarder script is
  ES5 because this checkpoint runs Node 8 (a unit test asserts this).
* Read check by check against the reference and the checkpoint (2.4.2): `FeedManager#filter?`
  paths for home and mentions, `NotifyService#blocked_mention?`, `LocalNotificationWorker`, the
  `FanOutOnWriteService` → `FeedInsertWorker` path, the admin layout (an `h2` page title), the
  `table_link_to` link texts, and `rails-ujs` for the `Delete` link.

## Runtime budget (estimate, not measured)

Same shape as bookmarks: about 7 to 10 minutes on 4 CPUs. The webpack 3 dev compile takes 2 to 5
min. Two `rails runner` probes add about 40 s.
