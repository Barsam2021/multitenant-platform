#!/bin/bash
# migrate.sh — Migrationen gegen eine LAUFENDE Installation nachfahren.
#
# Noetig, weil docker-entrypoint-initdb.d ausschliesslich bei leerem Volume laeuft.
# Bestehende Server bekommen neue Migrationen sonst nie.
#
# P2-7 (Audit 0430f9c): Es gab kein Migrations-Tracking. Die Reihenfolge ergab
# sich allein aus den Dateinamen, und es gibt zwei Dateien mit `12_` und zwei
# mit `13_`. Jede Datei lief bei jedem Aufruf erneut — was nur funktioniert,
# solange wirklich jede Migration idempotent ist. 15_cleanup_orphaned_projects
# war es nicht (siehe P2-6).
#
# Jetzt: schema_migrations mit Checksumme. Bereits gelaufene Dateien werden
# uebersprungen; aendert sich eine Datei nachtraeglich, gibt es eine Warnung
# statt eines stillen Re-Runs.
#
#   ./scripts/migrate.sh              # nur neue Migrationen
#   ./scripts/migrate.sh --force      # alle erneut ausfuehren (altes Verhalten)
#   ./scripts/migrate.sh --status     # nur anzeigen
set -euo pipefail
ROOT="/opt/multitenant-platform"
INIT="$ROOT/core-postgres/init-scripts"
MODE="${1:-}"

PSQL="docker exec -i core-postgres psql -U postgres -v ON_ERROR_STOP=1 -q"
PSQLT="docker exec -i core-postgres psql -U postgres -tAq"

$PSQL -d postgres -c "
  CREATE TABLE IF NOT EXISTS public.schema_migrations (
    filename   text PRIMARY KEY,
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  );" >/dev/null

if [ "$MODE" = "--status" ]; then
  echo "Angewendete Migrationen:"
  $PSQLT -d postgres -c "SELECT filename || '  ' || applied_at FROM public.schema_migrations ORDER BY filename;"
  exit 0
fi

echo "Migrationen gegen laufende Installation:"
APPLIED=0; SKIPPED=0
for f in $(find "$INIT" -maxdepth 1 -name '*.sql' | sort); do
  base=$(basename "$f")
  sum=$(sha256sum "$f" | cut -d' ' -f1)
  known=$($PSQLT -d postgres -c "SELECT checksum FROM public.schema_migrations WHERE filename = '$base';" || true)

  if [ -n "$known" ] && [ "$MODE" != "--force" ]; then
    if [ "$known" != "$sum" ]; then
      echo "  !! $base wurde nach dem Anwenden geaendert (Checksumme weicht ab)."
      echo "     Nicht automatisch erneut ausgefuehrt. Fuer einen bewussten Re-Run: --force"
    fi
    SKIPPED=$((SKIPPED+1))
    continue
  fi

  echo "  -> $base"
  if ! $PSQL < "$f"; then
    echo "     FEHLER in $base — Abbruch"; exit 1
  fi
  $PSQL -d postgres -c "
    INSERT INTO public.schema_migrations (filename, checksum) VALUES ('$base', '$sum')
    ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now();" >/dev/null
  APPLIED=$((APPLIED+1))
done
echo "Fertig: $APPLIED angewendet, $SKIPPED uebersprungen."
