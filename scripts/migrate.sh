#!/bin/bash
# migrate.sh — Migrationen gegen eine LAUFENDE Installation nachfahren.
#
# Noetig, weil docker-entrypoint-initdb.d ausschliesslich bei leerem Volume laeuft.
# Bestehende Server bekommen neue Migrationen sonst nie. Alle Skripte sind
# idempotent, mehrfaches Ausfuehren ist gefahrlos.
set -euo pipefail
ROOT="/opt/multitenant-platform"
INIT="$ROOT/core-postgres/init-scripts"

echo "Migrationen gegen laufende Installation:"
for f in $(find "$INIT" -maxdepth 1 -name '*.sql' | sort); do
  echo "  -> $(basename "$f")"
  docker exec -i core-postgres psql -U postgres -v ON_ERROR_STOP=1 -q < "$f" \
    || { echo "     FEHLER in $(basename "$f") — Abbruch"; exit 1; }
done
echo "Alle Migrationen durchgelaufen."
