# Feature: Bookmarks

## Summary

Users want to save statuses for later without telling anybody. Favourites don't work for that:
they notify the author, are federated and are publicly countable. A **bookmark** works like a
favourite for the person who makes it, but it is completely private:

* only the bookmarking user can ever see that a bookmark exists;
* bookmarks are never federated (no ActivityPub activity is sent or received), never notify the
  author, and are not counted on the status;
* a user can bookmark any status they are allowed to see, of any visibility, and remove the
  bookmark again;
* the user's bookmarks are listed, most recently bookmarked first, in the REST API and in a
  "Bookmarks" column of the web UI.

Everything below is the contract. "Must" statements are checked.

## 1. Data model

* New table `bookmarks` with `id` (bigint primary key), `account_id` (bigint, not null),
  `status_id` (bigint, not null), `created_at`, `updated_at`.
* A unique index on `(account_id, status_id)`: an account bookmarks a status at most once.
* Foreign keys to `accounts` and `statuses` with `ON DELETE CASCADE`: deleting the account or the
  status removes its bookmarks.
* Provide a migration in `db/migrate/` and update `db/schema.rb`. Migrations must run cleanly on
  top of the current schema.
* ActiveRecord model `Bookmark` (`app/models/bookmark.rb`) with `belongs_to :account` and
  `belongs_to :status`, validating uniqueness of the status per account.
* `Account` gets `has_many :bookmarks` (dependent destroy) and `Status` gets `has_many :bookmarks`
  (dependent destroy).
* **Boosts:** bookmarking a boost (reblog) bookmarks the original status instead. A `Bookmark`
  whose `status` is set to a reblog must store the reblogged (original) status when validated or
  saved.
* `Account#bookmarked?(status)` returns `true` if the account has bookmarked that status (for a
  boost: its original), else `false`.

## 2. REST API

All endpoints are JSON, live under `/api/v1`, need an OAuth access token that belongs to a user
(`Authorization: Bearer <token>`), and follow the existing API conventions for errors
(`{"error": "<message>"}`).

Common error responses (same behaviour as the other user-scoped endpoints, e.g. favourites):

| Situation | Status |
|---|---|
| No token or an invalid token | `401` |
| Token without a required scope | `403` |
| Token whose user no longer exists (no resource owner) | `422` |
| Status id does not exist | `404` |

### 2.1 OAuth scopes

Add two granular scopes, next to the existing ones (`read:favourites`, `write:favourites`, ...):

| Scope | Grants | Covered by |
|---|---|---|
| `read:bookmarks` | listing your bookmarks | `read` |
| `write:bookmarks` | bookmarking and un-bookmarking | `write` |

Applications must be able to request them: registering an app (`POST /api/v1/apps`) with
`scopes=read:bookmarks write:bookmarks` must succeed, and so must obtaining a token with those
scopes through the OAuth token endpoint. Add the scope descriptions to the OAuth authorization
screen's English locale like the other scopes (e.g. "see your bookmarks", "bookmark statuses").

### 2.2 Bookmark a status

`POST /api/v1/statuses/:id/bookmark`, scope `write:bookmarks` (or `write`). No body.

* The user must be allowed to see the status (the same rule as viewing it: public and unlisted
  statuses, followers-only statuses of accounts they follow, their own statuses, and direct
  statuses that mention them). If not, respond `403` or `404` and create nothing.
* Creates the bookmark, or does nothing if it already exists (the call is **idempotent**: it
  responds `200` again and never creates a duplicate).
