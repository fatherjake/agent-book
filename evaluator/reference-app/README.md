# Reference implementation (HIDDEN)

Known-good implementation of `benchmark/spec/requirements.md`, built on the starter
(`benchmark/starter`: same package.json, lockfile and layout). It is used to:

* validate the evaluator's deterministic tests, browser scenarios and visual comparison, and
* generate the frozen reference images (`scripts/generate-design.ts`).

Never copy this directory, or anything derived from it, into a coding-agent container.

## Run it in the benchmark image

Copy this directory over `/workspace` in a container started from `frugal-bench:<starterHash>`,
keeping the image's `node_modules`, then build and start it:

```sh
npm run build && npm start      # PORT=3000, DATABASE_PATH=./data/todos.db by default
```

Copy the files as user `node` (for example by piping a tar stream into
`docker exec -i -u node <ctr> tar -x -C /workspace`). Plain `docker cp` creates root-owned files,
and then `npm run build` can't write `frontend/dist`. `benchmark/docker/app-container.ts`
(`startAppContainer`) does all of this and waits until `GET /api/todos` returns 200.

## Layout

* `backend/server.js`: Express app: `/api/todos` routes, validation, error mapping, static frontend.
* `backend/db.js`: better-sqlite3 schema and queries (exact table from the spec).
* `frontend/src/App.jsx`: UI. Updates are pessimistic: state changes only after the server confirms.
* `frontend/src/api.js`: fetch wrapper. Maps network, non-JSON and error responses to messages.
* `frontend/src/styles.css`: implements `benchmark/spec/design-tokens.md`.
