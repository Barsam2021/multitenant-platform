#!/bin/bash
# ============================================================================
# Backup-Verifikation. Liest nur, aendert per Default NICHTS.
#
#   ./backups/verify-backups.sh                     # Stufe 0-3, rein lesend
#   ./backups/verify-backups.sh --with-restore-test # zusaetzlich Stufe 2:
#                                                   # jede DB in eine Wegwerf-DB
#                                                   # <db>_restoretest einspielen
#
# Beantwortet die Frage, die weder backup-script.sh noch das Dashboard
# beantworten: sind die Dateien im Object Storage im Ernstfall benutzbar?
#
# Stufe 0  Schluessel + Scheduler   (ein falscher age-Key macht JEDES Backup
#                                    unbrauchbar, ohne dass irgendwo ein Fehler
#                                    auftaucht — deshalb steht das ganz vorne)
# Stufe 1  Remote-Inventar          (liegt pro Kategorie etwas Aktuelles da?)
# Stufe 2  DB-Restore               (nur mit --with-restore-test)
# Stufe 3  MinIO + Config           (entschluesseln und Inhalt pruefen — von
#                                    keinem anderen Skript je angefasst)
#
# NICHT abgedeckt: der Restore auf einer FREMDEN Maschine allein aus Remote +
# Off-Site-DR-Bundle. Das ist der einzige echte Beweis und bleibt Handarbeit,
# siehe docs/BACKUP-VERIFY-HANDOVER.md.
#
# Exit: 0 = alles gruen, 1 = Warnungen, 2 = kritischer Befund.
# ============================================================================
set -uo pipefail

ROOT="${MT_ROOT:-/opt/multitenant-platform}"
WITH_RESTORE_TEST=0
[ "${1:-}" = "--with-restore-test" ] && WITH_RESTORE_TEST=1

CRIT=0
WARN=0
FINDINGS=""

