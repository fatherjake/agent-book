# Agent Book

npm workspaces under `packages/`:

- `packages/server`: OTLP/HTTP (JSON) collector for Claude Code telemetry. `npm run server`
  (127.0.0.1:4318; `POST /v1/logs|traces|metrics`, `POST /hook`, `GET /health`), stored in
  `~/.agent-book/telemetry.db`.
- `packages/web`: the dashboard. `npm run web` (127.0.0.1:5180). A full-height terminal layout; every
  divider can be dragged (double-click resets it):
  - **Sidebar:** every session, newest first, with cost and folder. Headless sessions (`claude -p`, the
    Agent SDK) are nested under the session that launched them: exactly when the hook recorded it, else
    by a session id in their folder path, else by timing (marked as a guess).
  - **Info panel:** what the open session was, and its headline numbers.
  - **Tabs** (keys 1–3) beside a **detail panel** for the selected row (the first turn until you pick
    another): the conversation turn by turn; launched sessions; usage (working time and tokens, then every
    turn sortable by time, tokens or cost). Claude's replies are
    rendered as GitHub-flavoured Markdown. The view is in the URL (`#/session/<id>/<tab>/<kind>:<key>`).
  - **Chat** along the bottom, built like CV Hub's: one Claude Code session per session page, started
    with the page's content as its system context (`packages/server/src/context.ts`); each message carries
    the tab and selected row. It is read-only (Read, Grep, Glob and `sqlite3` only). State lives in
    `~/.agent-book/chats/`; continue a chat with `claude --resume <id>`. These chat sessions are left out
    of the session list.

  Vite serves a read-only API from the telemetry store, so nothing else needs to run besides the
  collector: `GET /api/sessions` (`packages/server/src/sessions.ts`), `GET /api/sessions/:id` and
  `GET /api/tool-output/:toolUseId` (`packages/server/src/session-detail.ts`), and `/api/chat`
  (`packages/server/src/chat.ts`).

## Setup

`./init.sh` installs dependencies, adds a SessionStart hook to `~/.claude/settings.json` and starts the
collector. The hook (`packages/server/hook.sh`) starts the collector whenever a session opens and it
isn't running, then records the session's working directory and transcript path. Collector output goes
to `~/.agent-book/collector.log`. Re-running `init.sh` is safe.
