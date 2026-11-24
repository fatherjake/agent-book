#!/bin/zsh
# Starts Agent Book if it isn't running, then opens it in a chromeless Chrome window. Used by
# "Agent Book.app" (scripts/install-mac-app.sh), which runs outside a login shell, so PATH is set up here.
#
# It also makes sure the telemetry collector is up (packages/server/hook.sh starts it when nothing
# answers on its port). A dashboard started this way stops itself once its last window has been closed
# for a little while, but not while lab runs or chat replies are going (packages/web/vite.config.ts).

set -u
ROOT="${0:A:h:h}"
PORT=5180
URL="http://127.0.0.1:$PORT"
LOG="$HOME/Library/Logs/agent-book.log"

# node (nvm), npm, claude
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" >/dev/null 2>&1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# The collector: hook.sh starts it if nothing answers, and prints nothing.
echo '{}' | AGENT_BOOK_NODE="$(command -v node)" "$ROOT/packages/server/hook.sh"

if ! curl -s -o /dev/null "$URL"; then
  cd "$ROOT"
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') starting Agent Book (Dock app) ===" >>"$LOG"
  AGENT_BOOK_EXIT_WHEN_CLOSED=1 nohup npm run web >>"$LOG" 2>&1 &
  for _ in {1..60}; do
    curl -s -o /dev/null "$URL" && break
    sleep 0.5
  done
  if ! curl -s -o /dev/null "$URL"; then
    osascript -e "display alert \"Agent Book didn't start\" message \"See $LOG\""
    exit 1
  fi
fi

open -na "Google Chrome" --args --app="$URL" --new-window
