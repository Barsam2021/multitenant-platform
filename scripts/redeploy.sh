#!/usr/bin/env bash
# redeploy.sh — Repo-Stand ausrollen und den Stack neu starten.
#
# Gedacht fuer genau den Ablauf "neuen Branch testen": auf den Branch wechseln,
# Migrationen nachziehen, die selbstgebauten Dienste neu bauen und neu starten,
# danach sagen, was laeuft und was nicht.
#
#   ./scripts/redeploy.sh                       # aktuellen Branch neu ausrollen
#   ./scripts/redeploy.sh <branch>              # auf Branch wechseln, dann ausrollen
#   ./scripts/redeploy.sh --all <branch>        # zusaetzlich Traefik/Postgres/MinIO hart neu starten
#   ./scripts/redeploy.sh --init-cms            # fehlende CMS-Konfiguration erzeugen
#   ./scripts/redeploy.sh --status              # nur nachsehen, nichts anfassen
#   ./scripts/redeploy.sh --skip-git <branch>   # lokalen Stand nehmen, nicht ziehen
#
# Unterschied zu bootstrap.sh: das ist die ERSTinstallation (Verzeichnisse,
# Netzwerk, Cron). Dieses Skript setzt eine laufende Installation voraus und
# bringt sie auf einen neuen Code-Stand.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH=""
RESTART_INFRA=0
SKIP_GIT=0
STATUS_ONLY=0
INIT_CMS=0
FORCE=0
WARNINGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --all)       RESTART_INFRA=1 ;;
    --skip-git)  SKIP_GIT=1 ;;
    --status)    STATUS_ONLY=1 ;;
    --init-cms)  INIT_CMS=1 ;;
    --force)     FORCE=1 ;;
    -h|--help)   sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*)          echo "Unbekannte Option: $1" >&2; exit 1 ;;
    *)           BRANCH="$1" ;;
  esac
  shift
done

say()  { echo ""; echo "==> $*"; }
ok()   { echo "    OK   $*"; }
info() { echo "         $*"; }
warn() { echo "    WARN $*"; WARNINGS+=("$*"); }
die()  { echo ""; echo "ABBRUCH: $*" >&2; exit 1; }

compose() {
  # $1 = Verzeichnis relativ zu ROOT, Rest = docker-compose-Argumente
  local dir="$1"; shift
  [ -f "$ROOT/$dir/docker-compose.yml" ] || { info "$dir: keine docker-compose.yml, uebersprungen"; return 0; }
  ( cd "$ROOT/$dir" && docker compose --env-file "$ROOT/.env" "$@" )
}

psql_admin() {
  docker exec -i core-postgres psql -U postgres -tAq -d admin_dashboard -c "$1" 2>/dev/null
}

# ---------------------------------------------------------------- Vorpruefung

say "Vorpruefung"
[ -f "$ROOT/.env" ] || die ".env fehlt unter $ROOT — das hier ist kein eingerichtetes Setup (siehe bootstrap.sh)."
docker info >/dev/null 2>&1 || die "Docker-Daemon nicht erreichbar. Laeuft das Skript auf dem Server?"
command -v openssl >/dev/null 2>&1 || warn "openssl fehlt — --init-cms kann keine Schluessel erzeugen"
set -a; . "$ROOT/.env"; set +a
ok "Docker laeuft, .env geladen"

# Der Agent schreibt Tenant-Compose-Dateien nach /opt/multitenant-platform
# (fest verdrahtet, siehe lib/tenantDatabase.ts). Liegt das Repo woanders,
# stimmen die Pfade unten nicht mit denen des Agents ueberein.
TENANT_ROOT="/opt/multitenant-platform/kunden-instances"
if [ "$ROOT" != "/opt/multitenant-platform" ]; then
  warn "Repo liegt unter $ROOT, der Agent erwartet /opt/multitenant-platform — Tenant-Pfade koennen abweichen"
  [ -d "$TENANT_ROOT" ] || TENANT_ROOT="$ROOT/kunden-instances"
fi

# ------------------------------------------------------------------- Status

