#!/bin/bash
# =============================================================================
# Baut den isolierten CI-Stack auf. Ausschliesslich fuer GitHub-Runner.
# Reihenfolge ist nicht beliebig — jeder Schritt setzt den vorherigen voraus.
# =============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$ROOT"

bash scripts/ci/assert-not-production.sh

: "${MASTER_DB_PASSWORD:?scripts/ci/env.sh nicht gesourct}"

echo "--- 1/6 Kern-Dienste starten"
docker compose -f docker-compose.ci.yml up -d --wait --wait-timeout 180

echo "--- 2/6 Passwort fuer die PgBouncer-Auth-Rolle setzen"
# 18_pgbouncer_auth.sql legt die Rolle an, aber ohne Passwort — das kann eine
# SQL-Datei nicht, ohne es im Repo zu hinterlegen. In Produktion macht das
# bootstrap.sh, hier die CI.
docker exec -i core-postgres psql -U postgres -v ON_ERROR_STOP=1 -q -d postgres \
  -c "ALTER ROLE pgbouncer_auth PASSWORD '${PGBOUNCER_AUTH_PASSWORD}';"
# PgBouncer hat sich beim Start noch nicht anmelden koennen.
docker compose -f docker-compose.ci.yml restart pgbouncer
sleep 3

echo "--- 3/6 Plattform-Migrationen nachfahren (prueft zugleich ihre Idempotenz)"
# Die init-scripts liefen bereits beim Start des leeren Volumes. scripts/migrate.sh
# faehrt sie ein zweites Mal — laeuft das fehlerfrei durch, ist jede Migration
# wirklich idempotent. Genau das war vor P2-7 nicht gegeben (15_cleanup_orphaned_
# projects.sql war es nicht).
#
# migrate.sh und Teile des Agent-Codes erwarten den Pfad /opt/multitenant-platform
# hart. Statt eine CI-Variante der Skripte zu pflegen (die vom Original
# abdriftet), zeigt hier ein Symlink auf den Workspace — so laufen im CI exakt
# dieselben Skripte wie auf der VPS.
if [ ! -e /opt/multitenant-platform ]; then
  sudo ln -s "$ROOT" /opt/multitenant-platform
fi
bash /opt/multitenant-platform/scripts/migrate.sh

echo "--- 4/6 Testmandanten anlegen (echter Agent-Code)"
scripts/ci/in-net.sh node scripts/ci/provision-test-tenants.js

echo "--- 5/6 Testschema einspielen und Tenant-Dienste starten"
# VOR dem Start von PostgREST: sonst braucht es einen Schema-Reload (SIGUSR1),
# und der Test wuerde am Cache scheitern statt an der Sache.
docker exec -i core-postgres psql -U postgres -v ON_ERROR_STOP=1 -q \
  -d "kunde_${CI_TENANT_A}" < scripts/ci/fixtures/tenant-schema.sql
docker compose -f "kunden-instances/${CI_TENANT_A}/docker-compose.yml" up -d

echo "--- 6/6 Auf GoTrue warten"
for i in $(seq 1 45); do
  if docker run --rm --network traefik-net curlimages/curl:8.11.1 \
       -fsS --max-time 3 "http://auth-${CI_TENANT_A}:9999/health" >/dev/null 2>&1; then
    echo "GoTrue bereit."
    exit 0
  fi
  sleep 2
done
echo "GoTrue wurde nicht bereit — Logs:" >&2
docker logs "auth-${CI_TENANT_A}" 2>&1 | tail -40 >&2
exit 1
