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

# ===========================================================================
# Speicherbudget (nur bei BACKUP_RETENTION_MODE=count)
# ===========================================================================
# Das Budget ist eine HARTE Obergrenze. Deshalb wird aufgeraeumt, BEVOR etwas
# hochgeladen wird — nicht danach.
#
# Der Unterschied ist nicht theoretisch: Bei "erst hochladen, dann aufraeumen"
# liegen zwischenzeitlich der alte Bestand UND der neue Lauf beim Anbieter.
# Bei 3 aufbewahrten Laeufen zu je 3 GB waeren das kurzzeitig 12 GB — das
# Gratiskontingent waere gesprengt, und zwar genau in dem Moment, in dem
# niemand hinsieht (03:00). Aufgeraeumt wird deshalb vorher, und vor jeder
# einzelnen Datei wird erneut geprueft.
#
# Reihenfolge der Zusicherungen, wenn es eng wird:
#   1. Das Budget wird nie ueberschritten. Harte Grenze, ohne Ausnahme.
#   2. Passt der neue Lauf nicht einmal allein hinein, bleibt ALLES unberuehrt:
#      nichts geloescht, nichts hochgeladen, dafuer ein Alarm. Ein halb
#      hochgeladener Lauf, fuer den die alten Kopien geopfert wurden, waere
#      der schlechteste aller Ausgaenge.
#   3. Passt er, wird so viel Altbestand entfernt wie noetig — notfalls alles.
#      Dann gibt es eben nur noch eine Kopie; das ist die bewusste Entscheidung
#      zugunsten der harten Grenze.
#   4. Erst danach zaehlt BACKUP_KEEP_RUNS als Obergrenze.
MAX_TOTAL_BYTES="${BACKUP_MAX_TOTAL_BYTES:-9000000000}"
KEEP_RUNS="${BACKUP_KEEP_RUNS:-3}"
REMOTE_USED=0
RUNS_FILE="$WORK_DIR/remote-runs.tsv"

# Bestand beim Anbieter einlesen und nach Laeufen gruppieren.
# Ein Lauf = alle Dateien mit demselben Zeitstempel im Namen.
# Ausgabe je Zeile: <zeitstempel>\t<bytes>\t<pfad1,pfad2,...>, neueste zuerst.
refresh_remote_state() {
  : > "$RUNS_FILE"
  if ! rclone --config "$RCLONE_CONFIG_PATH" lsjson -R --files-only "$REMOTE/" \
       > "$WORK_DIR/listing.json" 2>/dev/null; then
    log "WARNUNG: Bestand beim Anbieter nicht abrufbar."
    return 1
  fi
  python3 - "$WORK_DIR/listing.json" > "$RUNS_FILE" << 'PYRUNS'
import json, re, sys
try:
    files = json.load(open(sys.argv[1]))
except Exception:
    files = []
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
for key in sorted(runs, reverse=True):          # neuester Lauf zuerst
    print("%s\t%d\t%s" % (key, runs[key]["size"], ",".join(runs[key]["paths"])))
PYRUNS
  REMOTE_USED=$(awk -F'\t' '{s+=$2} END {print s+0}' "$RUNS_FILE")
  return 0
}

runs_count() { wc -l < "$RUNS_FILE" | tr -d ' '; }

# Entfernt den aeltesten Lauf vollstaendig. Nie einzelne Dateien: ein Lauf ohne
# seine Globals oder ohne MinIO waere im Ernstfall wertlos und saehe trotzdem
# wie ein Backup aus.
delete_oldest_run() {
  local line ts size paths
  line=$(tail -n 1 "$RUNS_FILE")
  [ -n "$line" ] || return 1
  ts=$(printf '%s' "$line" | cut -f1)
  size=$(printf '%s' "$line" | cut -f2)
  paths=$(printf '%s' "$line" | cut -f3)

  # `|| [ -n "$p" ]` ist hier zwingend, nicht Stilfrage: die Pfadliste endet
  # ohne Zeilenumbruch, und `read` liefert fuer das letzte Feld zwar den Wert,
  # gibt aber einen Fehlercode zurueck. Ohne den Zusatz bliebe von JEDEM
  # geloeschten Lauf genau eine Datei liegen — der Speicher waere Nacht fuer
  # Nacht weiter gewachsen, bis das Budget doch gerissen waere.
  local p fehler=0
  while IFS= read -r p || [ -n "$p" ]; do
    [ -n "$p" ] || continue
    if ! rclone --config "$RCLONE_CONFIG_PATH" deletefile "$REMOTE/$p" --quiet 2>/dev/null; then
      log "WARNUNG: konnte $p nicht loeschen"
      fehler=1
    fi
  done < <(printf '%s' "$paths" | tr ',' '\n')

  sed -i '$d' "$RUNS_FILE"

  if [ "$fehler" -eq 1 ]; then
    # Konnte nicht alles geloescht werden, ist die mitgefuehrte Belegung zu
    # niedrig — und eine zu niedrige Schaetzung ist genau der Weg, auf dem das
    # Budget doch gerissen wird. Also den echten Stand neu holen.
    log "Teilweise fehlgeschlagene Loeschung — Bestand wird neu eingelesen."
    refresh_remote_state || true
  else
    REMOTE_USED=$((REMOTE_USED - size))
  fi

  log "Aeltesten Lauf entfernt: $ts (+$((size / 1024 / 1024)) MB frei)"
  return 0
}