show_status() {
  say "Container"
  docker ps --format 'table {{.Names}}\t{{.Status}}' \
    | grep -E 'NAMES|traefik|postgres|pgbouncer|minio|kuma|cloudflared|provisioning-agent|admin-dashboard|^cms|api-|auth-|app-' \
    || true

  say "Health"
  local agent_health
  agent_health=$(docker exec provisioning-agent curl -s -m 5 \
    -H "X-Agent-Secret: ${PROVISIONING_AGENT_SECRET:-}" \
    http://localhost:3001/health 2>/dev/null)
  case "$agent_health" in
    *'"status":"ok"'*) ok "Provisioning Agent" ;;
    *)                 warn "Provisioning Agent antwortet nicht (${agent_health:-keine Antwort})" ;;
  esac

  if docker ps --format '{{.Names}}' | grep -qx admin-dashboard; then
    if docker exec admin-dashboard node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
      ok "Dashboard"
    else
      warn "Dashboard antwortet nicht"
    fi
  else
    warn "Dashboard-Container laeuft nicht"
  fi

  if docker ps --format '{{.Names}}' | grep -qx cms; then
    if docker exec cms node -e "fetch('http://127.0.0.1:3002/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
      ok "CMS-Dienst"
    else
      warn "CMS-Container laeuft, antwortet aber nicht — docker logs cms"
    fi
  else
    info "CMS-Dienst laeuft nicht (optional, siehe --init-cms)"
  fi

  say "Migrationen"
  local applied
  applied=$(docker exec -i core-postgres psql -U postgres -tAq -d postgres \
    -c "SELECT count(*) FROM public.schema_migrations" 2>/dev/null)
  local onDisk
  onDisk=$(find "$ROOT/core-postgres/init-scripts" -name '*.sql' 2>/dev/null | wc -l)
  info "angewendet: ${applied:-?} von ${onDisk} Dateien"
  if [ -n "${applied:-}" ] && [ "$applied" -lt "$onDisk" ]; then
    warn "Es liegen $((onDisk - applied)) nicht angewendete Migrationen vor — ./scripts/migrate.sh"
  fi
}

