# Todo App: Product Requirements

Build a full-stack todo application on top of the starter project in `/workspace`.
Spec files (read-only) are in `/spec`:

| File | Content |
|---|---|
| `requirements.md` | This document. |
| `api-contract.yaml` | OpenAPI 3 contract: exact request/response schemas, status codes, error codes, validation limits, ordering. |
| `design-tokens.md` | Exact colors, typography, spacing and layout for both viewports. |
| `design.png` | Reference screenshot, desktop 1280×800. |
| `design-mobile.png` | Reference screenshot, mobile 390×844. |
| `fixtures.json` | Example data; the `design` set is the data shown in the reference screenshots. |

## 1. Run contract

* Working directory `/workspace`. Keep the starter layout: React + Vite frontend in `frontend/`,
  Express backend in `backend/`, a single `package.json` at the root.
* `npm run build` builds the frontend. `npm start` starts **one** Node process that serves the
  REST API under `/api` and the built frontend at `/` (any other non-API path returns the frontend's
  `index.html`).
* Environment variables:
  * `PORT`: HTTP port, default `3000`.
  * `DATABASE_PATH`: SQLite file path, default `./data/todos.db`. Create the parent directory, the
    database file and the table on startup if they don't exist. Existing data must be kept across
    restarts.
* The app is ready when `GET /api/todos` returns 200.
* Use only the dependencies already installed in the starter (React, react-dom, Vite,
  @vitejs/plugin-react, Express, better-sqlite3, @fontsource/inter). There is no network access,
  so nothing else can be installed. The frontend must not load anything from the internet.
* The app must start and run without errors in the console or server log under normal use.

## 2. Data model and persistence

```ts
type Todo = { id: number; title: string; completed: boolean; createdAt: string /* ISO-8601 UTC */ };
```

Store todos in SQLite with `better-sqlite3`, using exactly this table:

```sql
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
```

`completed` is stored as `0`/`1` and exposed by the API as a boolean. `created_at` holds the
`createdAt` string. The database is the single source of truth: every change made in the UI must be
written through the API, and everything shown in the UI must match the database.

## 3. REST API

Implement exactly what `api-contract.yaml` specifies. Summary:

| Method and path | Success | Notes |
|---|---|---|
| `GET /api/todos` | 200 `Todo[]` | Ordered by `createdAt` ascending, then `id` ascending. |
| `POST /api/todos` `{ title }` | 201 `Todo` | Title trimmed, 1–200 characters (Unicode code points). `completed` starts `false`. |
| `PATCH /api/todos/:id` `{ title?, completed? }` | 200 `Todo` | At least one of the two fields. Same title rules. |
| `DELETE /api/todos/:id` | 204, empty body | |

Errors always have the body `{ "error": { "code": string, "message": string } }`:

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing, empty (after trimming) or too long title; `title` not a string; `completed` not a boolean; PATCH without `title` or `completed`; body not valid JSON or not a JSON object. |
| 404 | `NOT_FOUND` | Unknown id, an id that is not a positive integer, or an unknown `/api` path. |
| 500 | `INTERNAL_ERROR` | Unexpected failure. |

Unknown request fields are ignored.

## 4. Functional requirements

The user can:

1. **Create** a todo by typing a title in the new-todo input and pressing Enter or clicking
   **Add**. The new todo appears at the end of the list. The input is cleared after a successful
   create.
2. **Edit** a todo's title: clicking the todo's **Edit** button switches that row to edit mode
   with a text input prefilled with the current title (and focused). Pressing Enter or clicking
   **Save** saves; pressing Escape or clicking **Cancel** leaves edit mode without changes. Only one
   todo is in edit mode at a time. Titles are trimmed and validated like new titles.
3. **Complete** a todo by checking its checkbox. Completed todos show their title with a
   line-through.
4. **Reopen** a completed todo by unchecking its checkbox.
5. **Delete** a todo with its **Delete** button. It is deleted immediately, with no confirmation
   dialog.
6. **View all** todos (filter **All**, the default when the page loads).
7. **Filter active** todos (filter **Active**: only todos that are not completed).
8. **Filter completed** todos (filter **Completed**: only completed todos).
   Filters apply immediately. When a todo stops matching the current filter (for example, it is
   completed while **Active** is selected) it disappears from the list.
