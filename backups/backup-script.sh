#!/bin/bash
set -euo pipefail

ROOT="/opt/multitenant-platform"
set -a
source "$ROOT/.env"
set +a

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$ROOT/backups/files"
RCLONE_CONFIG_PATH="${RCLONE_CONFIG:-$ROOT/backups/rclone.conf}"
REMOTE="${RCLONE_REMOTE_PATH:?RCLONE_REMOTE_PATH fehlt in .env}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-3}"
mkdir -p "$BACKUP_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

: "${BACKUP_AGE_PUBLIC_KEY:?BACKUP_AGE_PUBLIC_KEY fehlt in .env}"

record_backup() {
  local db="$1" filename="$2" size="$3" status="$4"
  docker exec core-postgres psql -U postgres -d admin_dashboard -v ON_ERROR_STOP=1 \
    -c "INSERT INTO backups (db_name, filename, size_bytes, status, created_at) VALUES ('${db}', '${filename}', ${size}, '${status}', now());" \
    >/dev/null
}

DBS=$(docker exec core-postgres psql -U postgres -tAc \
  "SELECT datname FROM pg_database WHERE datname = 'admin_dashboard' OR datname LIKE 'kunde_%';")

FAILED=0

for db in $DBS; do
  RAW_FILE="$BACKUP_DIR/${db}_${TIMESTAMP}.sql.gz"
  ENC_FILE="${RAW_FILE}.age"

  log "Dumping $db..."
  if docker exec core-postgres pg_dump -U postgres "$db" | gzip > "$RAW_FILE"; then
    age -r "$BACKUP_AGE_PUBLIC_KEY" -o "$ENC_FILE" "$RAW_FILE"
    rm -f "$RAW_FILE"
    SIZE=$(stat -c%s "$ENC_FILE" 2>/dev/null || stat -f%z "$ENC_FILE")
    log "Uploading $(basename "$ENC_FILE") (${SIZE} bytes) nach $REMOTE ..."
    if rclone --config "$RCLONE_CONFIG_PATH" copy "$ENC_FILE" "$REMOTE/" --quiet; then
      record_backup "$db" "$(basename "$ENC_FILE")" "$SIZE" "ok"
      log "OK: $db"
    else
      record_backup "$db" "$(basename "$ENC_FILE")" "$SIZE" "upload_failed"
      log "FEHLER: Upload fehlgeschlagen fuer $db"
      FAILED=1
    fi
  else
    log "FEHLER: pg_dump fehlgeschlagen fuer $db"
    record_backup "$db" "-" 0 "dump_failed"
    FAILED=1
  fi
done

find "$BACKUP_DIR" -name "*.sql.gz.age" -mtime +"$RETENTION_DAYS" -delete

if [ "$FAILED" -eq 1 ]; then
  log "Backup mit Fehlern abgeschlossen."
  exit 1
fi
log "Backup erfolgreich abgeschlossen."