if [ "$STATUS_ONLY" -eq 1 ]; then
  show_status
  echo ""
  [ ${#WARNINGS[@]} -eq 0 ] && echo "Alles unauffaellig." || printf 'Offen: %s\n' "${WARNINGS[@]}"
  exit 0
fi

# ---------------------------------------------------------------------- Git

if [ "$SKIP_GIT" -eq 0 ]; then
  say "Repo aktualisieren"
  if [ -n "$(git -C "$ROOT" status --porcelain)" ] && [ "$FORCE" -eq 0 ]; then
    git -C "$ROOT" status --short
    die "Arbeitsverzeichnis hat lokale Aenderungen. Erst committen/verwerfen — oder --force, wenn sie egal sind."
  fi
  git -C "$ROOT" fetch --prune origin || die "git fetch fehlgeschlagen"
  if [ -n "$BRANCH" ]; then
    git -C "$ROOT" checkout "$BRANCH" || die "Branch '$BRANCH' nicht gefunden"
  fi
  BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
  # --ff-only: ein Merge-Konflikt mitten im Deploy ist das Letzte, was man will.
  git -C "$ROOT" pull --ff-only origin "$BRANCH" || warn "git pull --ff-only fehlgeschlagen (Branch nur lokal? divergiert?)"
  ok "Branch $BRANCH auf $(git -C "$ROOT" rev-parse --short HEAD)"
else
  BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
  info "Git uebersprungen — Stand: $BRANCH @ $(git -C "$ROOT" rev-parse --short HEAD)"
fi

# -------------------------------------------------------------- Infrastruktur

say "Infrastruktur"
for svc in traefik core-postgres minio monitoring/uptime-kuma cloudflared; do
  if [ "$RESTART_INFRA" -eq 1 ]; then
    # Bewusst nur auf Wunsch: core-postgres neu zu starten trennt JEDE
    # Tenant-Verbindung, und Traefik neu zu starten heisst ein paar Sekunden
    # ohne Reverse Proxy fuer alle Kundenseiten.
    compose "$svc" up -d --force-recreate && ok "$svc neu gestartet" || warn "$svc: Neustart fehlgeschlagen"
  else
    compose "$svc" up -d >/dev/null 2>&1 && ok "$svc laeuft" || warn "$svc: konnte nicht gestartet werden"
  fi
done

# Postgres muss bereit sein, bevor Migrationen laufen — nach einem
# --force-recreate dauert das ein paar Sekunden.
say "Warte auf Postgres"
for i in $(seq 1 30); do
  if docker exec core-postgres pg_isready -U postgres >/dev/null 2>&1; then
    ok "Postgres bereit"
    break
  fi
  [ "$i" -eq 30 ] && warn "Postgres nach 60s nicht bereit — Migrationen werden vermutlich scheitern"
  sleep 2
done

# ------------------------------------------------------------------ CMS-Setup

if [ "$INIT_CMS" -eq 1 ]; then
  say "CMS-Konfiguration ergaenzen"
  cp "$ROOT/.env" "$ROOT/.env.bak-$(date +%Y%m%d%H%M%S)"
  info "Sicherung der .env angelegt"

  add_env() {
    # Nur ergaenzen, nie ueberschreiben — ein vorhandener Schluessel gehoert
    # nicht angefasst, sonst sind alle damit verschluesselten Werte tot.
    local key="$1" value="$2"
    if grep -q "^${key}=" "$ROOT/.env"; then
      info "$key ist bereits gesetzt, bleibt unveraendert"
      return 1
    fi
    printf '%s=%s\n' "$key" "$value" >> "$ROOT/.env"
    ok "$key erzeugt und in .env eingetragen"
    return 0
  }

  grep -q '^# --- CMS ' "$ROOT/.env" || printf '\n# --- CMS (von scripts/redeploy.sh --init-cms ergaenzt) ---\n' >> "$ROOT/.env"

  add_env CMS_ENCRYPTION_KEY "$(openssl rand -hex 32)" || true
  add_env CMS_SESSION_SECRET "$(openssl rand -hex 32)" || true

  if ! grep -q '^CMS_DATABASE_URL=' "$ROOT/.env"; then
    CMS_DB_PW="$(openssl rand -hex 24)"
    if psql_admin "ALTER ROLE cms_config WITH PASSWORD '$CMS_DB_PW';" >/dev/null; then
      add_env CMS_DATABASE_URL "postgres://cms_config:${CMS_DB_PW}@${ADMIN_DB_HOST:-core-postgres}:5432/admin_dashboard" || true
    else
      warn "Rolle cms_config existiert noch nicht — erst ./scripts/migrate.sh (Migration 22), dann --init-cms erneut."
    fi
  else
    info "CMS_DATABASE_URL ist bereits gesetzt, bleibt unveraendert"
  fi

  add_env MEDIA_PUBLIC_BASE_URL "https://media.${PLATFORM_DOMAIN:-example.com}" || true

  # Traefik-Router fuer die Medien-Auslieferung. Der CMS-Router selbst steckt
  # als Label im cms/docker-compose.yml; dieser hier zeigt auf MinIO und muss
  # deshalb eine Datei sein.
  MEDIA_ROUTER="$ROOT/traefik/dynamic/media.yml"
  if [ -f "$MEDIA_ROUTER" ]; then
    info "traefik/dynamic/media.yml existiert bereits"
  else
    mkdir -p "$ROOT/traefik/dynamic"
    cat > "$MEDIA_ROUTER" <<EOF
# Automatisch erzeugt von scripts/redeploy.sh --init-cms.
# Liefert die MinIO-Buckets der Kunden aus. Oeffentlich lesbar ist
# ausschliesslich das Praefix public/ (Policy setzt der Provisioning Agent beim
# Aktivieren des CMS pro Kunde).
http:
  routers:
    media:
      rule: "Host(\`media.${PLATFORM_DOMAIN:-example.com}\`)"
      entryPoints:
        - websecure
      service: media-svc
      tls:
        certResolver: myresolver
  services:
    media-svc:
      loadBalancer:
        servers:
          - url: "http://core-minio:9000"
EOF
    ok "traefik/dynamic/media.yml angelegt (media.${PLATFORM_DOMAIN:-example.com})"
  fi

  set -a; . "$ROOT/.env"; set +a
fi

# ---------------------------------------------------------------- Migrationen

say "Migrationen"
if [ -x "$ROOT/scripts/migrate.sh" ]; then
  "$ROOT/scripts/migrate.sh" || warn "migrate.sh meldet einen Fehler — Ausgabe oben pruefen"
else
  warn "scripts/migrate.sh fehlt oder ist nicht ausfuehrbar"
fi

# --------------------------------------------------------- Eigene Dienste neu

# Diese drei tragen den Code aus dem Branch — immer neu bauen und neu starten,
# auch wenn Compose keine Aenderung sieht (die steckt im Image-Inhalt, nicht in
# der Compose-Datei).
say "Provisioning Agent neu bauen"
compose provisioning-agent up -d --build --force-recreate && ok "provisioning-agent" || warn "provisioning-agent: Build/Start fehlgeschlagen"

say "Dashboard neu bauen"
compose dashboard up -d --build --force-recreate && ok "admin-dashboard" || warn "dashboard: Build/Start fehlgeschlagen"

say "CMS-Dienst"
if [ -n "${CMS_DATABASE_URL:-}" ] && [ -n "${CMS_ENCRYPTION_KEY:-}" ] && [ -n "${CMS_SESSION_SECRET:-}" ]; then
  compose cms up -d --build --force-recreate && ok "cms" || warn "cms: Build/Start fehlgeschlagen"
else
  info "nicht konfiguriert (CMS_DATABASE_URL / CMS_ENCRYPTION_KEY / CMS_SESSION_SECRET fehlen)"
  info "einmalig einrichten:  ./scripts/redeploy.sh --init-cms"
fi

# ------------------------------------------------------- Tenants und Kunden-Apps

say "Tenant-Instanzen"
# Nur die hochfahren, die auch laufen SOLLEN: seit Migration 19 ist die
# Datenbank-Ebene abschaltbar, und ein pauschales `compose up` wuerde die
# bewusst abgeschalteten Container wieder zurueckholen.
ENABLED_TENANTS=$(psql_admin "SELECT slug FROM kunden WHERE db_enabled AND db_provisioned AND status = 'active' ORDER BY slug")
if [ -z "$ENABLED_TENANTS" ]; then
  info "keine Tenants mit aktiver Datenbank"
else
  for slug in $ENABLED_TENANTS; do
    dir="$TENANT_ROOT/$slug"
    if [ -f "$dir/docker-compose.yml" ]; then
      ( cd "$dir" && docker compose up -d >/dev/null 2>&1 ) && ok "$slug (api/auth)" || warn "$slug: Tenant-Container nicht gestartet"
    else
      warn "$slug: docker-compose.yml fehlt unter $TENANT_ROOT/"
    fi
  done
fi

say "Kunden-Apps neu starten"
# Die laufen nicht ueber Compose, sondern werden vom Agent per `docker run`
# gestartet (siehe lib/deploy.ts). Ein Neustart reicht — neu gebaut wird nur
# ueber ein Deployment, nicht hier.
APPS=$(docker ps -a --format '{{.Names}}' | grep -E '^app-[a-z0-9-]+$' || true)
if [ -z "$APPS" ]; then
  info "keine Kunden-App-Container vorhanden"
else
  for app in $APPS; do
    docker restart "$app" >/dev/null 2>&1 && ok "$app" || warn "$app: Neustart fehlgeschlagen"
  done
fi

# ------------------------------------------------------------------ Abschluss

sleep 5
show_status

say "Fertig — Stand: $BRANCH @ $(git -C "$ROOT" rev-parse --short HEAD)"
echo ""
# Das Dashboard haengt am Cloudflare Tunnel, seine Adresse steht in der
# Cloudflare-Konfiguration und nicht in der .env — deshalb hier kein Link.
echo "  Dashboard:  ueber den Cloudflare Tunnel (Adresse siehe Zero Trust Dashboard)"
if [ -n "${CMS_DATABASE_URL:-}" ]; then
  echo "  CMS:        https://cms.${PLATFORM_DOMAIN:-example.com}/<kunden-slug>"
  echo "  Medien:     ${MEDIA_PUBLIC_BASE_URL:-nicht gesetzt}"
fi
echo ""
if [ ${#WARNINGS[@]} -eq 0 ]; then
  echo "Keine Warnungen."
  exit 0
fi
echo "${#WARNINGS[@]} Warnung(en):"
printf '  - %s\n' "${WARNINGS[@]}"
echo ""
echo "Logs bei Bedarf:  docker logs --tail 50 provisioning-agent | admin-dashboard | cms"
exit 1
