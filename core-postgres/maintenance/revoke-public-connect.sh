#!/usr/bin/env bash
# P0-2a (Audit 0430f9c): CONNECT auf allen Tenant-DBs von PUBLIC entziehen.
#
# Warum kein init-script unter core-postgres/init-scripts/: der Vorgang muss
# ueber eine zur Laufzeit unbekannte Menge von Datenbanken iterieren. Eine
# statische .sql-Datei kann die DB nicht wechseln (kein \c in DO-Bloecken).
#
# Idempotent — beliebig oft ausfuehrbar. Neue Tenants brauchen das nicht mehr,
# die bekommen REVOKE/GRANT direkt in src/index.ts beim Provisioning.
set -euo pipefail
PSQL="docker exec -i core-postgres psql -U postgres -v ON_ERROR_STOP=1 -tAq"

DBS=$($PSQL -c "SELECT datname FROM pg_database WHERE datname LIKE 'kunde_%';")

for db in $DBS; do
  slug="${db#kunde_}"
  role="authenticator_${slug}"

  if ! $PSQL -c "SELECT 1 FROM pg_roles WHERE rolname = '${role}';" | grep -q 1; then
    echo "  WARNUNG: $db hat keine Rolle $role — uebersprungen (verwaiste DB?)"
    continue
  fi

  $PSQL -c "REVOKE ALL ON DATABASE \"${db}\" FROM PUBLIC;"
  # TEMPORARY mitgeben: Session-lokal, kein Isolationsrisiko, verhindert aber
  # einen Funktionsbruch, falls eine Tenant-Query je eine Temp-Tabelle braucht.
  $PSQL -c "GRANT CONNECT, TEMPORARY ON DATABASE \"${db}\" TO \"${role}\";"
  echo "  $db: PUBLIC entzogen, CONNECT nur noch fuer $role"
done

# admin_dashboard: nur der Superuser (Dashboard + Agent verbinden als postgres).
$PSQL -c "REVOKE ALL ON DATABASE admin_dashboard FROM PUBLIC;"
echo "  admin_dashboard: PUBLIC entzogen"
