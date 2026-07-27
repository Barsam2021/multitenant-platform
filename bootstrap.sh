#!/bin/bash
# bootstrap.sh — Bringt einen frischen Ubuntu/Debian-VPS komplett hoch.
# Konsolidiert 02_vps_bootstrap_guide.md + Provisioning-Agent- und Dashboard-Start.
# Idempotent: mehrfach ausführbar, überspringt bereits erledigte Schritte wo möglich.
#
# Nutzung:
#   git clone git@github.com:<user>/<repo>.git /opt/multitenant-platform
#   cd /opt/multitenant-platform
#   cp .env.example .env && nano .env   # ECHTE Werte eintragen!
#   sudo ./bootstrap.sh

set -euo pipefail

ROOT="/opt/multitenant-platform"
cd "$ROOT"

echo "==> [1/9] System-Pakete"
apt update && apt upgrade -y
apt install -y curl git ufw coreutils postgresql-client rclone unzip tree

echo "==> [2/9] Firewall (UFW)"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> [3/9] Docker Engine"
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
fi
usermod -aG docker "${SUDO_USER:-root}" || true

echo "==> [4/9] Verzeichnisstruktur + Docker-Netzwerk"
mkdir -p "$ROOT"/{traefik/dynamic,traefik/letsencrypt,core-postgres/init-scripts,core-postgres/pgbouncer,kunden-instances,deployments/{builds,apps},backups/files,monitoring/uptime-kuma,minio,cloudflared,provisioning-agent}
touch "$ROOT"/kunden-instances/.gitkeep "$ROOT"/deployments/builds/.gitkeep "$ROOT"/deployments/apps/.gitkeep "$ROOT"/backups/files/.gitkeep "$ROOT"/traefik/dynamic/.gitkeep
docker network inspect traefik-net >/dev/null 2>&1 || docker network create traefik-net

echo "==> [5/9] .env prüfen"
if [ ! -f "$ROOT/.env" ]; then
  echo "FEHLER: $ROOT/.env fehlt. Kopiere .env.example nach .env und trage echte Werte ein:"
  echo "  cp .env.example .env && nano .env"
  exit 1
fi
set -a
source "$ROOT/.env"
set +a

echo "==> [6/9] Rollen-Init-Script (falls noch nicht vorhanden)"
if [ ! -f "$ROOT/core-postgres/init-scripts/01_roles.sql" ]; then
  echo "WARNUNG: 01_roles.sql fehlt unter core-postgres/init-scripts/ — bitte manuell ergänzen (siehe 02_vps_bootstrap_guide.md Step 6)."
fi

echo "==> [7/9] Core-Infrastruktur starten (Traefik, Postgres+PgBouncer, MinIO, Uptime-Kuma, Cloudflared)"
for svc in traefik core-postgres minio monitoring/uptime-kuma cloudflared; do
  if [ -f "$ROOT/$svc/docker-compose.yml" ]; then
    echo "  -> $svc"
    (cd "$ROOT/$svc" && docker compose up -d)
  else
    echo "  -> $svc: docker-compose.yml fehlt, übersprungen"
  fi
done

echo "==> [8/9] Provisioning Agent (Symlink auf zentrale .env sicherstellen)"
ln -sf "$ROOT/.env" "$ROOT/provisioning-agent/.env"
if [ -f "$ROOT/provisioning-agent/docker-compose.yml" ]; then
  (cd "$ROOT/provisioning-agent" && docker compose up -d --build)
fi

echo "==> [9/9] Dashboard"
ln -sf "$ROOT/.env" "$ROOT/dashboard/.env" 2>/dev/null || true
if [ -f "$ROOT/dashboard/docker-compose.yml" ]; then
  (cd "$ROOT/dashboard" && docker compose up -d --build)
fi

echo ""
echo "=================================================================="
echo "Bootstrap abgeschlossen. Health-Check:"
echo "  docker exec provisioning-agent wget -qO- --header=\"X-Agent-Secret: \$PROVISIONING_AGENT_SECRET\" http://localhost:3001/health"
echo ""
echo "Falls noch nicht geschehen:"
echo "  - Cloudflare Tunnel Ingress-Rules für admin.<domain> / status.<domain> einrichten"
echo "  - 01_roles.sql prüfen (core-postgres/init-scripts/)"
echo "  - Rclone-Remote für Hetzner Storage Box konfigurieren (rclone config)"
echo "  - Backup-Cron einrichten (siehe 04_backup_system.md § 5)"
echo "=================================================================="
