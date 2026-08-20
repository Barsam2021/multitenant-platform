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
# age gehoert zwingend dazu: dieses Skript installiert weiter unten den
# Backup-Cron, und backup-script.sh verschluesselt damit JEDE Sicherung, bevor
# sie den Server verlaesst. Fehlte age, lief der Cron zwar an, scheiterte aber
# jede Nacht an der Verschluesselung — mit dem Ergebnis, dass ueberhaupt keine
# Off-Site-Sicherung entsteht.
apt install -y curl git ufw coreutils postgresql-client rclone age unzip tree

# In aelteren Distributionen ist age nicht paketiert. Dann das offizielle
# Binary nachziehen, statt den Backup-Cron ohne Verschluesselung zu lassen.
if ! command -v age &>/dev/null; then
  echo "==> age nicht im Paketindex — installiere offizielles Binary"
  AGE_VERSION="v1.2.1"
  curl -sSL "https://github.com/FiloSottile/age/releases/download/${AGE_VERSION}/age-${AGE_VERSION}-linux-amd64.tar.gz" \
    | tar -xz -C /tmp \
    && install -m 0755 /tmp/age/age /usr/local/bin/age \
    && install -m 0755 /tmp/age/age-keygen /usr/local/bin/age-keygen \
    && rm -rf /tmp/age
fi

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
# Vor Traefik: der websecure-Entrypoint referenziert public-ratelimit@file.
"$ROOT/scripts/write-ratelimit.sh" "$ROOT" || echo "  -> WARN: Rate-Limit-Middlewares nicht geschrieben"
for svc in traefik core-postgres minio monitoring/uptime-kuma cloudflared; do
  if [ -f "$ROOT/$svc/docker-compose.yml" ]; then
    echo "  -> $svc"
    (cd "$ROOT/$svc" && docker compose --env-file "$ROOT/.env" up -d)
  else
    echo "  -> $svc: docker-compose.yml fehlt, übersprungen"
  fi
done

echo "==> [8/9] Provisioning Agent"
if [ -f "$ROOT/provisioning-agent/docker-compose.yml" ]; then
  (cd "$ROOT/provisioning-agent" && docker compose --env-file "$ROOT/.env" up -d --build)
fi

echo "==> [9/9] Dashboard"
if [ -f "$ROOT/dashboard/docker-compose.yml" ]; then
  (cd "$ROOT/dashboard" && docker compose --env-file "$ROOT/.env" up -d --build)
fi

# CMS-Dienst (Endkunden-Redaktion). Nur starten, wenn er auch konfiguriert ist —
# ohne CMS_DATABASE_URL/CMS_ENCRYPTION_KEY/CMS_SESSION_SECRET wuerde der
# Container beim ersten Request abbrechen, und ein CMS ist fuer viele
# Installationen schlicht nicht noetig.
if [ -f "$ROOT/cms/docker-compose.yml" ]; then
  if [ -n "${CMS_DATABASE_URL:-}" ] && [ -n "${CMS_ENCRYPTION_KEY:-}" ] && [ -n "${CMS_SESSION_SECRET:-}" ]; then
    echo "==> CMS-Dienst"
    (cd "$ROOT/cms" && docker compose --env-file "$ROOT/.env" up -d --build)
  else
    echo "==> CMS-Dienst: nicht konfiguriert (CMS_* in .env fehlen), uebersprungen — siehe SETUP.md"
  fi
fi

# P0-5: Backup-Cron gehoert ins Setup, nicht in die Doku. Ein Backup, das
# niemand einrichtet, ist kein Backup.
if [ -f "$ROOT/backups/cron.d-multitenant-backup" ]; then
  echo "==> Backup-Cron installieren"
  install -m 0644 "$ROOT/backups/cron.d-multitenant-backup" /etc/cron.d/multitenant-backup
  touch /var/log/mt-backup.log
  systemctl reload cron 2>/dev/null || service cron reload 2>/dev/null || true
fi

echo ""
echo "=================================================================="
echo "Bootstrap abgeschlossen. Health-Check:"
echo "  docker exec provisioning-agent wget -qO- --header=\"X-Agent-Secret: \$PROVISIONING_AGENT_SECRET\" http://localhost:3001/health"
echo ""
echo "Falls noch nicht geschehen:"
echo "  - Cloudflare Tunnel Ingress-Rules für admin.<domain> / status.<domain> einrichten"
echo "  - 01_roles.sql prüfen (core-postgres/init-scripts/)"
echo "  - Rclone-Remote für dein Backup-Storage konfigurieren (rclone config)"
echo "  - DR-Bundle (age-Key + .env) OFF-SITE kopieren — ohne das ist kein Restore moeglich"
echo "=================================================================="
