#!/bin/bash
set -euo pipefail

ROOT="/opt/multitenant-platform"
set -a
source "$ROOT/.env"
set +a

FILENAME="${1:?Usage: restore-test-script.sh <backup-filename>}"
RCLONE_CONFIG_PATH="${RCLONE_CONFIG:-$ROOT/backups/rclone.conf}"
REMOTE="${RCLONE_REMOTE_PATH:?RCLONE_REMOTE_PATH fehlt in .env}"
TMP_DIR="/tmp/restore-test-$$"
mkdir -p "$TMP_DIR"

: "${BACKUP_AGE_IDENTITY_FILE:?BACKUP_AGE_IDENTITY_FILE fehlt in .env}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

FILENAME=$(basename "$FILENAME")
if [[ ! "$FILENAME" =~ ^[a-zA-Z0-9_.-]+\.sql\.gz\.age$ ]]; then
  echo "Ungueltiger Dateiname: $FILENAME" >&2
  exit 1
fi

log "Lade $FILENAME von $REMOTE..."
rclone --config "$RCLONE_CONFIG_PATH" copy "$REMOTE/$FILENAME" "$TMP_DIR/" --quiet

ENC_FILE="$TMP_DIR/$FILENAME"
SQL_FILE="${ENC_FILE%.age}"

log "Entschluessele..."
age -d -i "$BACKUP_AGE_IDENTITY_FILE" -o "$SQL_FILE" "$ENC_FILE"

ORIG_DB=$(echo "$FILENAME" | sed -E 's/_[0-9]{8}-[0-9]{6}\.sql\.gz\.age$//')
if [[ ! "$ORIG_DB" =~ ^[a-z0-9_]+$ ]]; then
  echo "Konnte DB-Namen nicht sicher aus Dateinamen ableiten: $ORIG_DB" >&2
  exit 1
fi
TEST_DB="${ORIG_DB}_restoretest"

cleanup_db() {
  docker exec core-postgres psql -U postgres -c "DROP DATABASE IF EXISTS \"$TEST_DB\";" >/dev/null 2>&1 || true
}
trap 'cleanup_db; rm -rf "$TMP_DIR"' EXIT

log "Lege temporaere Test-DB $TEST_DB an..."
docker exec core-postgres psql -U postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$TEST_DB\";"
docker exec core-postgres psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$TEST_DB\";"

log "Spiele Dump ein..."
gunzip -c "$SQL_FILE" | docker exec -i core-postgres psql -U postgres -d "$TEST_DB" -q -v ON_ERROR_STOP=1

TABLE_COUNT=$(docker exec core-postgres psql -U postgres -d "$TEST_DB" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema');")

log "Restore-Test OK: $TABLE_COUNT Tabellen in $TEST_DB gefunden."
echo "RESTORE_TEST_RESULT:OK:${TABLE_COUNT}"
