#!/bin/bash
# =============================================================================
# Notbremse. Der CI-Stack benutzt dieselben Container-Namen wie die Produktion
# (core-postgres, pgbouncer, core-minio) — hartkodiert im Agent-Code, deshalb
# nicht verhandelbar. Ein `docker compose -f docker-compose.ci.yml up` auf der
# Live-VPS wuerde die laufenden Container ueberschreiben.
#
# Dieses Skript steht deshalb VOR jedem CI-Skript, das Container startet.
# Es prueft drei unabhaengige Merkmale; eines reicht zum Abbruch.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
fail() { echo "ABBRUCH: $1" >&2; echo "Dieser Stack darf ausschliesslich in einem CI-Runner laufen." >&2; exit 1; }

# 1. Nur in einer CI-Umgebung. GitHub Actions setzt CI=true.
[ "${CI:-}" = "true" ] || fail "CI ist nicht 'true' (gefunden: '${CI:-<leer>}')."

# 2. Eine .env im Repo-Root gibt es nur auf einer echten Installation — sie ist
#    gitignored, ein frischer Checkout hat keine.
[ -f "$ROOT/.env" ] && fail "$ROOT/.env existiert. Das sieht nach einer echten Installation aus."

# 3. Laeuft hier bereits Plattform-Infrastruktur, ist es keine leere CI-Maschine.
if command -v docker >/dev/null 2>&1; then
  for name in global-traefik cloudflared provisioning-agent admin-dashboard uptime-kuma; do
    if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$name"; then
      fail "Container '$name' existiert auf diesem Host — das ist eine Plattform-Installation."
    fi
  done
fi

echo "[ci-guard] Umgebung ist ein leerer CI-Runner — Stack darf starten."
