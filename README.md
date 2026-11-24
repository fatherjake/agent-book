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
  - **Suggestions** tab: press *Analyse session* and a read-only Claude (Opus) reads the session (and the
    project's files when they're on disk), then writes a task brief (with checks for what done looks like;
    editable) and ranked suggestions for the agent setup: CLAUDE.md instructions, skills, processes and
    scripts, lint rules, hooks, docs, each as exact edits. Press *Run* on a suggestion (1–5 runs per side)
    to evaluate it: the brief is replayed headless (`claude -p`, the session's main model, auto permission
    mode, `git push` blocked, a budget cap per run) in throwaway workspaces, with and without the change,
    and a judge (Sonnet) marks the brief's checks from each run's diff and final message. Results compare
    medians of checks met, cost, tokens, time and tool calls, with differences inside run-to-run noise
    marked ~. Baseline runs are shared by every suggestion.

    Workspaces come from the session, git optional: a git worktree at the commit the session started from
    when its folder is in a repository with history; otherwise a copy of the folder as it is now
    (dependencies and build output left out, up to 300 MB); otherwise, with no folder or one too big to
    copy, an empty folder. Your own files are never modified; workspaces live in
    `~/.agent-book/lab/worktrees` only while a run goes, and the lab's state is in
    `~/.agent-book/lab/<session>.json` (`packages/server/src/lab/`). The lab's own Claude sessions are left
    out of the session list but open by URL.
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

## Dock app (macOS)

`npm run install-app` builds `~/Applications/Agent Book.app` (another folder: `npm run install-app --
<folder>`); drag it to the Dock. Rerun it if you move the repo. The app runs `scripts/launch-mac.sh` from
this checkout: it starts the collector if it isn't running, starts the dashboard if it isn't running
(logging to `~/Library/Logs/agent-book.log`) and opens it in a Chrome window with no tabs or address bar.
A dashboard started this way stops itself about 10 seconds after its last window closes, but waits while
lab runs or chat replies are going; one started with `npm run web` keeps running. The icon,
`scripts/app-icon.png`, is the "Magical Tome" from [Thiings](https://www.thiings.co/things/magical-tome)
(free for personal use; `scripts/app-icon-art.png`) on a dark grey tile, built by `scripts/make-icon.py`
(`python3 scripts/make-icon.py black` for a black tile, then `npm run install-app`).
