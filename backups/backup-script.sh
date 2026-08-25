#!/bin/bash
# ============================================================================
# Vollstaendiges Plattform-Backup.  P0-5 (Audit 0430f9c).
#
# Gesichert wird, in dieser Reihenfolge:
#   1. Postgres-Globals (Rollen + Passwoerter)  <- ohne die scheitert JEDER
#      Restore an "ALTER ... OWNER TO authenticator_<slug>" und an jedem GRANT
#   2. admin_dashboard + jede kunde_*-Datenbank, Format custom (-Fc)
#   3. MinIO (alle Buckets)                     <- sonst sind alle Kundendateien weg
#   4. Config: .env, traefik/letsencrypt, traefik/dynamic, kunden-instances
#      <- .env enthaelt ENCRYPTION_MASTER_KEY; ohne den sind nach einem Restore
#         project_env_vars.value_encrypted und minio_secret_key_encrypted
#         dauerhaft unlesbar
#
# Bewusst KEIN `set -e` um die Einzelschritte: ein Fehlschlag bei einer
# Datenbank darf nicht die restlichen Tenants ungesichert lassen. Jeder Schritt
# setzt FAILED und laeuft weiter; am Ende gibt es genau einen Alarm.
# ============================================================================
set -uo pipefail

ROOT="/opt/multitenant-platform"
set -a
# shellcheck disable=SC1091
source "$ROOT/.env"
set +a

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$ROOT/backups/files"
WORK_DIR="$BACKUP_DIR/.work-$$"
RCLONE_CONFIG_PATH="${RCLONE_CONFIG:-$ROOT/backups/rclone.conf}"
REMOTE="${RCLONE_REMOTE_PATH:?RCLONE_REMOTE_PATH fehlt in .env}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-3}"
mkdir -p "$BACKUP_DIR" "$WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

: "${BACKUP_AGE_PUBLIC_KEY:?BACKUP_AGE_PUBLIC_KEY fehlt in .env}"

FAILED=0
PROBLEMS=""

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
fail() { FAILED=1; PROBLEMS="${PROBLEMS}
  - $*"; log "FEHLER: $*"; }

# --- Alerting -------------------------------------------------------------
# Audit §15: "Backup schlaegt fehl -> kein Alarm". backups.status und audit_logs
# muessen aktiv abgefragt werden; niemand tut das um 03:00.
send_alert() {
  local subject="$1" body="$2"
  if [ -z "${RESEND_API_KEY:-}" ] || [ -z "${ADMIN_EMAIL:-}" ]; then
    log "Kein RESEND_API_KEY/ADMIN_EMAIL — Alarm nicht versendet."
    return
  fi
  curl -sS -m 20 -X POST https://api.resend.com/emails \
    -H "Authorization: Bearer ${RESEND_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$(python3 - "$subject" "$body" "${ADMIN_EMAIL}" "${PLATFORM_DOMAIN:-example.com}" << 'PYJSON'
import json, sys
subject, body, to, domain = sys.argv[1:5]
print(json.dumps({
    "from": f"alerts@{domain}",
    "to": [to],
    "subject": f"[Plattform] {subject}",
    "text": body,
}))
PYJSON
)" >/dev/null || log "Alarm-Versand fehlgeschlagen."
}

record_backup() {
  local db="$1" filename="$2" size="$3" status="$4"
  # P2-19: Werte als psql-Variablen binden statt in den SQL-String zu interpolieren.
  # WICHTIG: :'var'-Interpolation funktioniert nur, wenn psql das SQL ueber
  # stdin liest -- mit -c bleibt ":" ein Syntaxfehler und jedes INSERT
  # scheitert still (nur log(), kein fail()). Daher hier <<'SQL' statt -c.
  docker exec -i core-postgres psql -U postgres -d admin_dashboard -v ON_ERROR_STOP=1 \
    -v db="$db" -v fn="$filename" -v sz="$size" -v st="$status" >/dev/null <<'SQL' \
    || fail "backups-Zeile fuer $db konnte nicht geschrieben werden"
INSERT INTO backups (db_name, filename, size_bytes, status, created_at)
VALUES (:'db', :'fn', :'sz'::bigint, :'st', now());
SQL
}

# Verschluesselt + laedt hoch + protokolliert. $1=Quelldatei $2=Logischer Name
encrypt_and_upload() {
  local src="$1" label="$2"
  local enc="${src}.age"
  if ! age -r "$BACKUP_AGE_PUBLIC_KEY" -o "$enc" "$src"; then
    fail "$label: Verschluesselung fehlgeschlagen"
    record_backup "$label" "-" 0 "encrypt_failed"
    return 1
  fi
  rm -f "$src"
  local size
  size=$(stat -c%s "$enc" 2>/dev/null || stat -f%z "$enc")
  log "Upload $(basename "$enc") (${size} bytes)"
  if rclone --config "$RCLONE_CONFIG_PATH" copy "$enc" "$REMOTE/" --quiet; then
    mv "$enc" "$BACKUP_DIR/"
    record_backup "$label" "$(basename "$enc")" "$size" "ok"
    return 0
  fi
  fail "$label: Upload nach $REMOTE fehlgeschlagen"
  mv "$enc" "$BACKUP_DIR/" 2>/dev/null || true
  record_backup "$label" "$(basename "$enc")" "$size" "upload_failed"
  return 1
}

