#!/bin/bash
# ============================================================================
# ECHTER Restore in die produktive Installation. Ueberschreibt Daten.
#
# Audit §9: "Der Restore in die echte Datenbank ist nirgends erprobt oder
# skriptiert." Das hier ist dieses Script.
#
#   ./backups/restore-script.sh globals                 # Rollen zuerst!
#   ./backups/restore-script.sh db   kunde_foo_20260810-030000.dump.age
#   ./backups/restore-script.sh config config_20260810-030000.tar.gz.age
#   ./backups/restore-script.sh minio  minio_20260810-030000.tar.gz.age
#   ./backups/restore-script.sh list                    # verfuegbare Dateien
#
# REIHENFOLGE bei einem Totalverlust:
#   1. .env + age-identity.txt aus dem Off-Site-DR-Bundle wiederherstellen
#   2. globals   (sonst scheitert jeder DB-Restore an OWNER/GRANT)
#   3. config    (traefik-Zertifikate, kunden-instances)
#   4. admin_dashboard, dann jede kunde_*-DB
#   5. minio
#   6. docker compose up fuer alle Stacks
# ============================================================================
set -euo pipefail

ROOT="/opt/multitenant-platform"
set -a
# shellcheck disable=SC1091
source "$ROOT/.env"
set +a

MODE="${1:?Usage: restore-script.sh <list|globals|db|config|minio> [dateiname]}"
RCLONE_CONFIG_PATH="${RCLONE_CONFIG:-$ROOT/backups/rclone.conf}"
REMOTE="${RCLONE_REMOTE_PATH:?RCLONE_REMOTE_PATH fehlt in .env}"
: "${BACKUP_AGE_IDENTITY_FILE:?BACKUP_AGE_IDENTITY_FILE fehlt in .env}"

log() { echo "[restore] $*"; }
die() { echo "[restore][FEHLER] $*" >&2; exit 1; }

if [ "$MODE" = "list" ]; then
  rclone --config "$RCLONE_CONFIG_PATH" lsl "$REMOTE/" | sort -k4
  exit 0
fi

confirm() {
  echo
  echo "  !!  $1"
  read -r -p "  Weiter? Tippe genau JA: " a
  [ "$a" = "JA" ] || die "Abgebrochen."
}

fetch() {
  local fn="$1" tmp="$2"
  fn=$(basename "$fn")
  [[ "$fn" =~ ^[a-zA-Z0-9_.-]+\.age$ ]] || die "Ungueltiger Dateiname: $fn"
  log "Lade $fn ..."
  rclone --config "$RCLONE_CONFIG_PATH" copy "$REMOTE/$fn" "$tmp/" --quiet
  age -d -i "$BACKUP_AGE_IDENTITY_FILE" -o "$tmp/${fn%.age}" "$tmp/$fn"
  echo "$tmp/${fn%.age}"
}

TMP="/tmp/restore-$$"; mkdir -p "$TMP"; trap 'rm -rf "$TMP"' EXIT

case "$MODE" in
  globals)
    FN="${2:-}"
    if [ -z "$FN" ]; then
      FN=$(rclone --config "$RCLONE_CONFIG_PATH" lsf "$REMOTE/" | grep '^globals_' | sort | tail -1)
      [ -n "$FN" ] || die "Kein globals_*-Backup gefunden"
      log "Neuestes Globals-Backup: $FN"
    fi
    PLAIN=$(fetch "$FN" "$TMP")
    confirm "Spielt Rollen und Passwoerter ein. Bestehende Rollen bleiben (CREATE ROLE schlaegt fehl, das ist ok)."
    gunzip -c "$PLAIN" | docker exec -i core-postgres psql -U postgres \
      || log "WARNUNG: einzelne Statements fehlgeschlagen (meist 'role already exists' — erwartbar)"
    log "Globals eingespielt."
    ;;

  db)
    FN="${2:?Dateiname noetig, siehe: restore-script.sh list}"
    DB=$(basename "$FN" | sed -E 's/_[0-9]{8}-[0-9]{6}\.(dump|sql\.gz)\.age$//')
    [[ "$DB" =~ ^[a-z0-9_]+$ ]] || die "DB-Name nicht ableitbar: $DB"
    PLAIN=$(fetch "$FN" "$TMP")
    confirm "UEBERSCHREIBT die Datenbank \"$DB\" vollstaendig. Alle Verbindungen werden getrennt."
    docker exec core-postgres psql -U postgres -v ON_ERROR_STOP=1 -c \
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB' AND pid <> pg_backend_pid();" >/dev/null
    docker exec core-postgres psql -U postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$DB\";"
    docker exec core-postgres psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB\";"
    if [[ "$FN" == *.dump.age ]]; then
      docker exec -i core-postgres pg_restore -U postgres -d "$DB" < "$PLAIN" \
        || log "WARNUNG: pg_restore meldete Fehler — Ausgabe pruefen"
    else
      gunzip -c "$PLAIN" | docker exec -i core-postgres psql -U postgres -d "$DB" \
        || log "WARNUNG: psql meldete Fehler"
    fi
    # P0-2a: die frisch angelegte DB haette wieder CONNECT fuer PUBLIC.
    if [[ "$DB" == kunde_* ]]; then
      SLUG="${DB#kunde_}"
      docker exec core-postgres psql -U postgres -c \
        "REVOKE ALL ON DATABASE \"$DB\" FROM PUBLIC;
         GRANT CONNECT, TEMPORARY ON DATABASE \"$DB\" TO \"authenticator_${SLUG}\";" >/dev/null \
        || log "WARNUNG: CONNECT-Rechte konnten nicht gesetzt werden — manuell nachziehen (P0-2a)!"
    else
      docker exec core-postgres psql -U postgres -c \
        "REVOKE ALL ON DATABASE \"$DB\" FROM PUBLIC;" >/dev/null || true
    fi
    log "Datenbank $DB wiederhergestellt."
    ;;

  config)
    FN="${2:?Dateiname noetig}"
    PLAIN=$(fetch "$FN" "$TMP")
    confirm "Entpackt .env, traefik/letsencrypt, traefik/dynamic und kunden-instances nach $ROOT und ueberschreibt Bestehendes."
    cp "$ROOT/.env" "$ROOT/.env.vor-restore-$(date +%s)" 2>/dev/null || true
    tar xzf "$PLAIN" -C "$ROOT"
    chmod 600 "$ROOT/.env"
    log "Config wiederhergestellt. Container neu starten, damit die Werte greifen."
    ;;

  minio)
    FN="${2:?Dateiname noetig}"
    PLAIN=$(fetch "$FN" "$TMP")
    confirm "Spielt ALLE MinIO-Buckets zurueck und ueberschreibt gleichnamige Objekte."
    tar xzf "$PLAIN" -C "$TMP"
    docker cp "$TMP/minio-mirror" provisioning-agent:/tmp/minio-restore
    docker exec provisioning-agent mc alias set localminio http://core-minio:9000 \
      "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" >/dev/null
    docker exec provisioning-agent mc mirror --overwrite /tmp/minio-restore localminio
    docker exec provisioning-agent rm -rf /tmp/minio-restore
    log "MinIO wiederhergestellt."
    ;;

  *) die "Unbekannter Modus: $MODE" ;;
esac
