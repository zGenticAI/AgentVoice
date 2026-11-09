#!/usr/bin/env bash
# Registers the zoom-meeting channel with Claude Code for this folder only (local scope), so only a session started
# here loads it: the meeting tools stay with this folder's agent and its .claude/settings.json deny rules.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
# An earlier version of this script registered the channel for every project (user scope): take that one away.
if claude mcp remove --scope user zoom-meeting >/dev/null 2>&1; then
  echo "Removed the zoom-meeting channel an earlier install registered for all your projects."
fi
claude mcp add --scope local zoom-meeting -- "$DIR/node_modules/.bin/tsx" "$DIR/src/channel/server.ts"
echo
echo "Done. To link a session to the meeting assistant, start it in $DIR with:"
echo "  claude --dangerously-load-development-channels server:zoom-meeting"
echo "or resume your existing one there:"
echo "  claude --resume --dangerously-load-development-channels server:zoom-meeting"