# --- 1. Globals -----------------------------------------------------------
# P0-5(c): Rollen (authenticator_* mit Passwoertern, anon_*/authenticated_*/
# service_role_*) existieren nach einem Restore sonst nicht. Steht bewusst
# GANZ VORNE: ohne Globals ist jeder nachfolgende Dump wertlos.
log "Dumping Globals (Rollen)..."
if docker exec core-postgres pg_dumpall -U postgres --globals-only \
     | gzip > "$WORK_DIR/globals_${TIMESTAMP}.sql.gz"; then
  encrypt_and_upload "$WORK_DIR/globals_${TIMESTAMP}.sql.gz" "globals"
else
  fail "pg_dumpall --globals-only fehlgeschlagen"
  record_backup "globals" "-" 0 "dump_failed"
fi

# --- 2. Datenbanken -------------------------------------------------------
# P0-5: -Fc statt plain SQL. Erlaubt pg_restore -t <tabelle> fuer partielle
# Restores und ist selbst schon komprimiert.
DBS=$(docker exec core-postgres psql -U postgres -tAc \
  "SELECT datname FROM pg_database WHERE datname = 'admin_dashboard' OR datname LIKE 'kunde_%';")

for db in $DBS; do
  log "Dumping $db..."
  if docker exec core-postgres pg_dump -U postgres -Fc "$db" > "$WORK_DIR/${db}_${TIMESTAMP}.dump"; then
    encrypt_and_upload "$WORK_DIR/${db}_${TIMESTAMP}.dump" "$db"
  else
    fail "pg_dump fehlgeschlagen fuer $db"
    record_backup "$db" "-" 0 "dump_failed"
  fi
done

# --- 3. MinIO -------------------------------------------------------------
# P0-5(d): sonst sind bei Serververlust saemtliche Kundendateien weg.
log "Spiegele MinIO..."
if docker exec provisioning-agent mc alias set localminio http://core-minio:9000 \
      "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" >/dev/null 2>&1 \
   && docker exec provisioning-agent sh -c \
      "rm -rf /tmp/minio-mirror && mkdir -p /tmp/minio-mirror && mc mirror --quiet localminio /tmp/minio-mirror" \
   && docker exec provisioning-agent tar czf - -C /tmp minio-mirror > "$WORK_DIR/minio_${TIMESTAMP}.tar.gz"; then
  docker exec provisioning-agent rm -rf /tmp/minio-mirror >/dev/null 2>&1 || true
  encrypt_and_upload "$WORK_DIR/minio_${TIMESTAMP}.tar.gz" "minio"
else
  docker exec provisioning-agent rm -rf /tmp/minio-mirror >/dev/null 2>&1 || true
  fail "MinIO-Spiegelung fehlgeschlagen"
  record_backup "minio" "-" 0 "dump_failed"
fi

# --- 4. Config ------------------------------------------------------------
# P0-5(b): .env enthaelt ENCRYPTION_MASTER_KEY. Ohne ihn sind nach einem
# Restore project_env_vars.value_encrypted und kunden.minio_secret_key_encrypted
# dauerhaft unlesbar — jede Kunden-App verliert alle konfigurierten Env-Vars.
# acme.json spart nach einem Desaster die Let's-Encrypt-Rate-Limits.
log "Sichere Konfiguration..."
CONFIG_PATHS=(".env")
[ -d traefik/letsencrypt ] && CONFIG_PATHS+=("traefik/letsencrypt")
[ -d traefik/dynamic ]     && CONFIG_PATHS+=("traefik/dynamic")
[ -d kunden-instances ]    && CONFIG_PATHS+=("kunden-instances")
if tar czf "$WORK_DIR/config_${TIMESTAMP}.tar.gz" -C "$ROOT" "${CONFIG_PATHS[@]}" 2>/dev/null; then
  encrypt_and_upload "$WORK_DIR/config_${TIMESTAMP}.tar.gz" "config"
else
  fail "Config-Archiv fehlgeschlagen"
  record_backup "config" "-" 0 "dump_failed"
fi

# --- 5. Retention ---------------------------------------------------------
find "$BACKUP_DIR" -maxdepth 1 -name "*.age" -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true
if [ -n "${BACKUP_REMOTE_RETENTION_DAYS:-}" ]; then
  rclone --config "$RCLONE_CONFIG_PATH" delete "$REMOTE/" \
    --min-age "${BACKUP_REMOTE_RETENTION_DAYS}d" --quiet \
    || log "WARNUNG: Remote-Retention fehlgeschlagen"
fi

# --- 6. Ergebnis ----------------------------------------------------------
if [ "$FAILED" -eq 1 ]; then
  log "Backup mit Fehlern abgeschlossen."
  send_alert "Backup FEHLGESCHLAGEN ($TIMESTAMP)" \
"Das Backup vom ${TIMESTAMP} hatte Fehler:
${PROBLEMS}

Pruefen:
  docker logs provisioning-agent
  tail -100 /var/log/mt-backup.log
  psql -d admin_dashboard -c \"SELECT * FROM backups ORDER BY created_at DESC LIMIT 20;\"

Erinnerung: ein Backup ist erst ein Backup, wenn ein Restore einmal
durchgelaufen ist. Test: ./backups/restore-test-script.sh <dateiname>"
  exit 1
fi

log "Backup vollstaendig: Globals, $(echo "$DBS" | wc -w) Datenbanken, MinIO, Config."
exit 0
