#!/usr/bin/env sh
# SessionStart: graphify nachinstallieren, wenn es fehlt.
#
# Claude-Code-Web-Sessions laufen in frischen, kurzlebigen Containern — dort ist
# nach jedem Start nichts installiert. Lokal ist der Hook nach dem ersten
# `command -v` wieder still.
set -eu

if command -v graphify >/dev/null 2>&1 || [ -x "$HOME/.local/bin/graphify" ]; then
  exit 0
fi

if command -v uv >/dev/null 2>&1; then
  timeout 300 uv tool install "graphifyy[sql]" >/dev/null 2>&1 || true
elif command -v pipx >/dev/null 2>&1; then
  timeout 300 pipx install "graphifyy[sql]" >/dev/null 2>&1 || true
fi

exit 0
