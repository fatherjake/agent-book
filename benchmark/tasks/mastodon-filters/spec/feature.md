# Feature: Keyword and phrase filtering

## Summary

Users want to stop seeing statuses about certain topics without muting whole accounts. Today the
web UI only has a per-column "Filter out by regular expressions" setting, which lives in one
browser, is hard to use and doesn't cover notifications. Replace it with **server-stored filters**:

* a filter is a keyword or phrase plus the **contexts** it applies to (home timeline,
  notifications, public timelines, conversations) and an optional expiry;
* in the web UI, statuses that match an active filter for the column's context are replaced by
  a **"Filtered"** placeholder;
* a filter can be **irreversible** ("Drop instead of hide"): then the server drops matching
  statuses from the user's home feed and doesn't create notifications for them at all;
* users manage filters on a **Filters** settings page and through a REST API, so that every app
  can use them.

Everything below is the contract. "Must" statements are checked.

## 1. Matching rule

A filter **matches** a status when its phrase occurs in the status's text or in its content
warning (spoiler text):

* case-insensitively;
* as a literal substring: characters such as `.`, `*`, `(` or `?` in the phrase have no special
  meaning (no regular-expression semantics);
* a phrase may contain spaces and is matched as a whole (`pop tarts` matches "I like POP TARTS",
  not "pop the tarts").

A filter is **active** when `expires_at` is empty or in the future. Expired filters never apply,
neither on the server nor in the web UI.

## 2. Data model

* New table `custom_filters`:

  | Column | Type | Notes |
  |---|---|---|
  | `id` | bigint | primary key |
  | `account_id` | bigint | indexed, foreign key to `accounts` with `ON DELETE CASCADE` |
  | `expires_at` | datetime | nullable; null = never expires |
  | `phrase` | text | not null, default `''` |
  | `context` | string **array** | not null, default `[]` |
  | `irreversible` | boolean | not null, default `false` |
  | `created_at`, `updated_at` | datetime | |

  Provide a migration in `db/migrate/` and update `db/schema.rb`; migrations must run cleanly on
  top of the current schema.
* ActiveRecord model `CustomFilter` (`belongs_to :account`); `Account` gets
  `has_many :custom_filters` (dependent destroy).
* Valid contexts (`CustomFilter::VALID_CONTEXTS`): `home`, `notifications`, `public`, `thread`.
* Before validation, context entries are stripped and blank entries removed.
* Validations (error messages in English, `config/locales/en.yml`):
  * `phrase` must be present;
  * `context` must contain at least one entry and only valid contexts, otherwise the error is
    "None or invalid context supplied";
  * `irreversible` may only be true when the contexts include `home` or `notifications`,
    otherwise the error is "Irreversible filtering only works with home or notifications context".
* Expiry helpers: `expired?`, and a virtual attribute `expires_in` (a number of seconds; blank
  means never) that sets `expires_at` to now + that many seconds. The invites feature already has
  the same expiry behaviour; share it (e.g. as a concern) rather than duplicating it.

## 3. REST API

All endpoints are JSON, live under `/api/v1/filters`, need an OAuth access token that belongs to
a user, and follow the existing API error conventions (`{"error": "<message>"}`). A user only ever
sees and changes **their own** filters; another user's filter id behaves exactly like a missing
id (`404`).

