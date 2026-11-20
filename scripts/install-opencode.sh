#!/usr/bin/env bash
# Sets up this folder for OpenCode. The committed opencode.json already registers the zoom-meeting channel, its
# prompts, the files no session here may read (policies) and what the meeting-assistant may do; this script writes your
# own, gitignored .opencode/opencode.json, which OpenCode reads after it:
# - the channel's command as absolute paths into this folder, so it starts whichever folder OpenCode is opened in;
# - with --source DIR (any number of times), the folders outside this one the meeting-assistant may read: your
#   profile's knowledge sources. Without --source, the folders already there are kept; --no-sources removes them.
# Everything else in that file is left as it is. It checks that OpenCode is V2, 2.3.2 or later.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
NEED=2.3.2

sources=()
clear_sources=0
while [ $# -gt 0 ]; do
  case "$1" in
    --source)
      [ $# -ge 2 ] || { echo "--source takes a folder." >&2; exit 2; }
      sources+=("$2")
      shift 2
      ;;
    --no-sources)
      clear_sources=1
      shift
      ;;
    -h | --help)
      echo "Usage: scripts/install-opencode.sh [--source DIR]... [--no-sources]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1 (see --help)." >&2
      exit 2
      ;;
  esac
done

if ! command -v opencode >/dev/null 2>&1; then
  echo "OpenCode is not installed (no opencode command). Install OpenCode $NEED or later: npm install -g @opencode/cli" >&2
  exit 1
fi
version="$(opencode --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)"
if [ -z "$version" ]; then
  echo "Could not tell which OpenCode this is (opencode --version gave no version). AgentVoice needs OpenCode $NEED or later." >&2
  exit 1
fi
IFS=. read -r major minor patch <<<"$version"
if [ "$major" -lt 2 ]; then
  echo "OpenCode $version is V1 (npm opencode-ai), which AgentVoice doesn't support: its tool calls time out after 60 seconds." >&2
  echo "Install V2 instead: npm install -g @opencode/cli" >&2
  exit 1
fi
if [ "$major" -eq 2 ] && { [ "$minor" -lt 3 ] || { [ "$minor" -eq 3 ] && [ "$patch" -lt 2 ]; }; }; then
  echo "OpenCode $version is older than $NEED, the earliest AgentVoice supports: update it (npm install -g @opencode/cli)." >&2
  exit 1
fi
if [ "$major" -gt 2 ]; then
  echo "Note: OpenCode $version is newer than AgentVoice was tested with ($NEED). If something fails, tell us."
fi
if [ ! -x "$DIR/node_modules/.bin/tsx" ]; then
  echo "Run npm install in $DIR first: the channel runs with its tsx." >&2
  exit 1
fi

mkdir -p .opencode
# Node writes the file, so paths with any characters in them come out as valid JSON.
node --input-type=module - "$DIR" "$clear_sources" ${sources[@]+"${sources[@]}"} <<'EOF'
import fs from 'node:fs'
import path from 'node:path'
const [dir, clear, ...given] = process.argv.slice(2)
const file = path.join(dir, '.opencode', 'opencode.json')
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
let mine = {}
if (fs.existsSync(file)) {
  try {
    mine = read(file)
  } catch {
    console.error(`${file} is not plain JSON (it may have comments): fix or remove it, then run this again.`)
    process.exit(1)
  }
  if (typeof mine !== 'object' || mine === null || Array.isArray(mine)) {
    console.error(`${file} is not a JSON object: fix or remove it, then run this again.`)
    process.exit(1)
  }
}
// The same server as the committed opencode.json, with absolute paths. This file's entry replaces that one whole, so
// it carries everything else the committed entry has.
const committed = read(path.join(dir, 'opencode.json')).mcp.servers['zoom-meeting']
const server = { ...committed, command: committed.command.map((part) => path.resolve(dir, part)) }
mine.$schema ??= 'https://opencode.ai/config.json'
mine.mcp = { ...mine.mcp, servers: { ...mine.mcp?.servers, 'zoom-meeting': server } }

// The meeting-assistant's reading outside this folder: OpenCode asks external_directory first, which the committed
// rules deny. Rules here come after those, so these allow it, for these folders only; the policies still hold.
const outside = (rule) => rule?.action === 'external_directory' && rule?.effect === 'allow'
const folders = []
for (const source of given) {
  const expanded = source === '~' ? process.env.HOME : source.startsWith('~/') ? path.join(process.env.HOME ?? '', source.slice(2)) : source
  const absolute = path.resolve(expanded)
  let real
  try {
    real = fs.realpathSync(absolute)
  } catch {
    console.error(`${source} is not a folder this script can find.`)
    process.exit(1)
  }
  if (!fs.statSync(real).isDirectory()) {
    console.error(`${source} is not a folder: give the folder a source is in.`)
    process.exit(1)
  }
  if (real === path.parse(real).root || real === process.env.HOME) {
    console.error(`${source} is your whole disk or home folder: give the folders your sources are in.`)
    process.exit(1)
  }
  folders.push(real)
}
if (given.length || clear === '1') {
  const agent = mine.agents?.['meeting-assistant'] ?? {}
  const kept = (agent.permissions ?? []).filter((rule) => !outside(rule))
  const added = folders.map((folder) => ({ action: 'external_directory', resource: `${folder.replaceAll('\\', '/')}/*`, effect: 'allow' }))
  mine.agents = { ...mine.agents, 'meeting-assistant': { ...agent, permissions: [...kept, ...added] } }
  if (!mine.agents['meeting-assistant'].permissions.length) delete mine.agents['meeting-assistant'].permissions
  if (!Object.keys(mine.agents['meeting-assistant']).length) delete mine.agents['meeting-assistant']
  if (!Object.keys(mine.agents).length) delete mine.agents
}
const temp = `${file}.${process.pid}.tmp`
fs.writeFileSync(temp, `${JSON.stringify(mine, null, 2)}\n`)
fs.renameSync(temp, file)
const now = (mine.agents?.['meeting-assistant']?.permissions ?? []).filter(outside).map((rule) => rule.resource.replace(/\/\*$/, ''))
console.log(`Wrote ${file}.`)
console.log(now.length ? `The meeting-assistant may read these folders outside this one:\n${now.map((f) => `  ${f}`).join('\n')}` : 'The meeting-assistant reads only inside this folder (add yours with --source DIR).')
EOF

echo
echo "Done (OpenCode $version). Start OpenCode in $DIR:"
echo "  cd \"$DIR\" && opencode"
echo "Change opencode.json or .opencode/ only between meetings: OpenCode restarts the channel when its config changes."
