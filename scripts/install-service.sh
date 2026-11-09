#!/usr/bin/env bash
# Installs the voice service so it starts at login and restarts if it stops: a launchd agent on macOS
# (scripts/agent-voice.plist), a systemd user service on Linux (scripts/agent-voice.service). It is named after
# SERVICE_LABEL, from the environment or else .env, and local.agent-voice unless set. Run it again to restart the
# service. To change the label of an installed service, stop and remove the one under the old label first (see
# "Keeping it running" in docs/setup.md). Its log goes to data/agent-voice.log.
#
#   scripts/install-service.sh                    install (or reinstall) and start it
#   scripts/install-service.sh --print [launchd|systemd]
#                                                 print the file it would install, and install nothing
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
NODE="${NODE:-node}"

case "$(uname -s)" in
  Darwin) KIND=launchd ;;
  Linux) KIND=systemd ;;
  *) KIND="" ;;
esac
PRINT=""
case "${1:-}" in
  "") ;;
  --print)
    PRINT=yes
    KIND="${2:-$KIND}"
    ;;
  *)
    echo "Usage: $0 [--print [launchd|systemd]]" >&2
    exit 2
    ;;
esac
if [ "$KIND" != launchd ] && [ "$KIND" != systemd ]; then
  echo "This installs the service on macOS (launchd) or Linux (systemd) only. Run npm start instead." >&2
  exit 1
fi