# Vor dem ersten Dump nur den Bestand einlesen. Aufgeraeumt wird spaeter, wenn
# die ECHTE Groesse des neuen Laufs feststeht — eine Schaetzung war hier der
# falsche Weg: sie stuetzte sich auf den juengsten Lauf, und war der selbst
# unvollstaendig (weil eine fruehere Nacht abgebrochen war), fiel sie
# beliebig zu klein aus. Das Skript loeschte daraufhin den letzten
# vollstaendigen Lauf, um Platz fuer einen zu schaffen, der gar nicht
# hineinpasste.
preflight_budget() {
  refresh_remote_state || { log "Budgetpruefung uebersprungen."; return 0; }
  log "Bestand: $(runs_count) Lauf/Laeufe, $((REMOTE_USED / 1024 / 1024)) MB von $((MAX_TOTAL_BYTES / 1024 / 1024)) MB."
  return 0
}

# ===========================================================================
# Zweistufig: erst alles erzeugen, dann alles hochladen
# ===========================================================================
# Frueher wurde jedes Artefakt sofort nach dem Dump hochgeladen. Damit war die
# Gesamtgroesse des Laufs erst bekannt, wenn er schon halb beim Anbieter lag —
# und eine harte Obergrenze laesst sich so nicht einhalten, ohne mittendrin
# abzubrechen.
#
# Jetzt: Phase 1 erzeugt und verschluesselt alles lokal und misst dabei die
# echte Groesse. Phase 2 raeumt genau so viel weg, wie noetig ist, und laedt
# dann hoch. Kein Schaetzen, kein halb hochgeladener Lauf, keine Loeschung auf
# Verdacht.
STAGED="$WORK_DIR/staged.tsv"
: > "$STAGED"

# Verschluesselt und legt zum Upload bereit. $1=Quelldatei $2=Logischer Name
stage_artifact() {
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
  printf '%s\t%s\t%s\n' "$label" "$enc" "$size" >> "$STAGED"
  log "Bereit: $(basename "$enc") (${size} bytes)"
  return 0
}

# Legt die bereitgestellten Dateien lokal ab, ohne sie hochzuladen. Fuer den
# Fall, dass das Budget den Upload verbietet: die Sicherung ist dann wenigstens
# auf dem Server vorhanden, statt ersatzlos verworfen zu werden.
keep_staged_locally() {
  local status="$1" label enc size
  while IFS=$'\t' read -r label enc size; do
    [ -n "$label" ] || continue
    mv "$enc" "$BACKUP_DIR/" 2>/dev/null || true
    record_backup "$label" "$(basename "$enc")" "$size" "$status"
  done < "$STAGED"
}