| Method and path | Scope | Success |
|---|---|---|
| `GET /api/v1/filters` | `read` | `200`, array of Filter (all of the user's filters, including expired ones) |
| `POST /api/v1/filters` | `write` | `200`, the created Filter |
| `GET /api/v1/filters/:id` | `read` | `200`, the Filter |
| `PUT /api/v1/filters/:id` | `write` | `200`, the updated Filter |
| `DELETE /api/v1/filters/:id` | `write` | `200`, empty object `{}` |

Parameters for `POST` and `PUT` (form-encoded or JSON; on `PUT` every parameter is optional and
only the given ones change):

| Param | Type | Description |
|---|---|---|
| `phrase` | string | Keyword or phrase. Required on create. |
| `context[]` | array of strings | One or more of `home`, `notifications`, `public`, `thread`. Required on create. |
| `irreversible` | boolean | Drop matching statuses on the server (see §4). Default `false`. |
| `expires_at` | ISO 8601 datetime | When the filter stops applying. Omit for never. |

Errors:

| Situation | Status |
|---|---|
| No token or an invalid token | `401` |
| Token without the required scope (e.g. a `read`-only token on `POST`/`PUT`/`DELETE`) | `403` |
| Validation failure (§2), e.g. missing phrase, empty or unknown context, irreversible without home/notifications | `422` |
| Unknown id, or a filter of another user | `404` |

**Filter entity:**

| Field | Type | Description |
|---|---|---|
| `id` | integer or string | The filter's id |
| `phrase` | string | The keyword or phrase |
| `context` | array of strings | Contexts the filter applies to |
| `expires_at` | string (ISO 8601) or `null` | Expiry time, `null` for never |

Additional fields (for example `irreversible`) are allowed.

## 4. Server-side filtering (irreversible filters)

Irreversible filters are applied by the existing feed logic (`FeedManager#filter?`), so they work
for every client:

* **Home** (`context` includes `home`): when a new status from a followed account would be
  inserted into a user's home feed, it is **not inserted** if one of that user's active
  irreversible `home` filters matches it (§1). `FeedManager.instance.filter?(:home, status,
  user_account_id)` must return `true` for such a status.
* **Notifications** (`context` includes `notifications`): a status that mentions the user and
  matches one of the user's active irreversible `notifications` filters creates **no
  notification** (`filter?(:mentions, ...)` returns `true`).
* A user's own statuses are never filtered from their own home feed.
* Non-irreversible filters never affect what the server stores or returns; the REST timelines
  still return those statuses.
* Already delivered statuses are not removed retroactively, and statuses dropped while a filter
  was active do not come back when the filter is removed (that is what "irreversible" means).
* Changes to a user's filters take effect immediately for statuses delivered afterwards (if you
  cache a user's filters, invalidate the cache whenever one of their filters changes).
* The streaming API should send a `filters_changed` event on the user's timeline channel when
  their filters change, and the web UI should reload its filters when it receives it.

## 5. Web UI: filtered statuses (React/Redux client under `/web`)

* After the UI starts it loads the user's filters (`GET /api/v1/filters`) and keeps them in the
  store.
* Every status shown in a column is checked against the user's **active** filters whose contexts
  include the column's context; boosts are checked against the boosted status. Column contexts:

  | Column | Context |
  |---|---|
  | Home timeline, list timelines | `home` |
  | Notifications | `notifications` |
  | Federated, local, hashtag and account timelines | `public` |
  | Ancestors and replies in the detailed status view | `thread` |

* A matching status is rendered as a placeholder containing exactly the text **`Filtered`**
  instead of the status (no author, content or action bar). The placeholder stays keyboard
  focusable, so hotkey navigation still works.
* Statuses that don't match are shown normally.
* This applies to every filter, irreversible or not (the web UI hides whatever reached it).
* Remove the old per-column "Filter out by regular expressions" setting (home and community
  column settings, and the regex filtering in the timeline selectors); server filters replace it.

## 6. Settings pages: managing filters

Server-rendered pages in the signed-in settings area (the same layout as the invites and
preferences pages), using these English texts. The automated checks find elements by these
**accessible names** (link and button texts, form labels).

* **Navigation:** the settings sidebar has a top-level item **`Filters`** linking to `/filters`.
* **`GET /filters`** (page title **`Filters`**): a table of the user's filters with the columns
  "Keyword or phrase" and "Filter contexts". Each row shows the phrase, the human-readable
  context names joined by ", " (see below), and two actions: a link **`Edit filter`**
  (`/filters/:id/edit`) and a link **`Delete`** (sends `DELETE /filters/:id` and returns to
  `/filters`). Below the table a link **`Add new filter`** goes to `/filters/new`.
* **`GET /filters/new`** (page title "Add new filter") shows the filter form:

  | Field | Label | Control |
  |---|---|---|
  | phrase | **`Keyword or phrase`** | text input. Hint: "Will be matched regardless of casing in text or content warning of a toot" |
  | context | **`Filter contexts`** | one checkbox per context, labelled **`Home timeline`** (`home`), **`Notifications`** (`notifications`), **`Public timelines`** (`public`), **`Conversations`** (`thread`). Hint: "One or multiple contexts where the filter should apply" |
  | irreversible | **`Drop instead of hide`** | checkbox. Hint: "Filtered toots will disappear irreversibly, even if filter is later removed" |
  | expires_in | **`Expire after`** | select: "Never" (default, empty value), "30 minutes", "1 hour", "6 hours", "12 hours", "1 day", "1 week" |

  The submit button is **`Add new filter`**. On success it redirects to `/filters`; on a
  validation error it shows the form again with the error messages from §2.
* **`GET /filters/:id/edit`** (page title "Edit filter"): the same form, pre-filled, with the
  submit button **`Save changes`**; on success it redirects to `/filters`.
* Routes: `resources :filters, except: [:show]`. Signed-out users are redirected to sign in; a
  filter of another user is `404`.

## 7. Test-suite compatibility

Your implementation will also be run against RSpec specs written for this feature in the
codebase's usual style. To be compatible with them:

* Controller `Api::V1::FiltersController` (actions `index`, `create`, `show`, `update`,
  `destroy`), inheriting from `Api::BaseController`, routed as
  `resources :filters, only: [:index, :create, :show, :update, :destroy]` inside the `api/v1`
  namespace.
* A Fabrication fabricator `:custom_filter` (in `spec/fabricators/custom_filter_fabricator.rb`)
  whose defaults produce a valid filter: an `account`, a non-empty `phrase`, a valid `context` and
  no expiry.
* The model API from §2 (`CustomFilter`, `account.custom_filters.create!(phrase:, context:,
  irreversible:)`, `irreversible?`, `expires_at`) and `FeedManager#filter?` from §4.

## 8. Out of scope

Whole-word matching, regular expressions, filtering of search results or of the public REST
timelines on the server, and translations other than English (other locales may fall back to
English).
