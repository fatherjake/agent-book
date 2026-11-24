# Agent Book

npm workspaces under `packages/`:

- `packages/server`: OTLP/HTTP (JSON) collector for Claude Code telemetry. `npm run server`
  (127.0.0.1:4318; `POST /v1/logs|traces|metrics`, `POST /hook`, `GET /health`), stored in
  `~/.agent-book/telemetry.db`.
- `packages/web`: the dashboard. `npm run web` (127.0.0.1:5180).

## Setup

`./init.sh` installs dependencies, adds a SessionStart hook to `~/.claude/settings.json` and starts the
collector. The hook (`packages/server/hook.sh`) starts the collector whenever a session opens and it
isn't running, then records the session's working directory and transcript path. Collector output goes
to `~/.agent-book/collector.log`. Re-running `init.sh` is safe.
