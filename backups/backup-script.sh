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

# --- Aufbewahrungsmodus ---------------------------------------------------
# generations = Grossvater-Vater-Sohn (lange Rueckschau, waechst mit der Zeit)
# count       = die letzten N Laeufe, zusaetzlich gedeckelt durch ein
#               Speicherbudget. Fuer ein festes Gratiskontingent (z.B. die
#               10 GB von Cloudflare R2) das passendere Modell: die Zahl der
#               Kopien ist dort die Stellschraube, nicht ihr Alter.
RETENTION_MODE="${BACKUP_RETENTION_MODE:-generations}"

# --- Generation (Grossvater-Vater-Sohn) -----------------------------------
# Vorher landete jede Sicherung im selben Verzeichnis und wurde nach wenigen
# Tagen geloescht. Ein Schaden, der erst nach zwei Wochen auffaellt —
# schleichende Korruption, ein versehentliches DELETE, ein Verschluesselungs-
# trojaner — war damit nicht mehr rueckholbar: die einzigen Kopien zeigten
# laengst denselben kaputten Stand.
#
# Deshalb drei Toepfe mit eigener Aufbewahrung. Die Zuordnung ist bewusst
# ueberschneidungsfrei: der Monatserste ist monthly, ein Sonntag weekly, alles
# andere daily. Ein Lauf schreibt also genau EINE Kopie, nicht drei.
if [ "$RETENTION_MODE" = "count" ]; then
  # Bei zaehlbasierter Aufbewahrung waeren Generationen-Ordner sinnlos: es
  # gibt ohnehin nur eine Handvoll Laeufe, und die sollen alle gleich
  # behandelt werden. Also flach ablegen.
  GENERATION=""
  REMOTE_TARGET="$REMOTE"
else
  DAY_OF_MONTH=$(date +%d)
  DAY_OF_WEEK=$(date +%u)   # 1=Montag ... 7=Sonntag
  if [ "$DAY_OF_MONTH" = "01" ]; then
    GENERATION="monthly"
  elif [ "$DAY_OF_WEEK" = "7" ]; then
    GENERATION="weekly"
  else
    GENERATION="daily"
  fi
  REMOTE_TARGET="$REMOTE/$GENERATION"
fi

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
  docker exec -i core-postgres psql -U postgres -d admin_dashboard -v ON_ERROR_STOP=1 \
    -v db="$db" -v fn="$filename" -v sz="$size" -v st="$status" \
    -c "INSERT INTO backups (db_name, filename, size_bytes, status, created_at)
        VALUES (:'db', :'fn', :'sz'::bigint, :'st', now());" >/dev/null \
    || log "WARNUNG: backups-Zeile fuer $db konnte nicht geschrieben werden"
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
  log "Upload $(basename "$enc") -> ${GENERATION:-/} (${size} bytes)"
  if rclone --config "$RCLONE_CONFIG_PATH" copy "$enc" "$REMOTE_TARGET/" --quiet; then
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

# Jede Generation raeumt sich selbst auf.
#
# WICHTIG: --max-depth 1 ist hier nicht Kosmetik. `rclone delete` arbeitet
# rekursiv; ohne die Begrenzung wuerde der Aufruf fuer daily/ mit seinen 7
# Tagen auch weekly/ und monthly/ mitnehmen, sobald jemand die Pfade einmal
# anders schachtelt — und der Verlust faellt erst auf, wenn man ein altes
# Backup braucht.
prune_generation() {
  local gen="$1" days="$2"
  [ -n "$days" ] || return 0
  rclone --config "$RCLONE_CONFIG_PATH" delete "$REMOTE/$gen/" \
    --min-age "${days}d" --max-depth 1 --quiet \
    || log "WARNUNG: Retention fuer $gen fehlgeschlagen"
}

