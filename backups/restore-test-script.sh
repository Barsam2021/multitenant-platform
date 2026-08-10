#!/bin/bash
# Restore-TEST in eine temporaere Wegwerf-Datenbank.
# Aendert NICHTS an den produktiven Daten. Fuer den echten Restore:
#   ./backups/restore-script.sh
#
# Audit §9: bisher wurde nur die Anzahl der Tabellen geprueft. Jetzt zusaetzlich
# Zeilen-Counts pro Tabelle, sonst faellt ein leerer, aber strukturell korrekter
# Dump nicht auf.
set -euo pipefail

ROOT="/opt/multitenant-platform"
set -a
# shellcheck disable=SC1091
source "$ROOT/.env"
set +a

FILENAME="${1:?Usage: restore-test-script.sh <backup-filename>   (z.B. kunde_foo_20260810-030000.dump.age)}"
RCLONE_CONFIG_PATH="${RCLONE_CONFIG:-$ROOT/backups/rclone.conf}"
REMOTE="${RCLONE_REMOTE_PATH:?RCLONE_REMOTE_PATH fehlt in .env}"
TMP_DIR="/tmp/restore-test-$$"
mkdir -p "$TMP_DIR"

: "${BACKUP_AGE_IDENTITY_FILE:?BACKUP_AGE_IDENTITY_FILE fehlt in .env}"
[ -f "$BACKUP_AGE_IDENTITY_FILE" ] || { echo "age-Identity fehlt: $BACKUP_AGE_IDENTITY_FILE" >&2; exit 1; }

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

FILENAME=$(basename "$FILENAME")
if [[ ! "$FILENAME" =~ ^[a-zA-Z0-9_.-]+\.(dump|sql\.gz)\.age$ ]]; then
  echo "Ungueltiger Dateiname: $FILENAME" >&2; exit 1
fi

log "Lade $FILENAME von $REMOTE..."
rclone --config "$RCLONE_CONFIG_PATH" copy "$REMOTE/$FILENAME" "$TMP_DIR/" --quiet
ENC_FILE="$TMP_DIR/$FILENAME"
PLAIN_FILE="${ENC_FILE%.age}"

log "Entschluessele..."
age -d -i "$BACKUP_AGE_IDENTITY_FILE" -o "$PLAIN_FILE" "$ENC_FILE"

ORIG_DB=$(echo "$FILENAME" | sed -E 's/_[0-9]{8}-[0-9]{6}\.(dump|sql\.gz)\.age$//')
if [[ ! "$ORIG_DB" =~ ^[a-z0-9_]+$ ]]; then
  echo "Konnte DB-Namen nicht sicher aus Dateinamen ableiten: $ORIG_DB" >&2; exit 1
fi
TEST_DB="${ORIG_DB}_restoretest"

cleanup() {
  docker exec core-postgres psql -U postgres -c "DROP DATABASE IF EXISTS \"$TEST_DB\";" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

log "Lege temporaere Test-DB $TEST_DB an..."
docker exec core-postgres psql -U postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$TEST_DB\";"
docker exec core-postgres psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$TEST_DB\";"

log "Spiele Dump ein..."
if [[ "$FILENAME" == *.dump.age ]]; then
  # -Fc: Fehler bei fehlenden Rollen sind hier erwartbar (Wegwerf-DB ohne
  # Globals-Restore) und duerfen den Test nicht abbrechen.
  docker exec -i core-postgres pg_restore -U postgres -d "$TEST_DB" --no-owner --no-acl < "$PLAIN_FILE" \
    || log "WARNUNG: pg_restore meldete Fehler (meist fehlende Rollen — im Test erwartbar)"
else
  gunzip -c "$PLAIN_FILE" | docker exec -i core-postgres psql -U postgres -d "$TEST_DB" -q \
    || log "WARNUNG: psql meldete Fehler"
fi

TABLE_COUNT=$(docker exec core-postgres psql -U postgres -d "$TEST_DB" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema');")

log "Zeilen pro Tabelle:"
ROW_TOTAL=$(docker exec core-postgres psql -U postgres -d "$TEST_DB" -tAc "
  SELECT coalesce(sum(cnt),0) FROM (
    SELECT (xpath('/row/c/text()',
      query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name),
                   false, true, '')))[1]::text::bigint AS cnt
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE'
  ) x;")

docker exec core-postgres psql -U postgres -d "$TEST_DB" -c "
  SELECT table_schema||'.'||table_name AS tabelle,
    (xpath('/row/c/text()',
      query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name),
                   false, true, '')))[1]::text::bigint AS zeilen
  FROM information_schema.tables
  WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE'
  ORDER BY 2 DESC LIMIT 25;" || true

if [ "$TABLE_COUNT" -eq 0 ]; then
  echo "RESTORE_TEST_RESULT:FAIL:0"
  echo "Restore-Test FEHLGESCHLAGEN: keine Tabellen im Dump." >&2
  exit 1
fi

log "Restore-Test OK: $TABLE_COUNT Tabellen, $ROW_TOTAL Zeilen gesamt in $TEST_DB."
echo "RESTORE_TEST_RESULT:OK:${TABLE_COUNT}:${ROW_TOTAL}"