9. **Persistence**: all changes are saved in the database, so reloading the page shows the same todos
   in the same state.
10. **Validation**: an empty or whitespace-only title, or a title longer than 200 characters after
    trimming, is rejected with a visible error message. Nothing is saved. Don't silently truncate
    input or use `maxlength`; show the error instead. The user's text stays in the input so they can
    fix it.
11. **API errors**: if a request fails (network error, any non-2xx response, or a non-JSON
    response body), show a visible error message, using the API's `error.message` when it's
    available. The app must remain fully usable afterwards. A failed change must never look as if it
    succeeded: the UI either never applies it or reverts it. The next successful action clears
    the error message.
12. **Consistency**: after every action the list, checkboxes, titles and counter shown in the UI
    match the server state.

Also:

* A **counter** shows the number of active (not completed) todos across all todos, regardless of
  the filter: `0 items left`, `1 item left`, `2 items left`, and so on.
* The counter and the filter buttons are always visible, even when there are no todos.

## 5. Loading, error and empty states

* **Loading**: while the initial list is loading, show a loading message (e.g. `Loading…`) in an
  element with `role="status"`.
* **Initial load failure**: show an error message in the alert element (below) and a **Retry**
  button that loads the list again.
* **Errors** (validation and API errors) are shown as text inside an element with `role="alert"`
  that appears below the new-todo form.
* **Empty**: when no todos match the current filter, show the text `No todos` where the list
  would be.

## 6. Accessibility and semantics

These are product requirements. Use them exactly as written (names are case-sensitive).

* One `h1` heading with the text `Todos`.
* New-todo form: a text input whose accessible name is `New todo` (for example a visually hidden
  `<label>`), and a submit button named `Add`. Pressing Enter in the input submits.
  Placeholder text: `What needs to be done?`.
* The list is a `<ul aria-label="Todo list">` with exactly one `<li>` per visible todo, in API
  order.
* Each todo row has:
  * a checkbox (`<input type="checkbox">`) with the accessible name `Toggle <title>`, e.g.
    `Toggle Buy groceries`;
  * the title as visible text;
  * a button with the visible text `Edit` and the accessible name `Edit <title>`;
  * a button with the visible text `Delete` and the accessible name `Delete <title>`.
* Edit mode: a text input with the accessible name `Edit title`, plus buttons named `Save` and
  `Cancel`.
* Filters: three buttons named `All`, `Active` and `Completed`. The selected one has
  `aria-pressed="true"` and the others `aria-pressed="false"`.
* Counter text exactly in the form `N item left` / `N items left` (see above).
* Everything works with the keyboard alone: Tab reaches every control in a logical order, Enter
  submits forms, Space toggles checkboxes, Escape cancels editing. Focus is visible.
* Use real `<button>`, `<input>` and `<form>` elements, not clickable `<div>`s.

## 7. Visual design

Match `design.png` (desktop) and `design-mobile.png` (mobile) as closely as possible.
`design-tokens.md` gives the exact values. Key points:

* Inter font from the bundled `@fontsource/inter` package (weights 400, 500, 600 and 700).
* Light grey page (`#F3F4F6`) with the `Todos` heading and one white card centered in a 560px-wide
  column. The card contains, top to bottom: the new-todo form, the error alert (only when there is
  an error), the todo rows (or the empty/loading message), and a footer with the counter on the left
  and the filter buttons on the right.
* Each row: checkbox, title, then `Edit` and `Delete` buttons aligned right.
* Responsive layout: the reference viewports are **1280×800** and **390×844**. At widths of
  480px and below, use the mobile values from `design-tokens.md` (smaller page padding and heading).
  There must be no horizontal scrolling at 390px wide; long titles wrap inside the row.
* No gradients, shadows, transitions, animations, icons or images. The UI does not show dates.
* The page `<title>` is `Todos`.

## 8. Quality bar

The app is finished when all of the above works in a real browser against the real backend:
a fresh database, the reference viewports, page reloads, invalid input and failing API requests.
Build it with `npm run build`, start it with `npm start`, and check it yourself.