# Phase 2: Platz schaffen (nur count-Modus), dann hochladen.
flush_uploads() {
  local gesamt
  gesamt=$(awk -F'\t' '{s+=$3} END {print s+0}' "$STAGED")
  [ "$gesamt" -gt 0 ] || { log "Nichts hochzuladen."; return 0; }
  log "Neuer Lauf: $((gesamt / 1024 / 1024)) MB in $(wc -l < "$STAGED" | tr -d ' ') Dateien."

  if [ "$RETENTION_MODE" = "count" ]; then
    # 1. Passt der Lauf ueberhaupt? Wenn nicht, bleibt ALLES wie es ist.
    if [ "$gesamt" -gt "$MAX_TOTAL_BYTES" ]; then
      fail "Der Lauf ($((gesamt / 1024 / 1024)) MB) passt nicht in das Budget von $((MAX_TOTAL_BYTES / 1024 / 1024)) MB"
      send_alert "Backup passt nicht ins Speicherbudget" \
"Der Lauf braucht $((gesamt / 1024 / 1024)) MB, BACKUP_MAX_TOTAL_BYTES liegt bei
$((MAX_TOTAL_BYTES / 1024 / 1024)) MB.

Es wurde NICHTS geloescht und NICHTS hochgeladen — der bisherige Bestand beim
Anbieter ist unveraendert erhalten. Ein halb hochgeladener Lauf, fuer den die
alten Kopien geopfert wurden, waere der schlechteste aller Ausgaenge.

Die Sicherung liegt lokal unter $BACKUP_DIR und ist NICHT off-site.

Moeglichkeiten:
  - BACKUP_MAX_TOTAL_BYTES anheben (kostet beim Anbieter Geld)
  - Datenmenge senken; meist ist der MinIO-Spiegel der groesste Posten:
      docker exec provisioning-agent mc du localminio"
      keep_staged_locally "upload_failed"
      return 1
    fi

    # 2. Auf KEEP_RUNS-1 alte Laeufe kuerzen — der neue kommt ja dazu.
    while [ "$(runs_count)" -gt $((KEEP_RUNS - 1)) ]; do
      delete_oldest_run || break
    done

    # 3. Platz schaffen, solange noch etwas zum Loeschen da ist. Der letzte
    #    verbliebene Lauf wird zuletzt geopfert — und nur, weil in Schritt 1
    #    bereits feststeht, dass der neue Lauf danach wirklich hineinpasst.
    while [ $((REMOTE_USED + gesamt)) -gt "$MAX_TOTAL_BYTES" ] && [ "$(runs_count)" -gt 0 ]; do
      delete_oldest_run || break
    done

    if [ $((REMOTE_USED + gesamt)) -gt "$MAX_TOTAL_BYTES" ]; then
      # Kann nach Schritt 1 eigentlich nicht eintreten. Wenn doch (eine
      # Loeschung ist fehlgeschlagen), lieber gar nicht hochladen.
      fail "Platz reicht trotz Aufraeumen nicht — Upload unterbleibt"
      keep_staged_locally "upload_failed"
      return 1
    fi

    if [ "$(runs_count)" -eq 0 ]; then
      log "HINWEIS: Nach diesem Lauf gibt es nur noch EINE Kopie beim Anbieter."
    fi
  fi

  local label enc size
  while IFS=$'\t' read -r label enc size; do
    [ -n "$label" ] || continue
    log "Upload $(basename "$enc") -> ${GENERATION:-/}"
    if rclone --config "$RCLONE_CONFIG_PATH" copy "$enc" "$REMOTE_TARGET/" --quiet; then
      mv "$enc" "$BACKUP_DIR/"
      record_backup "$label" "$(basename "$enc")" "$size" "ok"
      REMOTE_USED=$((REMOTE_USED + size))
    else
      fail "$label: Upload nach $REMOTE fehlgeschlagen"
      mv "$enc" "$BACKUP_DIR/" 2>/dev/null || true
      record_backup "$label" "$(basename "$enc")" "$size" "upload_failed"
    fi
  done < "$STAGED"
  return 0
}

# --- 0. Budget pruefen und Platz schaffen ---------------------------------
# Steht bewusst VOR jedem Dump: passt der Lauf nicht, soll das auffallen,
# bevor eine Stunde lang Daten gewaelzt werden.
if [ "$RETENTION_MODE" = "count" ]; then
  if ! preflight_budget; then
    log "Abbruch: Speicherbudget reicht nicht. Bestand unveraendert."
    exit 1
  fi
fi

# --- 1. Globals -----------------------------------------------------------
# P0-5(c): Rollen (authenticator_* mit Passwoertern, anon_*/authenticated_*/
# service_role_*) existieren nach einem Restore sonst nicht. Steht bewusst
# GANZ VORNE: ohne Globals ist jeder nachfolgende Dump wertlos.
log "Dumping Globals (Rollen)..."
if docker exec core-postgres pg_dumpall -U postgres --globals-only \
     | gzip > "$WORK_DIR/globals_${TIMESTAMP}.sql.gz"; then
  stage_artifact "$WORK_DIR/globals_${TIMESTAMP}.sql.gz" "globals"
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
    stage_artifact "$WORK_DIR/${db}_${TIMESTAMP}.dump" "$db"
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
  stage_artifact "$WORK_DIR/minio_${TIMESTAMP}.tar.gz" "minio"
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
  stage_artifact "$WORK_DIR/config_${TIMESTAMP}.tar.gz" "config"
else
  fail "Config-Archiv fehlgeschlagen"
  record_backup "config" "-" 0 "dump_failed"
fi

# --- 5. Hochladen ---------------------------------------------------------
# Erst hier verlaesst irgendetwas den Server. Vorher steht die exakte Groesse
# des Laufs fest, und genau darauf stuetzt sich die Budgetentscheidung.
flush_uploads || true

# --- 6. Retention ---------------------------------------------------------
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

if [ "$RETENTION_MODE" != "count" ]; then
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
else
  log "Speicherbelegung nach dem Lauf: $((REMOTE_USED / 1024 / 1024)) MB von $((MAX_TOTAL_BYTES / 1024 / 1024)) MB."
fi

# --- 7. Ergebnis ----------------------------------------------------------
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
