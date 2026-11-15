---
name: fullstack-checklist
description: Final verification checklist for the full-stack todo app (build, API contract, accessibility, design). Use it before finishing the task.
---

Before finishing, check each item:

- `npm run build` succeeds from a clean state, and `npm start` starts a single Node process that serves `/api/*` and the built frontend (with an SPA fallback to index.html for non-API GET routes).
- The server honours `PORT` and `DATABASE_PATH`, creates the database directory and table if missing, and parses JSON bodies.
- Every API response matches the contract: status codes, JSON shapes, the error envelope, validation rules (trimming, length limits, types), 404 for unknown or non-integer ids, and the ordering rules.
- `completed` is returned as a boolean and `createdAt` as an ISO-8601 UTC string.
- The UI uses the exact accessible names, roles and texts from the spec (labels, button names, `aria-pressed`, `role="alert"`, `role="status"`, empty state, counter text).
- Failed requests show an error in the alert element and leave the UI consistent with the server; the app stays usable afterwards.
- The layout matches the reference design at desktop and mobile widths.
