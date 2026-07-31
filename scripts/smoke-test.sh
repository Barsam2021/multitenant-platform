#!/bin/bash
# scripts/smoke-test.sh — Phase 7 Go-Live-Check.
# Läuft komplett gegen den Provisioning Agent von INNERHALB des Containers heraus
# (der Agent ist nicht auf den Host published, nur /webhooks/* ist via Traefik öffentlich —
# siehe provisioning-agent/docker-compose.yml). Nutzung:
#
#   cd /opt/multitenant-platform
#   ./scripts/smoke-test.sh
#
# Räumt den Test-Tenant am Ende IMMER auf (auch bei Fehlschlag, via trap).
set -uo pipefail

ROOT="/opt/multitenant-platform"
set -a; source "$ROOT/.env"; set +a

TEST_SLUG="smoketest-$(date +%s | tail -c 6)"
FAILED=0
STEP=0

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
step() { STEP=$((STEP+1)); echo ""; echo "== [$STEP] $* =="; }
fail() { echo "FEHLER: $*" >&2; FAILED=1; }

agent() {
  # $1 = HTTP-Methode, $2 = Pfad, $3 = optionaler JSON-Body
  # curl statt wget: im Agent-Image (Dockerfile) ohnehin schon installiert, robuster
  # für explizite Methoden + Body als busybox-wget.
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    docker exec provisioning-agent curl -s -X "$method" \
      -H "X-Agent-Secret: $PROVISIONING_AGENT_SECRET" \
      -H "Content-Type: application/json" \
      -d "$body" \
      "http://localhost:3001$path"
  else
    docker exec provisioning-agent curl -s -X "$method" \
      -H "X-Agent-Secret: $PROVISIONING_AGENT_SECRET" \
      "http://localhost:3001$path"
  fi
}

cleanup() {
  step "Cleanup: Test-Tenant $TEST_SLUG entfernen"
  agent DELETE "/tenants/$TEST_SLUG" >/dev/null 2>&1 && log "Tenant entfernt." || log "Tenant war bereits weg oder Löschen fehlgeschlagen (manuell prüfen: docker ps | grep $TEST_SLUG)."
}
trap cleanup EXIT

step "Health-Check"
HEALTH=$(agent GET /health)
echo "$HEALTH" | grep -q '"status":"ok"' && log "OK: $HEALTH" || fail "Agent /health antwortet nicht wie erwartet: $HEALTH"

step "Tenant anlegen ($TEST_SLUG)"
CREATE_RES=$(agent POST /tenants "{\"tenantSlug\":\"$TEST_SLUG\",\"tariff\":\"starter\"}")
echo "$CREATE_RES" | grep -q '"status":"ok"' && log "OK: Tenant angelegt." || { fail "Tenant-Erstellung fehlgeschlagen: $CREATE_RES"; exit 1; }

step "Prüfen: Container laufen (api-$TEST_SLUG, auth-$TEST_SLUG)"
sleep 3
for c in "api-$TEST_SLUG" "auth-$TEST_SLUG"; do
  if docker ps --format '{{.Names}}' | grep -qx "$c"; then
    log "OK: $c läuft."
  else
    fail "$c läuft NICHT."
  fi
done

step "PostgREST-Endpoint erreichbar (intern, via docker exec)"
PGRST_CHECK=$(docker exec provisioning-agent curl -s -o /dev/null -w "HTTP %{http_code}" "http://api-$TEST_SLUG:3000/" 2>&1)
log "PostgREST-Antwort: $PGRST_CHECK"

step "Stats-Endpoint"
STATS=$(agent GET /stats)
echo "$STATS" | grep -q 'containers' && log "OK: /stats liefert Daten." || fail "/stats sieht falsch aus: $(echo "$STATS" | cut -c1-200)"

step "Audit-Log enthält tenant.create-Eintrag"
AUDIT=$(agent GET "/audit-logs?limit=20")
echo "$AUDIT" | grep -q "\"target\":\"$TEST_SLUG\"" && log "OK: Audit-Eintrag gefunden." || fail "Kein Audit-Eintrag für $TEST_SLUG gefunden (Phase 6 evtl. nicht sauber verdrahtet)."

if [ -n "${UPTIME_KUMA_URL:-}" ] && [ -n "${UPTIME_KUMA_USERNAME:-}" ]; then
  step "Monitoring konfiguriert — Projekt+Monitor-Flow testen"
  PROJ_RES=$(agent POST /projects "{\"tenantSlug\":\"$TEST_SLUG\",\"slug\":\"$TEST_SLUG\",\"repoUrl\":\"https://github.com/octocat/Hello-World.git\",\"repoProvider\":\"manual\"}")
  echo "$PROJ_RES" | grep -q '"status":"ok"' && log "OK: Projekt angelegt." || fail "Projekt-Erstellung fehlgeschlagen: $PROJ_RES"
  if echo "$PROJ_RES" | grep -q '"monitoring":{"registered":true'; then
    log "OK: Uptime-Kuma-Monitor automatisch registriert."
  else
    log "HINWEIS: Monitor nicht registriert — Antwort: $(echo "$PROJ_RES" | grep -o '"monitoring":{[^}]*}')"
  fi
else
  step "Monitoring nicht konfiguriert (UPTIME_KUMA_* fehlt in .env) — Test übersprungen"
fi

step "Secret-Rotation (JWT)"
ROTATE_RES=$(agent POST "/tenants/$TEST_SLUG/rotate-secret" '{"secret":"jwt"}')
echo "$ROTATE_RES" | grep -q '"status":"ok"' && log "OK: JWT-Secret rotiert." || fail "JWT-Rotation fehlgeschlagen: $ROTATE_RES"

step "Secret-Rotation (MinIO)"
ROTATE_MINIO_RES=$(agent POST "/tenants/$TEST_SLUG/rotate-secret" '{"secret":"minio"}')
echo "$ROTATE_MINIO_RES" | grep -q '"status":"ok"' && log "OK: MinIO-Secret rotiert." || fail "MinIO-Rotation fehlgeschlagen: $ROTATE_MINIO_RES"

step "Backup-Lauf anstoßen (nur wenn RCLONE_REMOTE_PATH gesetzt ist)"
if [ -n "${RCLONE_REMOTE_PATH:-}" ]; then
  BACKUP_RES=$(agent POST /backups/run)
  echo "$BACKUP_RES" | grep -q '"status":"started"' && log "OK: Backup gestartet (läuft im Hintergrund, siehe /backups für Ergebnis)." || fail "Backup-Start fehlgeschlagen: $BACKUP_RES"
else
  log "RCLONE_REMOTE_PATH nicht gesetzt — Backup-Test übersprungen."
fi

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "=================================================="
  echo "SMOKE-TEST: ALLE CHECKS OK"
  echo "=================================================="
  exit 0
else
  echo "=================================================="
  echo "SMOKE-TEST: MIT FEHLERN ABGESCHLOSSEN — siehe oben"
  echo "=================================================="
  exit 1
fi
