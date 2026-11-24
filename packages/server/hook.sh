#!/bin/sh
# Claude Code SessionStart hook (installed by init.sh).
#
# Starts the collector if nothing answers on its port, then posts the hook's stdin JSON (session id,
# working directory, transcript path) to /hook, since OpenTelemetry doesn't carry those. It also sends
# the id of the session that launched this one, if any (see PARENT below).
#
# It must never get in the way of a session: it prints nothing (SessionStart stdout is added to the
# session's context), sends the collector's output to ~/.agent-book/collector.log, and always exits 0.

DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$DIR/../.." && pwd)
PORT=${AGENT_BOOK_COLLECTOR_PORT:-4318}
URL="http://127.0.0.1:$PORT"
STATE="$HOME/.agent-book"
NODE=${AGENT_BOOK_NODE:-node}

input=$(cat)
mkdir -p "$STATE"

up() { curl -fsS -m 1 "$URL/health" >/dev/null 2>&1; }

if ! up; then
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') starting collector (SessionStart hook) ===" >>"$STATE/collector.log"
  # Detached from the hook: own stdin/stdout, so Claude Code doesn't wait on it. If two sessions start
  # at once, the second server fails to bind the port and exits; the first one serves both.
  (cd "$DIR" && nohup "$NODE" "$ROOT/node_modules/tsx/dist/cli.mjs" src/index.ts </dev/null >>"$STATE/collector.log" 2>&1 &)
  i=0
  while [ $i -lt 50 ] && ! up; do
    sleep 0.1
    i=$((i + 1))
  done
fi

# A session started from another one (`claude -p` from its Bash tool, or from a script it ran) inherits
# that session's CLAUDE_CODE_SESSION_ID. Claude Code gives the hook its own id instead, but the inherited
# one is still in the environment the Claude Code process (CLAUDE_PID) started with. The collector
# ignores it when it equals the session's own id.
PARENT=
if [ -n "${CLAUDE_PID:-}" ]; then
  PARENT=$(ps eww -o command= -p "$CLAUDE_PID" 2>/dev/null | tr ' ' '\n' | sed -n 's/^CLAUDE_CODE_SESSION_ID=//p' | head -n 1)
fi

case "$input" in
  *session_id*) printf '%s' "$input" | curl -fsS -m 2 -H 'content-type: application/json' -H "x-agent-book-parent: $PARENT" --data-binary @- "$URL/hook" >/dev/null 2>&1 ;;
esac
exit 0
