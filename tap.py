#!/usr/bin/env python3
"""keystrokes tap — forwards your keys, as they happen, to the music engine.

Every keystroke becomes one UDP datagram to 127.0.0.1:8124 and is immediately
forgotten. Nothing is written to disk, nothing leaves this machine.
Keyboard-shortcut chords (cmd/ctrl held) are skipped entirely.

macOS notes:
- Requires the Accessibility permission for whatever app runs this script
  (your terminal). System Settings -> Privacy & Security -> Accessibility.
- macOS blocks event taps during secure input, so password fields are
  automatically silent. Still: this is a keylogger-shaped tool. Only run it
  on your own machine, and remember the key->note mapping is invertible.
"""
import json
import socket
import sys

try:
    from pynput import keyboard
except ImportError:
    sys.exit("pynput is not installed — run ./start.sh, which sets up the venv for you.")

ADDR = ("127.0.0.1", 8124)
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

CHORD_MODS = {
    keyboard.Key.cmd, keyboard.Key.cmd_r,
    keyboard.Key.ctrl, keyboard.Key.ctrl_r,
}
SPECIAL = {
    keyboard.Key.space: " ",
    keyboard.Key.enter: "\n",
    keyboard.Key.backspace: "\b",
    keyboard.Key.tab: "\t",
}
held = set()


def send(ch: str) -> None:
    try:
        sock.sendto(json.dumps({"ch": ch}).encode("utf-8"), ADDR)
    except OSError:
        pass  # engine not up yet; keys just don't play


def on_press(key):
    if key in CHORD_MODS:
        held.add(key)
        return
    if held:  # cmd/ctrl chord (shortcuts) — not typing, not music
        return
    if key in SPECIAL:
        send(SPECIAL[key])
        return
    ch = getattr(key, "char", None)
    if ch:
        send(ch)


def on_release(key):
    held.discard(key)


if __name__ == "__main__":
    print("keystrokes tap: forwarding keys to udp://127.0.0.1:8124 (ctrl-c to stop)")
    print("if no notes play while typing in other apps, grant your terminal the")
    print("Accessibility permission: System Settings -> Privacy & Security -> Accessibility")
    with keyboard.Listener(on_press=on_press, on_release=on_release) as listener:
        try:
            listener.join()
        except KeyboardInterrupt:
            pass