# Zaehl- und budgetbasierte Aufbewahrung.
#
# Ein "Lauf" ist alles, was ein naechtlicher Durchgang erzeugt: Globals, jede
# Datenbank, MinIO, Config. Alle diese Dateien tragen denselben Zeitstempel im
# Namen — daran werden sie gruppiert. Geloescht wird immer ein VOLLSTAENDIGER
# Lauf, nie eine einzelne Datei: ein Lauf ohne seine Globals oder ohne MinIO
# waere im Ernstfall wertlos und wuerde trotzdem wie ein Backup aussehen.
#
# Zwei Grenzen, die zusammenwirken:
#   BACKUP_KEEP_RUNS      wie viele Laeufe hoechstens
#   BACKUP_MAX_TOTAL_BYTES wie viel Platz sie hoechstens belegen duerfen
#
# Die zweite ist die wichtigere, wenn ein Gratiskontingent eingehalten werden
# soll: waechst die Datenmenge, reichen "die letzten 3" irgendwann nicht mehr,
# um unter 10 GB zu bleiben. Dann werden weitere Laeufe fallengelassen — aber
# nie unter BACKUP_MIN_KEEP_RUNS. Lieber ueber dem Budget und mit Alarm als mit
# nur noch einer einzigen Kopie.
prune_by_count_and_budget() {
  local keep_runs="${BACKUP_KEEP_RUNS:-3}"
  local min_keep="${BACKUP_MIN_KEEP_RUNS:-2}"
  local max_bytes="${BACKUP_MAX_TOTAL_BYTES:-9000000000}"
  local listing="$WORK_DIR/remote-listing.json"

  if ! rclone --config "$RCLONE_CONFIG_PATH" lsjson -R --files-only "$REMOTE/" \
       > "$listing" 2>/dev/null; then
    log "WARNUNG: Bestand nicht abrufbar — Aufbewahrung uebersprungen"
    return 0
  fi

  local plan
  plan=$(python3 - "$listing" "$keep_runs" "$min_keep" "$max_bytes" << 'PYPRUNE'
import json, re, sys

listing, keep_runs, min_keep, max_bytes = sys.argv[1:5]
keep_runs, min_keep, max_bytes = int(keep_runs), int(min_keep), int(max_bytes)

try:
    files = json.load(open(listing))
except Exception:
    files = []

# Nach Lauf gruppieren. Der Zeitstempel im Dateinamen (YYYYMMDD-HHMMSS) wird
# einmal pro Durchgang gesetzt und ist damit die Lauf-Kennung.
runs = {}
for f in files:
    name = f.get("Name", "")
    if not name.endswith(".age"):
        continue
    m = re.search(r"(\d{8}-\d{6})", name)
    key = m.group(1) if m else name
    run = runs.setdefault(key, {"size": 0, "paths": []})
    run["size"] += int(f.get("Size") or 0)
    run["paths"].append(f.get("Path"))

order = sorted(runs, reverse=True)          # neuester Lauf zuerst
keep, drop = order[:keep_runs], order[keep_runs:]

def total(keys):
    return sum(runs[k]["size"] for k in keys)

# Ueber Budget? Dann die aeltesten behaltenen Laeufe nachtraeglich fallen
# lassen — bis zur Untergrenze, nicht darunter.
while total(keep) > max_bytes and len(keep) > min_keep:
    drop.append(keep.pop())

for k in drop:
    for path in runs[k]["paths"]:
        print("DEL\t%s" % path)

print("STATS\t%d\t%d\t%d" % (len(keep), total(keep), len(drop)))
print("OVER\t%d" % (1 if total(keep) > max_bytes else 0))
PYPRUNE
  ) || { log "WARNUNG: Aufbewahrung konnte nicht berechnet werden"; return 0; }

  local deleted=0
  while IFS=$'\t' read -r kind a b c; do
    case "$kind" in
      DEL)
        if rclone --config "$RCLONE_CONFIG_PATH" deletefile "$REMOTE/$a" --quiet 2>/dev/null; then
          deleted=$((deleted+1))
        else
          log "WARNUNG: konnte $a nicht loeschen"
        fi
        ;;
      STATS)
        log "Aufbewahrung: $a Laeufe behalten ($(( b / 1024 / 1024 )) MB), $c Laeufe entfernt."
        ;;
      OVER)
        if [ "$a" = "1" ]; then
          send_alert "Backup-Speicher ueber Budget" \
"Der Bestand im Object Storage liegt ueber ${max_bytes} Bytes, obwohl nur noch
die Mindestzahl von ${min_keep} Laeufen aufbewahrt wird.

Weiter zu loeschen waere gefaehrlich — dann bliebe zu wenig uebrig, um einen
Fehler zu ueberstehen, der erst spaeter auffaellt.

Moeglichkeiten:
  - BACKUP_MAX_TOTAL_BYTES anheben (kostet beim Anbieter Geld)
  - BACKUP_KEEP_RUNS senken
  - Datenmenge pruefen: meist ist der MinIO-Spiegel der groesste Posten
    docker exec provisioning-agent mc du localminio"
        fi
        ;;
    esac
  done <<< "$plan"

  [ "$deleted" -gt 0 ] && log "$deleted Datei(en) beim Anbieter geloescht."
  return 0
}

if [ "$RETENTION_MODE" = "count" ]; then
  prune_by_count_and_budget
else
  prune_generation daily   "${BACKUP_DAILY_RETENTION_DAYS:-7}"
  prune_generation weekly  "${BACKUP_WEEKLY_RETENTION_DAYS:-28}"
  prune_generation monthly "${BACKUP_MONTHLY_RETENTION_DAYS:-180}"

  # Altbestand aus der Zeit vor den Generationen liegt flach im
  # Wurzelverzeichnis. Nur diese Ebene anfassen, die Unterordner sind oben
  # schon geregelt.
  if [ -n "${BACKUP_REMOTE_RETENTION_DAYS:-}" ]; then
    rclone --config "$RCLONE_CONFIG_PATH" delete "$REMOTE/" \
      --min-age "${BACKUP_REMOTE_RETENTION_DAYS}d" --max-depth 1 --quiet \
      || log "WARNUNG: Remote-Retention (Altbestand) fehlgeschlagen"
  fi
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

log "Backup vollstaendig ($GENERATION): Globals, $(echo "$DBS" | wc -w) Datenbanken, MinIO, Config."
exit 0
