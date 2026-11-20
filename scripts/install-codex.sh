#!/usr/bin/env bash
# Checks that this folder is ready for Codex, and says how to start it. The committed .codex/config.toml registers the
# zoom-meeting channel (pull only), which of its tools ask first and the files no command here may read (a permission
# profile); .codex/agents/meeting-assistant.toml is the agent that takes a meeting's questions. Codex reads them only
# once you trust this folder, in a session started at its root. This script writes nothing: Codex itself saves your
# trust, in ~/.codex/config.toml (or $CODEX_HOME's). Run it again after trusting the folder to check that Codex loads its config.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$DIR"
TESTED=0.171.0
USER_CONFIG="${CODEX_HOME:-~/.codex}/config.toml"

case "${1:-}" in
  "") ;;
  -h | --help)
    echo "Usage: scripts/install-codex.sh"
    exit 0
    ;;
  *)
    echo "Unknown option: $1 (see --help)." >&2
    exit 2
    ;;
esac

if ! command -v codex >/dev/null 2>&1; then
  echo "Codex is not installed (no codex command). Install Codex $TESTED or later: npm install -g @openai/codex" >&2
  exit 1
fi
version="$(codex --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)"
if [ -z "$version" ]; then
  echo "Could not tell which Codex this is (codex --version gave no version). AgentVoice needs Codex $TESTED or later." >&2
  exit 1
fi
IFS=. read -r major minor patch <<<"$version"
IFS=. read -r need_major need_minor need_patch <<<"$TESTED"
if [ "$major" -lt "$need_major" ] || { [ "$major" -eq "$need_major" ] && { [ "$minor" -lt "$need_minor" ] || { [ "$minor" -eq "$need_minor" ] && [ "$patch" -lt "$need_patch" ]; }; }; }; then
  echo "Codex $version is older than $TESTED, the earliest AgentVoice supports: update it (npm install -g @openai/codex)." >&2
  exit 1
fi
if [ "$version" != "$TESTED" ]; then
  echo "Note: Codex $version is newer than AgentVoice was tested with ($TESTED). If something fails, tell us."
fi
if [ ! -x "$DIR/node_modules/.bin/tsx" ]; then
  echo "Run npm install in $DIR first: the channel runs with its tsx." >&2
  exit 1
fi

# What Codex makes of its config here, without a key and without starting anything: `codex mcp list` loads every
# layer, this folder's too once it is trusted, and fails on a setting it can't take.
servers() {
  local out
  if ! out="$(cd "$1" && codex mcp list --json 2>&1 </dev/null)"; then
    echo "Codex can't load its config (run from $1):" >&2
    printf '%s\n' "$out" | grep -v '^WARNING: ' | sed -n '1,/^Stack backtrace/p' | grep -v '^Stack backtrace' >&2
    exit 1
  fi
  printf '%s\n' "$out" | grep -v '^WARNING: ' | node --input-type=module -e '
    let text = ""
    process.stdin.on("data", (chunk) => (text += chunk))
    process.stdin.on("end", () => {
      const server = JSON.parse(text).find((entry) => entry.name === "zoom-meeting")
      if (!server) return console.log("none")
      const ours = server.transport?.command === "node_modules/.bin/tsx" && server.transport?.env?.AGENTVOICE_CLIENT === "codex"
      console.log(ours ? "ours" : "other")
    })'
}

# A zoom-meeting in your own config would start the channel in every project.
elsewhere="$(mktemp -d)"
trap 'rm -rf "$elsewhere"' EXIT
if [ "$(servers "$elsewhere")" != "none" ]; then
  echo "Your own Codex config ($USER_CONFIG) registers a zoom-meeting server for every project, perhaps with codex mcp add."
  echo "Remove it, as this folder's config registers the channel for this folder only:"
  echo "  codex mcp remove zoom-meeting"
  echo
fi

here="$(servers "$DIR")"
echo "Codex $version is ready to use here. Start it at the root of this folder (the channel's command is a path from it):"
echo "  cd \"$DIR\" && codex"
if [ "$here" = "ours" ]; then
  echo "Codex trusts this folder and loads its config: the zoom-meeting channel, the meeting-assistant and the floor."
else
  echo "Codex doesn't load this folder's config yet: it reads .codex/ only in a folder you trust. The first time you start"
  echo "Codex here it asks whether you trust the folder: choose \"Trust and continue\". If you once chose not to, set"
  echo "  [projects.\"$DIR\"]"
  echo "  trust_level = \"trusted\""
  echo "in $USER_CONFIG. Then run this script again to check."
fi
echo "Don't start Codex here with --sandbox (-s) or --dangerously-bypass-approvals-and-sandbox: either replaces the floor."