c_ok()   { echo "  [ OK ]  $*"; }
c_warn() { WARN=$((WARN+1)); FINDINGS="${FINDINGS}
  [WARN]  $*"; echo "  [WARN]  $*"; }
c_crit() { CRIT=$((CRIT+1)); FINDINGS="${FINDINGS}
  [KRIT]  $*"; echo "  [KRIT]  $*"; }
step()   { echo; echo "=== $* ==="; }

[ -f "$ROOT/.env" ] || { echo "FEHLER: $ROOT/.env fehlt. Falscher Host? (MT_ROOT setzen)"; exit 2; }
set -a
# shellcheck disable=SC1091
source "$ROOT/.env"
set +a

RCLONE_CONFIG_PATH="${RCLONE_CONFIG:-$ROOT/backups/rclone.conf}"
BACKUP_DIR="$ROOT/backups/files"

# Entschluesselte Backups enthalten .env und Kundendaten. Eigenes tmpdir mit
# 700, und beim Verlassen restlos weg — auch bei Ctrl-C.
TMP=$(mktemp -d /tmp/verify-backups.XXXXXX)
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT

echo "=================================================================="
echo " Backup-Verifikation  $(date '+%Y-%m-%d %H:%M:%S')"
echo " Root: $ROOT"
[ "$WITH_RESTORE_TEST" -eq 1 ] && echo " Modus: inkl. DB-Restore-Test (legt <db>_restoretest an und wieder weg)" \
                               || echo " Modus: rein lesend"
echo "=================================================================="

# --- Stufe 0: Werkzeuge, Schluessel, Scheduler ----------------------------
step "Stufe 0 — Werkzeuge, Schluessel, Scheduler"

for t in age age-keygen rclone docker; do
  command -v "$t" >/dev/null 2>&1 && c_ok "$t vorhanden" || c_crit "$t FEHLT — ohne das laeuft weder Backup noch Restore"
done

# Der wichtigste Einzelcheck: passt der Public Key in der .env zum privaten
# Identity-File? Wenn nicht, verschluesselt jedes Backup fehlerfrei gegen einen
# Schluessel, den niemand besitzt.
IDFILE="${BACKUP_AGE_IDENTITY_FILE:-}"
if [ -z "$IDFILE" ]; then
  c_crit "BACKUP_AGE_IDENTITY_FILE nicht in .env gesetzt"
elif [ ! -f "$IDFILE" ]; then
  c_crit "age-Identity fehlt: $IDFILE — Restore unmoeglich"
else
  PERM=$(stat -c%a "$IDFILE" 2>/dev/null || echo "?")
  [ "$PERM" = "600" ] || [ "$PERM" = "400" ] \
    && c_ok "age-Identity vorhanden (Rechte $PERM)" \
    || c_warn "age-Identity hat Rechte $PERM — sollte 600 sein: chmod 600 $IDFILE"

  DERIVED=$(age-keygen -y "$IDFILE" 2>/dev/null)
  if [ -z "$DERIVED" ]; then
    c_crit "Public Key laesst sich nicht aus $IDFILE ableiten — Datei defekt?"
  elif [ "$DERIVED" = "${BACKUP_AGE_PUBLIC_KEY:-}" ]; then
    c_ok "age-Keypair stimmt ueberein — Backups sind entschluesselbar"
  else
    c_crit "age-Keypair passt NICHT ZUSAMMEN. BACKUP_AGE_PUBLIC_KEY in .env gehoert"
    c_crit "  nicht zu $IDFILE. Alle bisherigen Backups sind unentschluesselbar."
    c_crit "  .env:      ${BACKUP_AGE_PUBLIC_KEY:-<leer>}"
    c_crit "  abgeleitet: $DERIVED"
  fi
fi

[ -n "${RCLONE_REMOTE_PATH:-}" ] && c_ok "RCLONE_REMOTE_PATH gesetzt: $RCLONE_REMOTE_PATH" \
                                 || c_crit "RCLONE_REMOTE_PATH fehlt — es gibt keine Off-Site-Kopie"
[ -f "$RCLONE_CONFIG_PATH" ] && c_ok "rclone.conf vorhanden" \
                             || c_crit "rclone.conf fehlt: $RCLONE_CONFIG_PATH"

if [ -f /etc/cron.d/multitenant-backup ]; then
  c_ok "Cron installiert: $(grep -E '^[0-9]' /etc/cron.d/multitenant-backup | head -1)"
else
  c_crit "/etc/cron.d/multitenant-backup fehlt — es laeuft KEIN automatisches Backup"
fi

if [ -f /var/log/mt-backup.log ]; then
  LOG_AGE_H=$(( ( $(date +%s) - $(stat -c%Y /var/log/mt-backup.log) ) / 3600 ))
  [ "$LOG_AGE_H" -lt 26 ] && c_ok "mt-backup.log zuletzt vor ${LOG_AGE_H}h geschrieben" \
                          || c_warn "mt-backup.log seit ${LOG_AGE_H}h unveraendert — laeuft der Cron?"
  grep -qi 'FEHLER' /var/log/mt-backup.log 2>/dev/null \
    && c_warn "mt-backup.log enthaelt FEHLER-Zeilen: tail -50 /var/log/mt-backup.log"
else
  c_warn "/var/log/mt-backup.log existiert nicht"
fi

# --- backups-Tabelle ------------------------------------------------------
step "Stufe 0b — Was die backups-Tabelle sagt"

psql_admin() { docker exec core-postgres psql -U postgres -d admin_dashboard -tAc "$1" 2>/dev/null; }

if ! docker exec core-postgres true 2>/dev/null; then
  c_crit "Container core-postgres nicht erreichbar — DB-Checks uebersprungen"
  DBS=""
else
  DBS=$(docker exec core-postgres psql -U postgres -tAc \
    "SELECT datname FROM pg_database WHERE datname = 'admin_dashboard' OR datname LIKE 'kunde_%';" 2>/dev/null)
  c_ok "Datenbanken auf dem Cluster: $(echo "$DBS" | wc -w)"

  NEWEST=$(psql_admin "SELECT coalesce(extract(epoch from now() - max(created_at))::bigint, -1) FROM backups WHERE status = 'ok';")
  if [ "${NEWEST:--1}" -lt 0 ]; then
    c_crit "Kein einziger erfolgreicher Backup-Eintrag in der Tabelle backups"
  else
    H=$(( NEWEST / 3600 ))
    [ "$H" -lt 26 ] && c_ok "Juengstes erfolgreiches Backup vor ${H}h" \
                    || c_crit "Juengstes erfolgreiches Backup ist ${H}h alt — RPO verletzt"
  fi

  BAD=$(psql_admin "SELECT count(*) FROM backups WHERE status <> 'ok' AND created_at > now() - interval '7 days';")
  [ "${BAD:-0}" -eq 0 ] && c_ok "Keine fehlgeschlagenen Backups in den letzten 7 Tagen" \
                        || c_warn "${BAD} fehlgeschlagene Backup-Eintraege in den letzten 7 Tagen"

  # Verdaechtig kleine Dumps: strukturell korrekt, aber leer faellt sonst nicht auf.
  psql_admin "SELECT db_name || ' (' || size_bytes || ' bytes)' FROM backups
              WHERE status = 'ok' AND size_bytes < 20480
                AND created_at > now() - interval '2 days';" | while read -r line; do
    [ -n "$line" ] && echo "  [WARN]  Auffaellig kleines Backup: $line"
  done

  # Deckt die letzte Nacht wirklich jede DB ab?
  for db in $DBS; do
    CNT=$(psql_admin "SELECT count(*) FROM backups WHERE db_name = '$db' AND status = 'ok' AND created_at > now() - interval '26 hours';")
    [ "${CNT:-0}" -gt 0 ] || c_crit "Keine Datenbank $db im Backup der letzten 26h"
  done
fi

# --- Stufe 1: Remote-Inventar ---------------------------------------------
step "Stufe 1 — Liegen die Dateien wirklich im Object Storage?"

REMOTE_LIST=""
if [ -n "${RCLONE_REMOTE_PATH:-}" ] && [ -f "$RCLONE_CONFIG_PATH" ]; then
  if REMOTE_LIST=$(rclone --config "$RCLONE_CONFIG_PATH" lsf "$RCLONE_REMOTE_PATH/" 2>&1); then
    c_ok "Remote erreichbar, $(echo "$REMOTE_LIST" | grep -c '\.age$') verschluesselte Dateien"
  else
    c_crit "Remote NICHT erreichbar: $(echo "$REMOTE_LIST" | head -2 | tr '\n' ' ')"
    REMOTE_LIST=""
  fi
fi

newest_for() {  # $1 = Label-Prefix -> juengster Dateiname im Remote
  echo "$REMOTE_LIST" | grep -E "^$1_[0-9]{8}-[0-9]{6}\." | sort | tail -1
}

if [ -n "$REMOTE_LIST" ]; then
  LABELS="globals minio config"
  for db in $DBS; do LABELS="$LABELS $db"; done
  for label in $LABELS; do
    FN=$(newest_for "$label")
    if [ -z "$FN" ]; then
      c_crit "Keine Datei fuer '$label' im Remote — diese Kategorie ist ungesichert"
      continue
    fi
    STAMP=$(echo "$FN" | grep -oE '[0-9]{8}-[0-9]{6}')
    EPOCH=$(date -d "${STAMP:0:4}-${STAMP:4:2}-${STAMP:6:2} ${STAMP:9:2}:${STAMP:11:2}:${STAMP:13:2}" +%s 2>/dev/null || echo 0)
    AGE_H=$(( ( $(date +%s) - EPOCH ) / 3600 ))
    [ "$EPOCH" -gt 0 ] && [ "$AGE_H" -lt 26 ] \
      && c_ok "$label: $FN (${AGE_H}h alt)" \
      || c_crit "$label: juengste Datei ist $FN — ${AGE_H}h alt"
  done
fi

if [ -d "$BACKUP_DIR" ]; then
  LOCAL_N=$(find "$BACKUP_DIR" -maxdepth 1 -name '*.age' | wc -l)
  c_ok "Lokale Kopien in backups/files: $LOCAL_N (Retention ${BACKUP_RETENTION_DAYS:-3} Tage)"
  [ "$LOCAL_N" -eq 0 ] && c_warn "Keine lokale Kopie vorhanden"
fi
[ -z "${BACKUP_REMOTE_RETENTION_DAYS:-}" ] \
  && c_warn "BACKUP_REMOTE_RETENTION_DAYS nicht gesetzt — Remote waechst unbegrenzt"

# --- Stufe 3: MinIO + Config entschluesseln -------------------------------
# Vor Stufe 2, weil billiger und weil es die Kategorien pruefr, die sonst NIE
# jemand anfasst.
step "Stufe 3 — MinIO- und Config-Archiv entschluesseln und hineinschauen"

# Setzt PROBE_LIST auf eine Datei mit dem tar-Inhaltsverzeichnis, oder "".
# Fortschritt geht bewusst ueber c_ok/c_crit direkt nach stdout — deshalb wird
# das Ergebnis ueber eine Variable zurueckgegeben und nicht ueber $( ).
PROBE_LIST=""
probe_archive() {  # $1 = Label
  local label="$1" fn plain
  PROBE_LIST=""
  fn=$(newest_for "$label")
  [ -n "$fn" ] || { c_warn "$label: keine Datei zum Pruefen"; return; }
  if ! rclone --config "$RCLONE_CONFIG_PATH" copy "$RCLONE_REMOTE_PATH/$fn" "$TMP/" --quiet 2>/dev/null; then
    c_crit "$label: Download von $fn fehlgeschlagen"; return
  fi
  plain="$TMP/${fn%.age}"
  if ! age -d -i "$IDFILE" -o "$plain" "$TMP/$fn" 2>/dev/null; then
    c_crit "$label: $fn laesst sich NICHT entschluesseln — Backup wertlos"; return
  fi
  c_ok "$label: entschluesselt ($(stat -c%s "$plain") bytes)"
  if ! tar tzf "$plain" >"$TMP/$label.list" 2>/dev/null; then
    c_crit "$label: Archiv defekt, tar kann es nicht lesen"; return
  fi
  c_ok "$label: Archiv lesbar, $(wc -l < "$TMP/$label.list") Eintraege"
  PROBE_LIST="$TMP/$label.list"
}

if [ -n "$REMOTE_LIST" ] && [ -n "$IDFILE" ] && [ -f "$IDFILE" ]; then
  probe_archive config
  if [ -n "$PROBE_LIST" ]; then
    grep -qE '(^|/)\.env$' "$PROBE_LIST" && c_ok "config: .env enthalten" \
                                          || c_crit "config: .env FEHLT im Archiv — ENCRYPTION_MASTER_KEY waere weg"
    grep -q 'acme.json' "$PROBE_LIST" && c_ok "config: acme.json (Let's-Encrypt-Zertifikate) enthalten" \
                                      || c_warn "config: acme.json nicht im Archiv"
    # Ist der Master-Key im gesicherten .env auch wirklich gefuellt? Ohne ihn
    # sind nach dem Restore alle Env-Vars und MinIO-Secrets unlesbar.
    CFG_TGZ=$(find "$TMP" -maxdepth 1 -name 'config_*.tar.gz' | head -1)
    if [ -n "$CFG_TGZ" ]; then
      tar xzf "$CFG_TGZ" -C "$TMP" .env 2>/dev/null || tar xzf "$CFG_TGZ" -C "$TMP" ./.env 2>/dev/null || true
    fi
    if [ -f "$TMP/.env" ]; then
      KEYLEN=$(grep -E '^ENCRYPTION_MASTER_KEY=' "$TMP/.env" | cut -d= -f2- | tr -d '"' | wc -c)
      [ "${KEYLEN:-0}" -gt 16 ] && c_ok "config: ENCRYPTION_MASTER_KEY im gesicherten .env gefuellt" \
                                || c_crit "config: ENCRYPTION_MASTER_KEY im gesicherten .env leer/zu kurz"
    else
      c_warn "config: .env liess sich nicht zum Pruefen entpacken"
    fi
  fi

  probe_archive minio
  if [ -n "$PROBE_LIST" ]; then
    FILES_N=$(grep -v '/$' "$PROBE_LIST" | wc -l)
    [ "${FILES_N:-0}" -gt 0 ] && c_ok "minio: $FILES_N Objekte im Archiv" \
                              || c_crit "minio: Archiv enthaelt nur Verzeichnisse, KEINE Kundendateien"
  fi
fi

# --- Stufe 2: DB-Restore-Test ---------------------------------------------
step "Stufe 2 — DB-Restore in Wegwerf-Datenbanken"

if [ "$WITH_RESTORE_TEST" -eq 0 ]; then
  echo "  uebersprungen (mit --with-restore-test einschalten)"
elif [ -z "$REMOTE_LIST" ]; then
  c_warn "uebersprungen — Remote nicht erreichbar"
else
  for db in $DBS; do
    FN=$(newest_for "$db")
    [ -n "$FN" ] || { c_crit "$db: keine Backup-Datei, Restore-Test unmoeglich"; continue; }
    echo "  --- $db ($FN)"
    OUT=$("$ROOT/backups/restore-test-script.sh" "$FN" 2>&1)
    RES=$(echo "$OUT" | grep -oE 'RESTORE_TEST_RESULT:[A-Z]+:[0-9]+(:[0-9]+)?' | tail -1)
    case "$RES" in
      RESTORE_TEST_RESULT:OK:*)
        TBL=$(echo "$RES" | cut -d: -f3); ROWS=$(echo "$RES" | cut -d: -f4)
        if [ "${ROWS:-0}" -eq 0 ]; then
          c_crit "$db: Restore lief, aber 0 Zeilen in $TBL Tabellen — leerer Dump"
        else
          c_ok "$db: $TBL Tabellen, $ROWS Zeilen wiederhergestellt"
        fi ;;
      *) c_crit "$db: Restore-Test fehlgeschlagen — $(echo "$OUT" | tail -3 | tr '\n' ' ')" ;;
    esac
  done
fi

# --- Ergebnis -------------------------------------------------------------
echo
echo "=================================================================="
if [ "$CRIT" -gt 0 ]; then
  echo " ROT — $CRIT kritische Befunde, $WARN Warnungen"
  echo "${FINDINGS}"
  echo
  echo " Ein kritischer Befund heisst: im Ernstfall kommst du nicht zurueck."
  RC=2
elif [ "$WARN" -gt 0 ]; then
  echo " GELB — $WARN Warnungen, nichts Kritisches"
  echo "${FINDINGS}"
  RC=1
else
  echo " GRUEN — alle Checks bestanden"
  RC=0
fi
echo
echo " Nicht geprueft: Restore auf einer fremden Maschine allein aus Remote +"
echo " Off-Site-DR-Bundle. Siehe docs/BACKUP-VERIFY-HANDOVER.md, Stufe 4."
echo "=================================================================="
exit $RC
