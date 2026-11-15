---
name: contract-notes
description: Condensed requirements of the todo API and UI. Use before writing the backend or the UI.
---

# Contract notes (paraphrased from /spec; the spec is authoritative)

Backend
- One Node process serves `/api/*` and the built frontend, with an SPA fallback for non-API GET routes.
- Honour `PORT` and `DATABASE_PATH`; create the database directory and the table if missing. Use the exact table schema from the spec (requirements.md) — do not invent columns.
- Validate titles: must be a string, trimmed, 1–200 chars after trimming; otherwise 400 with the error envelope from the contract.
- Unknown or non-integer ids → 404. `completed` must be a real boolean in JSON; `createdAt` an ISO-8601 UTC string.
- List ordering, filters and the clear-completed endpoint follow api-contract.yaml exactly.

UI
- Use the accessible names, roles and texts from the spec verbatim (labels, button names, `aria-pressed`, `role="alert"`, `role="status"`, the empty state and the counter text).
- On a failed request show the message in the alert region and keep the UI consistent with the server.
- Match the reference design (desktop and mobile); take colours, spacing and typography from design-tokens.md instead of guessing.

Workflow
- Read the spec once, write each file in one go, run `check` once at the end and fix only what it reports.
