You are working in an existing codebase: **tiny**, a small perpetual-futures exchange (a Python
validator cluster and sim with a FastAPI/WebSocket API in `core/` and `sim/`, and a React +
TypeScript trading UI in `ui/`), checked out at `/workspace`. It is a git repository; commit
nothing, your working-tree changes are what gets evaluated.

Add a **depth chart** to the trading UI: a new "Depth" tab in the order book card that plots the
cumulative bid and ask liquidity of the selected market around the mid price, with a hover tooltip
that reads out the depth at any price.

The full specification (where the tab goes, how the axes are defined, which level the tooltip shows
and the exact texts and accessible names) is in `/spec/feature.md`, and `/spec/depth.png` shows the
finished card (resting on the left, hovering on the right). Read the spec first; it is the contract
your work is checked against.

Environment notes:

* There is no network access, so you can't install new npm or Python packages; use what is already
  installed (`ui/node_modules`, and the Python environment in `.venv`).
* In `ui/`: `npm run build` type-checks and builds, `npm test` runs the vitest unit tests,
  `npx prettier --check .` checks formatting. Python tests: `.venv/bin/python -m pytest -q`.
* `/opt/frugal/task/app start` starts the sim (validators, market-making bots and the API on
  port 8000), builds the UI and serves it at `http://127.0.0.1:3000` with the API proxied
  (`app status`, `app stop`, `app logs`; logs are in `/tmp/frugal-app/`).
* `/opt/frugal/task/pw-node <script.js>` runs a Node.js script in which `require('playwright')`
  and a headless Chromium are available.
* Follow the conventions of the surrounding code (`Book.tsx` and the helpers in `ui/src/lib/` are a
  good guide). Add unit tests for any logic you add.
* When you are done, `npm run build` must succeed and the existing UI and Python tests must keep
  passing.
