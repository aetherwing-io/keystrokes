#!/bin/sh
# keystrokes — one-command install for the session soundtrack.
#
#   curl -fsSL https://raw.githubusercontent.com/aetherwing-io/keystrokes/main/install.sh | sh
#
# Clones (or updates) the repo, then starts the hub + key tap so your typing —
# and the characters your Claude Code / Codex sessions generate — become music.
# Nothing is uploaded; keys become notes and are discarded. Ctrl-C stops it all.
set -eu

REPO="https://github.com/aetherwing-io/keystrokes.git"
DIR="${KEYSTROKES_HOME:-$HOME/keystrokes}"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "keystrokes needs '$1' on your PATH — $2" >&2; exit 1; }
}
need git     "install it and re-run."
need node    "install Node (https://nodejs.org) and re-run."
need python3 "install Python 3 and re-run."

if [ -d "$DIR/.git" ]; then
  echo "→ updating keystrokes in $DIR"
  git -C "$DIR" pull --ff-only
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  echo "$DIR already exists and isn't a keystrokes checkout." >&2
  echo "Move it aside, or set KEYSTROKES_HOME to another path, then re-run." >&2
  exit 1
else
  echo "→ cloning keystrokes into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi

echo "→ starting the tape — grant Accessibility if macOS asks, then go work"
cd "$DIR"
exec ./start.sh
