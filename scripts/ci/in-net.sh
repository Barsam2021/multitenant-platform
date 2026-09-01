#!/bin/bash
# Fuehrt einen Node-Befehl IN `traefik-net` aus, damit Tests die Dienste unter
# denselben Namen erreichen wie die Produktion (`pgbouncer`, `core-minio`) —
# statt ueber auf den Runner gemappte Ports, die mit vorinstallierten Diensten
# des Runner-Images kollidieren koennen.
#
#   scripts/ci/in-net.sh scripts/ci/run-tests.sh '\[P0\]' scripts/ci/security/
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"

# bookworm-slim statt alpine: die Testskripte sind bash (PIPESTATUS), und
# alpine bringt nur ash mit. Ein Kommentar DARF hier nicht zwischen den
# fortgesetzten Zeilen stehen - er wuerde den Rest des Befehls verschlucken.
docker run --rm \
  --network traefik-net \
  -v "$ROOT:/opt/multitenant-platform" \
  -v "$ROOT/provisioning-agent/templates:/app/templates:ro" \
  -w /opt/multitenant-platform \
  -e CI=true \
  -e PGBOUNCER_HOST=pgbouncer \
  -e ADMIN_DB_HOST=core-postgres \
  -e MASTER_DB_PASSWORD="${MASTER_DB_PASSWORD}" \
  -e MINIO_ROOT_USER="${MINIO_ROOT_USER}" \
  -e MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD}" \
  -e ENCRYPTION_MASTER_KEY="${ENCRYPTION_MASTER_KEY}" \
  -e CMS_ENCRYPTION_KEY="${CMS_ENCRYPTION_KEY}" \
  -e ANALYTICS_SALT="${ANALYTICS_SALT}" \
  -e PLATFORM_DOMAIN="${PLATFORM_DOMAIN}" \
  -e RESEND_API_KEY="" \
  -e CI_TENANT_A="${CI_TENANT_A}" \
  -e CI_TENANT_B="${CI_TENANT_B}" \
  -e CI_TENANT_A_PW="${CI_TENANT_A_PW}" \
  -e CI_TENANT_B_PW="${CI_TENANT_B_PW}" \
  -e CI_TENANT_A_JWT_SECRET="${CI_TENANT_A_JWT_SECRET}" \
  -e CI_TENANT_B_JWT_SECRET="${CI_TENANT_B_JWT_SECRET}" \
  node:20-bookworm-slim "$@"
