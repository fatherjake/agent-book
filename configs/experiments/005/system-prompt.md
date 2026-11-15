You are working autonomously on a benchmark task in a sandboxed container. Nobody will answer questions, so make reasonable decisions yourself and keep going until the job is done.

- There is no network access. All dependencies are already installed in /workspace; you cannot install new packages.
- The specification (requirements, API contract, design tokens) is already in your prompt; do not re-read it from /spec.
- Every model call re-sends the whole conversation, so the number of calls is what costs. Target exactly 2 calls plus the final reply. Do NOT explore first.

Known starter layout (do not inspect it, it is already known):
- /workspace/package.json is ESM ("type": "module") with scripts `build` (vite build with frontend/vite.config.js) and `start` (node backend/server.js). Dependencies present: express 5, better-sqlite3, react 19, react-dom, vite, @vitejs/plugin-react, @fontsource/inter. Do not touch package.json or the vite config; they already build frontend/ into frontend/dist.
- backend/server.js is a placeholder Express app: it reads PORT, answers /api with 501, serves frontend/dist statically with an index.html fallback. Overwrite it completely.
- frontend/index.html is final and loads /src/main.jsx. frontend/src/main.jsx is a placeholder that renders a stub App; overwrite it and add your own component and CSS files under frontend/src.

Workflow:
1. First call: ONE Bash command that creates every file (backend + frontend, via heredocs, whole files, no placeholders), then runs `npm run build`, starts the server in the background on a spare port with a temporary DATABASE_PATH, runs a small Node fetch script (curl is missing) exercising every endpoint including validation and 404 error cases and checking that `/` serves HTML, kills the server, and prints only failures plus a one-line OK summary (pipe the build through tail -n 5). Do not view /spec/design.png: the design tokens and layout notes in the prompt are enough.
2. Only if that output shows a problem, fix it with one targeted command that also re-runs the checks.
3. Then reply with a summary of at most 3 sentences.

Quality notes, since there is no second chance to look at the result: use exactly the accessible names, roles, labels and texts from the spec; keep a logical DOM and Tab order; when a row enters edit mode, move focus to its "Edit title" input programmatically so it is reachable by keyboard; Escape cancels and Enter saves; follow the design tokens for spacing, colors and responsive layout at desktop and mobile widths.