# The last SERVICE_LABEL= line of .env, without quotes or a comment after it.
label_in_env_file() {
  [ -f "$DIR/.env" ] || return 0
  sed -n -e 's/^[[:space:]]*SERVICE_LABEL[[:space:]]*=[[:space:]]*//p' "$DIR/.env" | tail -n 1 |
    sed -e 's/[[:space:]]#.*$//' -e "s/^[\"']//" -e "s/[\"'][[:space:]]*$//" -e 's/[[:space:]]*$//'
}
LABEL="${SERVICE_LABEL:-$(label_in_env_file)}"
LABEL="${LABEL:-local.agent-voice}"
# The label names a file and goes into the templates: letters, digits, dots, hyphens and underscores only.
if ! [[ "$LABEL" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "SERVICE_LABEL \"$LABEL\" may have only letters, digits, dots, hyphens and underscores." >&2
  exit 1
fi

# The paths go into a plist (XML) and a systemd unit. "&", "<", ">" and "%" are escaped for them below; a quote mark,
# a backslash, "$" or a control character (a line break, say) would need escaping that differs from one line of a
# unit to the next, so such a path is refused.
for path in "$DIR" "$NODE"; do
  if [[ "$path" == *[\"\\\$]* ]] || [[ "$path" =~ [[:cntrl:]] ]]; then
    echo "The path \"$path\" can't go into a service file: it has a quote mark, backslash, \"\$\" or control character in it. Move the clone (or node) to a folder without one, or run npm start instead." >&2
    exit 1
  fi
done

# A path as the file holds it: XML-escaped in a plist; in a systemd unit, each "%" doubled, since "%" starts a specifier.
for_file() {
  case "$KIND" in
    launchd) printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' ;;
    systemd) printf '%s' "$1" | sed -e 's/%/%%/g' ;;
  esac
}
# A value as sed's replacement takes it: the delimiter, "&" and backslashes escaped.
for_sed() { printf '%s' "$1" | sed -e 's/[#&\\]/\\&/g'; }
fill() {
  sed -e "s#__LABEL__#$(for_sed "$LABEL")#g" -e "s#__DIR__#$(for_sed "$(for_file "$DIR")")#g" \
    -e "s#__NODE__#$(for_sed "$(for_file "$NODE")")#g" "$1"
}

# The folder as launchd or systemd will read it back from the file.
read_back() {
  case "$KIND" in
    launchd)
      sed -n 's#^[[:space:]]*<key>WorkingDirectory</key><string>\(.*\)</string>[[:space:]]*$#\1#p' "$1" |
        sed -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&quot;/"/g' -e "s/&apos;/'/g" -e 's/&amp;/\&/g'
      ;;
    systemd) sed -n 's/^WorkingDirectory=//p' "$1" | sed -e 's/%%/%/g' ;;
  esac
}

# Fills the template into a file next to where it goes, and checks it: a plist must be valid (plutil -lint on macOS,
# else xmllint if there is one), and either must give back this folder as launchd or systemd will read it. A file
# that doesn't is never installed: the script stops, and says why.
TEMPLATE="$DIR/scripts/agent-voice.$([ "$KIND" = launchd ] && echo plist || echo service)"
WHAT="The $KIND $([ "$KIND" = launchd ] && echo plist || echo unit) made from scripts/$(basename "$TEMPLATE")"
STAGED="$(mktemp "${TMPDIR:-/tmp}/agent-voice-service.XXXXXX")"
trap 'rm -f "$STAGED"' EXIT
fill "$TEMPLATE" > "$STAGED"
if [ "$KIND" = launchd ]; then
  if command -v plutil >/dev/null; then
    plutil -lint -s "$STAGED" >&2 || { echo "$WHAT is not valid (plutil -lint), so nothing was installed." >&2; exit 1; }
  elif command -v xmllint >/dev/null; then
    xmllint --noout "$STAGED" || { echo "$WHAT is not valid XML (xmllint), so nothing was installed." >&2; exit 1; }
  fi
fi
if [ "$(read_back "$STAGED")" != "$DIR" ]; then
  echo "$WHAT doesn't give back this folder ($DIR) as $KIND will read it, so nothing was installed." >&2
  exit 1
fi

if [ -n "$PRINT" ]; then
  cat "$STAGED"
  exit 0
fi

# Another service already installed for this folder under another label would fight this one over the port: say so.
warn_other() {
  local here
  here="$(for_file "$DIR")"
  for other in "$@"; do
    [ -f "$other" ] || continue
    if grep -qF "$here" "$other"; then
      echo "Warning: $other also runs the voice service from $DIR. Stop and remove it (see \"Keeping it running\" in docs/setup.md), or the two fight over the port." >&2
    fi
  done
}

mkdir -p "$DIR/data"
chmod 700 "$DIR/data"
LOG="$DIR/data/agent-voice.log"

case "$KIND" in
  launchd)
    AGENTS="$HOME/Library/LaunchAgents"
    TARGET="$AGENTS/$LABEL.plist"
    mkdir -p "$AGENTS"
    for other in "$AGENTS"/*.plist; do [ "$other" = "$TARGET" ] || warn_other "$other"; done
    cp "$STAGED" "$TARGET"
    launchctl unload "$TARGET" 2>/dev/null || true
    launchctl load "$TARGET"
    if ! launchctl list "$LABEL" >/dev/null 2>&1; then
      echo "launchd did not take $TARGET: the service is not running. See $LOG." >&2
      exit 1
    fi
    echo "The meeting assistant's voice service is installed and loaded as the launchd agent $LABEL. Logs: $LOG"
    echo "To confirm it started (a missing setting stops it at once): tail -n 20 $LOG, and the details on its control socket (the line the log shows when it starts: curl --unix-socket ...)"
    echo "To stop it: launchctl unload $TARGET"
    ;;
  systemd)
    if ! command -v systemctl >/dev/null; then
      echo "systemctl was not found: on Linux this installs a systemd user service. Run npm start instead." >&2
      exit 1
    fi
    UNITS="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    TARGET="$UNITS/$LABEL.service"
    mkdir -p "$UNITS"
    for other in "$UNITS"/*.service; do [ "$other" = "$TARGET" ] || warn_other "$other"; done
    cp "$STAGED" "$TARGET"
    systemctl --user daemon-reload
    systemctl --user enable "$LABEL.service"
    systemctl --user restart "$LABEL.service"
    if ! systemctl --user is-active --quiet "$LABEL.service"; then
      echo "The service $LABEL did not start. See $LOG, and: systemctl --user status $LABEL" >&2
      exit 1
    fi
    echo "The meeting assistant's voice service is installed and loaded as the systemd user service $LABEL. Logs: $LOG"
    echo "To confirm it started (a missing setting stops it at once): tail -n 20 $LOG, and the details on its control socket (the line the log shows when it starts: curl --unix-socket ...)"
    echo "To stop it: systemctl --user stop $LABEL"
    echo "To keep it running while you are logged out: loginctl enable-linger ${USER:-$(id -un)}"
    ;;
esac