* If `:id` is a boost, the original status is bookmarked (see §1) and returned.
* Response `200`: the bookmarked [Status](#24-status-entity) entity with `"bookmarked": true`.

### 2.3 Remove a bookmark

`POST /api/v1/statuses/:id/unbookmark`, scope `write:bookmarks` (or `write`). No body.

* Removes the user's bookmark of that status.
* Response `200`: the Status entity with `"bookmarked": false`.
* If the user has not bookmarked that status, respond `404`.

### 2.4 Status entity

The existing Status entity (`REST::StatusSerializer`) gets one new attribute:

| Field | Type | Description |
|---|---|---|
| `bookmarked` | boolean | Whether the **current user** has bookmarked this status. |

Like `favourited`, `reblogged` and `muted`, it is present only when the request is made with a
user token, and it is computed for the requesting user only (another user's bookmarks never
influence it). It must be correct everywhere statuses are rendered for a user: single status
(`GET /api/v1/statuses/:id`), timelines (home, public, account statuses, ...), contexts and the
bookmarks list. Bulk renderings should compute it with one query per page (extend
`StatusRelationshipsPresenter` the way favourites are handled), not one per status.

### 2.5 List bookmarks

`GET /api/v1/bookmarks`, scope `read:bookmarks` (or `read`).

Query parameters:

| Param | Default | Description |
|---|---|---|
| `limit` | 20 | Page size; at most 40 (larger values are clamped to 40). |
| `max_id` | | Return results older than this cursor. |
| `since_id` | | Return results newer than this cursor. |

Response `200`: a JSON array of Status entities, **only the requesting user's** bookmarks,
ordered by bookmark creation, most recently bookmarked first. Each entity has
`"bookmarked": true`.

**Pagination** uses the `Link` response header, like `GET /api/v1/favourites`. The cursor values
are the IDs of the **bookmark records** (not the status IDs), so clients must follow the links
instead of building cursors from statuses.

* `rel="next"` (older page): present only if this page is full (it contains exactly `limit`
  results). URL: `/api/v1/bookmarks?limit=<limit>&max_id=<id of the last (oldest) bookmark on
  this page>` (keep `limit` only if the request had it; `limit` comes before the cursor).
* `rel="prev"` (newer page): present whenever the page is not empty. URL:
  `/api/v1/bookmarks?limit=<limit>&since_id=<id of the first (newest) bookmark on this page>`.
* When the result is empty there is no `Link` header at all.
* Links are absolute URLs on the instance's host, e.g.
  `Link: <https://example.com/api/v1/bookmarks?limit=1&max_id=7>; rel="next", <https://example.com/api/v1/bookmarks?limit=1&since_id=7>; rel="prev"`.

Following the `next` links from the first page must visit every bookmark exactly once.

### 2.6 Privacy

* Nobody but the owner can list or detect another user's bookmarks: there is no endpoint that
  shows bookmarks of other accounts, and `bookmarked` is always computed for the requesting user.
* Bookmarking creates no notification, no ActivityPub activity and no counter.

### 2.7 Archive export

The user's data export ("Request your archive", `BackupService`) includes a `bookmarks.json` file
next to `likes.json`: an ActivityPub `OrderedCollection` whose `orderedItems` are the URIs of the
bookmarked statuses and whose `totalItems` is their count. The actor document in the archive
references it as `"bookmarks": "bookmarks.json"`.

## 3. Web UI (React/Redux client under `/web`)

The UI must use these English texts as **accessible names** (via `title`/`aria-label` or visible
text); the automated checks find elements by them.

### 3.1 Bookmark button on statuses

* Every status action bar shows a **Bookmark** button next to the existing reply, boost and
  favourite buttons: in timelines and other status lists, and in the detailed status view
  (`/web/statuses/:id`).
* Accessible name: **`Bookmark`** (the same name in both states; use the `bookmark` Font Awesome
  icon).
* In status lists the button exposes its state with `aria-pressed="true"` when the status is
  bookmarked and `aria-pressed="false"` when it is not (as the favourite button does), and gets
  the `active` class when bookmarked.
* Clicking it bookmarks the status through `POST /api/v1/statuses/:id/bookmark`, clicking it again
  removes the bookmark through `POST /api/v1/statuses/:id/unbookmark`. The button reflects the new
  state right away, and the state survives a page reload (it comes from the `bookmarked` field).
* Logged-out (public) pages show the button disabled.

### 3.2 Bookmarks column

* Route **`/web/bookmarks`** shows a column titled **`Bookmarks`** (column heading text and the
  column's label), with the `bookmark` icon and a back button.
* It loads `GET /api/v1/bookmarks` and lists the bookmarked statuses, most recently bookmarked
  first, loading older pages when scrolling to the end (following the `next` link).
* Bookmarking a status anywhere adds it to the top of the loaded list; removing a bookmark
  removes it from the list.
* When there are no bookmarks it shows an empty-state message, e.g. "You don't have any
  bookmarked toots yet. When you bookmark one, it will show up here."
* In the advanced (multi-column) layout the column can be pinned like Favourites (column type
  `BOOKMARKS`).

### 3.3 Entry points

A link with the text **`Bookmarks`** pointing to `/web/bookmarks` must be added:

* in the navigation panel of the single-column layout (next to "Favourites"), and
* in the "Getting started" menu (`/web/getting-started`, next to "Favourites").

## 4. Test-suite compatibility

Your implementation will also be run against RSpec controller specs written for this feature in
the codebase's usual style. To be compatible with them:

* Controllers: `Api::V1::BookmarksController` (`index`) and `Api::V1::Statuses::BookmarksController`
  (`create` and `destroy`, routed as `POST /api/v1/statuses/:status_id/bookmark` and
  `POST /api/v1/statuses/:status_id/unbookmark`), both inheriting from `Api::BaseController`.
* `Api::V1::BookmarksController#index` assigns the statuses it renders to `@statuses`.
* A Fabrication fabricator `:bookmark` (in `spec/fabricators/bookmark_fabricator.rb`) whose
  defaults fabricate both an `account` and a `status`.
* The model API from §1 (`Bookmark`, `account.bookmarks`, `Account#bookmarked?`).

## 5. Out of scope

Federation of bookmarks, bookmark counts, folders/tags for bookmarks, and translations other than
English (other locales may fall back to English).
