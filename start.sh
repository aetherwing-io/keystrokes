#!/bin/sh
# keystrokes — start the session soundtrack.
# Sets up the python venv on first run, starts the hub server and the key tap,
# and opens the engine page. Ctrl-C stops everything.
set -e
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "first run: creating python venv…"
  python3 -m venv .venv
fi
if ! .venv/bin/python -c 'import pynput' 2>/dev/null; then
  echo "installing pynput into the venv…"
  .venv/bin/pip install --quiet pynput
fi

node server.mjs &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT INT TERM

sleep 0.6
URL="http://localhost:${KEYSTROKES_PORT:-8123}"
if command -v open >/dev/null 2>&1; then open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 &
else echo "open $URL in your browser"; fi

echo
echo "engine page opened — click 'Start the tape' there, then come back to work."
echo
.venv/bin/python tap.py
