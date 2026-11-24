#!/bin/sh
# Set up Agent Book on this machine:
#   1. install dependencies (if needed)
#   2. add a SessionStart hook to ~/.claude/settings.json that starts the collector when it isn't
#      running and records each session's context (packages/server/hook.sh)
#   3. start the collector now
#
# Safe to re-run: it replaces its own hook entry and leaves every other hook alone. The settings file
# is backed up first. Set CLAUDE_SETTINGS to target a different settings file.
set -eu

ROOT=$(cd "$(dirname "$0")" && pwd)
HOOK="$ROOT/packages/server/hook.sh"
SETTINGS=${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}
NODE=$(command -v node) || { echo "init: node not found on PATH" >&2; exit 1; }

if [ ! -x "$ROOT/node_modules/.bin/tsx" ]; then
  echo "init: installing dependencies"
  npm --prefix "$ROOT" install --silent
fi
chmod +x "$HOOK"

# The hook runs with Claude Code's environment, which may not have nvm's node on PATH, so the
# absolute node path is baked into the command.
CMD="AGENT_BOOK_NODE='$NODE' '$HOOK'"

mkdir -p "$(dirname "$SETTINGS")"
if [ -f "$SETTINGS" ]; then
  BACKUP="$SETTINGS.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$SETTINGS" "$BACKUP"
  echo "init: backed up $SETTINGS to $BACKUP"
fi

"$NODE" - "$SETTINGS" "$CMD" <<'EOF'
const fs = require('node:fs');
const [file, cmd] = process.argv.slice(2);
const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
settings.hooks ??= {};
const mine = (h) => typeof h.command === 'string' && h.command.includes('packages/server/hook.sh');
// Drop any earlier entry of ours (e.g. from another checkout path), keep everything else.
const groups = (settings.hooks.SessionStart ?? [])
  .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !mine(h)) }))
  .filter((g) => g.hooks.length > 0);
groups.push({ hooks: [{ type: 'command', command: cmd }] });
settings.hooks.SessionStart = groups;
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
EOF
echo "init: SessionStart hook → $HOOK"

echo '{}' | "$HOOK"
PORT=${AGENT_BOOK_COLLECTOR_PORT:-4318}
if curl -fsS -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "init: collector running on http://127.0.0.1:$PORT (log: ~/.agent-book/collector.log)"
else
  echo "init: collector did not start; see ~/.agent-book/collector.log" >&2
  exit 1
fi
