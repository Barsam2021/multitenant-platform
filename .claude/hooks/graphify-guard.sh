#!/usr/bin/env sh
# PreToolUse-Wachhund von graphify: erinnert den Agenten daran, erst den
# Wissensgraphen zu fragen, bevor er sich durch Dateien liest.
#
# Absichtlich zahnlos, wenn graphify nicht installiert ist: der Hook laeuft bei
# jedem Bash/Grep/Read/Glob-Aufruf, und ein fehlendes Binary darf niemandem die
# Werkzeuge blockieren. Deshalb Exit 0 statt Fehler.
set -eu

MODE="${1:-read}"

for candidate in graphify "$HOME/.local/bin/graphify" /root/.local/bin/graphify; do
  if command -v "$candidate" >/dev/null 2>&1; then
    exec "$candidate" hook-guard "$MODE"
  fi
done

exit 0
