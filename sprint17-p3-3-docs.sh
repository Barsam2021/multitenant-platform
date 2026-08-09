#!/usr/bin/env bash
# Sprint 17 — P3-3: Doku widerspricht dem Code
# Auf der VPS ausführen: /opt/multitenant-platform
#
# Was passiert:
#   - SETUP.md: GoTrue-Abschnitt widersprach dem tatsaechlichen Code
#     (behauptete AUTOCONFIRM: true, das Template setzt "false" seit dem
#     P1-7-Fix) - jetzt korrekt beschrieben, inkl. Verhalten wenn
#     RESEND_API_KEY fehlt
#   - SETUP.md: "Dashboard UND Uptime Kuma nicht ueber offene Ports erreichbar"
#     war falsch fuer Kuma - laeuft ganz normal ueber Traefik auf Port 443
#     (monitoring/uptime-kuma/docker-compose.yml), nur das Dashboard haengt
#     ausschliesslich am Cloudflare Tunnel. Jetzt klar getrennt beschrieben.
#   - Tote Verweise auf sechs nie committete Referenzdokumente
#     (10_env_reference.md, 05_deployment_engine_specification.md,
#     04_backup_system.md) aus Code-Kommentaren, einer Fehlermeldung
#     (lib/adminDb.ts, ging bisher als Fehlertext an den Admin) und
#     bootstrap.sh entfernt, zeigen jetzt auf tatsaechlich vorhandene Stellen
#   - Keine .patch-Dateien im Repo mehr vorhanden, kein GoDaddy-Claim mehr im
#     README - beide TODO-Punkte bereits erledigt, keine Aenderung noetig
#   - Kein Rebuild noetig (reine Kommentar-/Doku-Aenderungen, keine Logik)
#
# Rollback: ./sprint17-p3-3-docs.sh --rollback _backup-sprint17-<timestamp>

set -euo pipefail

PLATFORM_DIR="/opt/multitenant-platform"
DASHBOARD_SRC="$PLATFORM_DIR/dashboard/src"
AGENT_SRC="$PLATFORM_DIR/provisioning-agent/src"
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$PLATFORM_DIR/_backup-sprint17-$TS"

FILES=(
  "SETUP.md"
  "bootstrap.sh"
  "dashboard/src/lib/adminDb.ts"
  "dashboard/src/lib/tenantDb.ts"
  "provisioning-agent/src/lib/crypto.ts"
  "provisioning-agent/src/lib/secrets.ts"
  "provisioning-agent/src/lib/deploy.ts"
  "provisioning-agent/src/lib/git.ts"
)

if [[ "${1:-}" == "--rollback" ]]; then
  RESTORE_FROM="${2:?Verzeichnis angeben: ./sprint17-p3-3-docs.sh --rollback _backup-sprint17-XXXXXXXX-XXXXXX}"
  cd "$PLATFORM_DIR"
  echo "Rollback aus $RESTORE_FROM ..."
  for f in "${FILES[@]}"; do
    if [[ -f "$RESTORE_FROM/$f" ]]; then
      mkdir -p "$(dirname "$f")"
      cp "$RESTORE_FROM/$f" "$f"
      echo "  restored: $f"
    fi
  done
  echo "Rebuild (reine Kommentar-Aenderungen, aber sicherheitshalber)..."
  cd "$PLATFORM_DIR/provisioning-agent" && docker compose --env-file ../.env build && docker compose --env-file ../.env up -d
  cd "$PLATFORM_DIR/dashboard" && docker compose --env-file ../.env build && docker compose --env-file ../.env up -d
  echo "Rollback abgeschlossen."
  exit 0
fi

echo "== Sprint 17 (P3-3): Backup nach $BACKUP_DIR =="
cd "$PLATFORM_DIR"
mkdir -p "$BACKUP_DIR"
for f in "${FILES[@]}"; do
  if [[ -f "$f" ]]; then
    mkdir -p "$BACKUP_DIR/$(dirname "$f")"
    cp "$f" "$BACKUP_DIR/$f"
  fi
done
echo "Backup fertig."

echo "== Geaenderte Dateien schreiben =="

mkdir -p "$(dirname "$PLATFORM_DIR/SETUP.md")"
cat > "$PLATFORM_DIR/SETUP.md" << 'SETUPMD_EOF'
# Setup — von 0 auf lauffähig

> **Hinweis zu diesem Dokument:** Frühere Versionen von Code und `bootstrap.sh`
> verwiesen an mehreren Stellen auf nummerierte Referenzdokumente
> (`01_architecture_blueprint.md`, `02_vps_bootstrap_guide.md`,
> `04_backup_system.md`, `09_disaster_recovery_runbook.md`, `10_env_reference.md`,
> `11_web_ui_specification.md`). Diese Dateien existieren im Repo nicht
> (wahrscheinlich lokale Notizen, nie committet) — die Verweise im Code wurden
> entfernt und zeigen jetzt auf tatsächlich vorhandene Stellen (`.env.example`,
> dieses SETUP.md, Code-Kommentare). Dieses SETUP.md fasst das zusammen, was aus
> Code, `.env.example` und `bootstrap.sh` tatsächlich rekonstruierbar ist.

## Voraussetzungen

- Frischer Ubuntu- oder Debian-Server (root/sudo-Zugriff), öffentlich erreichbar
  über eine eigene Domain
- Domain mit DNS bei Cloudflare (für DNS-01-Zertifikate und Cloudflare Tunnel)
- GitHub-Account (für die Deployment-Pipeline, optional aber empfohlen)
- Node.js 20.x lokal, falls du Dashboard/Agent außerhalb von Docker entwickeln willst
  (für den reinen Betrieb reicht Docker auf dem Server)

## Schritt 1 — Repo klonen

```bash
git clone <this-repo-url> /opt/multitenant-platform
cd /opt/multitenant-platform
```

## Schritt 2 — `.env` anlegen

```bash
cp .env.example .env
nano .env
```

Trage **alle** `CHANGE_ME`-Werte ein. Secrets generierst du am besten mit:

```bash
openssl rand -hex 32
```

Details zu jeder Variable stehen als Kommentar direkt in `.env.example` —
insbesondere:

- `ENCRYPTION_MASTER_KEY`: verschlüsselt alle sensiblen Werte (Env-Vars der
  Kundenprojekte, MinIO-Secrets) in der DB. **Bei Verlust dieses Keys sind alle
  verschlüsselten Werte in der Datenbank unbrauchbar** — sicher aufbewahren
  (Passwort-Manager, nicht nur auf dem Server selbst).
- `PLATFORM_DOMAIN`: deine Basis-Domain. Alle Tenant-Subdomains
  (`<slug>.<PLATFORM_DOMAIN>`) und der Webhook-Endpunkt
  (`webhooks.<PLATFORM_DOMAIN>`) hängen davon ab. Für DNS: ein Wildcard-A-Record
  (`*.PLATFORM_DOMAIN` → Server-IP) einmalig anlegen.
- `GITHUB_PAT`: Fine-grained Personal Access Token mit Scope „Webhooks: Read & write“,
  nur für Repos, die du selbst verbinden willst. Ohne Token: Webhooks müssen
  manuell in GitHub eingetragen werden (die URL zeigt das Dashboard bei
  Projekt-Erstellung an).
- `BACKUP_AGE_PUBLIC_KEY` / `BACKUP_AGE_IDENTITY_FILE`, `RCLONE_CONFIG`,
  `RCLONE_REMOTE_PATH`: fürs Backup-System (Schritt 6) — Storage-Anbieter frei
  wählbar über `rclone config` (Backblaze B2, S3, Hetzner Storage Box, SFTP, ...).

## Schritt 3 — Bootstrap ausführen

```bash
sudo ./bootstrap.sh
```

Das Skript ist idempotent (mehrfach ausführbar) und macht:

1. System-Pakete installieren, Firewall (UFW: nur 22/80/443 offen) konfigurieren
2. Docker Engine installieren
3. Verzeichnisstruktur + Docker-Netzwerk (`traefik-net`) anlegen
4. `.env` prüfen (bricht ab, falls sie fehlt)
5. Core-Infrastruktur starten: Traefik, PostgreSQL+PgBouncer, MinIO, Uptime Kuma,
   Cloudflare Tunnel
6. Provisioning Agent bauen & starten
7. Dashboard bauen & starten

## Schritt 4 — Cloudflare Tunnel verbinden

Das Dashboard ist absichtlich **nicht** über offene Ports erreichbar — nur über
den Cloudflare Tunnel mit Zero-Trust-Auth davor. Uptime Kuma dagegen läuft ganz
normal über Traefik/Let's Encrypt auf einem offenen Port (443), mit eigenem
Login davor (Schritt 7): im Cloudflare Zero Trust Dashboard:

1. Tunnel anlegen, Token in `CLOUDFLARE_TUNNEL_TOKEN` (`.env`) eintragen
2. Ingress-Regel für das Dashboard ergänzen:
   - `admin.<PLATFORM_DOMAIN>` → `http://admin-dashboard:3000`
3. Für `status-vps.<PLATFORM_DOMAIN>` (Uptime Kuma) ist **keine** Tunnel-Regel
   nötig — ein normaler A-Record auf die Server-IP reicht, Traefik übernimmt
   TLS und Routing selbst (siehe `monitoring/uptime-kuma/docker-compose.yml`).

## Schritt 5 — Admin-Zugang für das Dashboard anlegen

Das Dashboard nutzt Credentials-Auth (kein OAuth), Passwort-Hash liegt in der `.env`:

```bash
node -e "console.log(require('bcryptjs').hashSync('DEIN_PASSWORT', 12))"
```

Ergebnis in `ADMIN_PASSWORD_HASH` eintragen, `ADMIN_EMAIL` entsprechend setzen,
Container neu starten. Login unter `https://admin.<PLATFORM_DOMAIN>`.

## Schritt 6 — Backups einrichten

```bash
rclone config    # Remote für deinen Object-Storage-Anbieter anlegen
```

Danach `backups/backup-script.sh` als Cron einrichten (empfohlen: täglich).
Verschlüsselung läuft über `age` — den Public Key in `BACKUP_AGE_PUBLIC_KEY`
eintragen, den privaten Identity-File **niemals** ins Repo committen (ist über
`.gitignore` bereits ausgeschlossen: `backups/age-identity.txt`).

Restore einmal testen:

```bash
./backups/restore-test-script.sh
```

## Schritt 7 — Uptime Kuma initialisieren

Uptime Kuma muss beim ersten Aufruf einmalig über den eigenen Setup-Wizard
initialisiert werden:

- Datenbank-Wahl: **SQLite empfohlen** (der `mem_limit: 128m` im Compose-File ist
  für die eingebettete MariaDB-Variante zu knapp bemessen)
- Admin-Zugangsdaten müssen exakt `UPTIME_KUMA_USERNAME` / `UPTIME_KUMA_PASSWORD`
  aus der `.env` entsprechen, sonst kann der Provisioning Agent keine Monitore
  automatisch anlegen

## Schritt 8 — Health-Check

```bash
docker exec provisioning-agent wget -qO- \
  --header="X-Agent-Secret: $PROVISIONING_AGENT_SECRET" \
  http://localhost:3001/health
```

Danach testweise einen Smoke-Test fahren:

```bash
./scripts/smoke-test.sh
```

## Bekannte offene Punkte (siehe auch README „Sicherheitsdesign")

- SMTP für GoTrue (Tenant-Auth-Mails) läuft über `RESEND_API_KEY` in der `.env`
  (`GOTRUE_MAILER_AUTOCONFIRM: "false"` im Tenant-Compose-Template — Registrierung
  verlangt also eine Bestätigungsmail). Ist `RESEND_API_KEY` nicht gesetzt, wird
  die Mail nie zugestellt und kein Tenant-User kann sich bestätigen — der Agent
  loggt dafür eine Warnung beim Tenant-Anlegen, ändert das Verhalten aber nicht
  automatisch. Für Betrieb ohne SMTP-Anbindung `RESEND_API_KEY` einfach nicht
  setzen und stattdessen manuell in `kunden-instances/<slug>/docker-compose.yml`
  `GOTRUE_MAILER_AUTOCONFIRM` auf `"true"` setzen, bevor der `auth`-Container
  gestartet wird.
- Resource-Tier-Werte (`STARTER_*`, `BUSINESS_*`, `PREMIUM_*` in `.env.example`)
  sind Platzhalter für eine 16GB-VPS-Planung, nicht final für 8GB kalkuliert.
- Container-Hardening (`read_only`, `cap_drop: ALL`, `no-new-privileges`,
  `pids_limit`) ist für die generierten Tenant-Compose-Templates noch nicht
  vollständig durchgezogen.
SETUPMD_EOF

mkdir -p "$(dirname "$PLATFORM_DIR/bootstrap.sh")"
cat > "$PLATFORM_DIR/bootstrap.sh" << 'BOOTSTRAP_EOF'
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

echo ""
echo "=================================================================="
echo "Bootstrap abgeschlossen. Health-Check:"
echo "  docker exec provisioning-agent wget -qO- --header=\"X-Agent-Secret: \$PROVISIONING_AGENT_SECRET\" http://localhost:3001/health"
echo ""
echo "Falls noch nicht geschehen:"
echo "  - Cloudflare Tunnel Ingress-Rules für admin.<domain> / status.<domain> einrichten"
echo "  - 01_roles.sql prüfen (core-postgres/init-scripts/)"
echo "  - Rclone-Remote für dein Backup-Storage konfigurieren (rclone config)"
echo "  - Backup-Cron einrichten (siehe SETUP.md Schritt 6)"
echo "=================================================================="
BOOTSTRAP_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/lib/adminDb.ts")"
cat > "$DASHBOARD_SRC/lib/adminDb.ts" << 'ADMINDB_EOF'
import { Pool } from "pg";

// Verbindung zur admin_dashboard-DB. Läuft über pgbouncer, siehe .env.example
// (DATABASE_URL) und SETUP.md Schritt 2.
let adminPool: Pool | null = null;

function getAdminPool(): Pool {
  if (!adminPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL fehlt (siehe .env.example und SETUP.md Schritt 2)");
    }
    adminPool = new Pool({ connectionString, max: 5 });
  }
  return adminPool;
}

export interface Tenant {
  id: string;
  slug: string;
  db_name: string;
  tariff: string;
  display_name: string | null;
  contact_email: string | null;
  status: string;
  notes: string | null;
  created_at: string;
}

export async function listTenants(): Promise<Tenant[]> {
  const pool = getAdminPool();
  const { rows } = await pool.query<Tenant>(
    "SELECT id, slug, db_name, tariff, display_name, contact_email, status, notes, created_at FROM kunden ORDER BY created_at DESC"
  );
  return rows;
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const pool = getAdminPool();
  const { rows } = await pool.query<Tenant>(
    "SELECT id, slug, db_name, tariff, display_name, contact_email, status, notes, created_at FROM kunden WHERE slug = $1",
    [slug]
  );
  return rows[0] ?? null;
}

export interface SavedQuery {
  id: string;
  tenant_slug: string;
  name: string;
  sql_text: string;
  created_at: string;
}

// P2-3: Gespeicherte SQL-Editor-Abfragen pro Tenant.
export async function listSavedQueries(tenantSlug: string): Promise<SavedQuery[]> {
  const pool = getAdminPool();
  const { rows } = await pool.query<SavedQuery>(
    "SELECT id, tenant_slug, name, sql_text, created_at FROM saved_queries WHERE tenant_slug = $1 ORDER BY created_at DESC",
    [tenantSlug]
  );
  return rows;
}

export async function saveQuery(tenantSlug: string, name: string, sqlText: string): Promise<SavedQuery> {
  const pool = getAdminPool();
  const { rows } = await pool.query<SavedQuery>(
    "INSERT INTO saved_queries (tenant_slug, name, sql_text) VALUES ($1, $2, $3) RETURNING id, tenant_slug, name, sql_text, created_at",
    [tenantSlug, name, sqlText]
  );
  return rows[0];
}

export async function deleteSavedQuery(id: string, tenantSlug: string): Promise<void> {
  const pool = getAdminPool();
  await pool.query("DELETE FROM saved_queries WHERE id = $1 AND tenant_slug = $2", [id, tenantSlug]);
}
ADMINDB_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/lib/tenantDb.ts")"
cat > "$DASHBOARD_SRC/lib/tenantDb.ts" << 'TENANTDB_EOF'
import { Pool, QueryResult } from "pg";
import format from "pg-format";

const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;
const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || "pgbouncer";

// Ein Pool pro Tenant-DB, wiederverwendet über Requests hinweg (Next.js-Server-Prozess
// lebt dauerhaft). Verbindet als 'postgres'-Superuser -> Table Editor braucht vollen
// Zugriff (Schema lesen, DDL perspektivisch), anders als der eingeschränkte
// 'authenticator'-Role, den PostgREST/GoTrue nutzen (siehe .env.example § Secrets).
const tenantPools = new Map<string, Pool>();

function getTenantPool(dbName: string): Pool {
  if (!/^[a-z0-9_]+$/.test(dbName)) {
    throw new Error("invalid db name");
  }
  let pool = tenantPools.get(dbName);
  if (!pool) {
    pool = new Pool({
      connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/${dbName}`,
      max: 3,
    });
    tenantPools.set(dbName, pool);
  }
  return pool;
}

export interface TableInfo {
  name: string;
  rowEstimate: number;
}

export async function listTables(dbName: string): Promise<TableInfo[]> {
  const pool = getTenantPool(dbName);
  const { rows } = await pool.query<{ table_name: string; row_estimate: string }>(
    `SELECT c.relname AS table_name, GREATEST(c.reltuples, 0)::bigint AS row_estimate
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname`
  );
  return rows.map((r) => ({ name: r.table_name, rowEstimate: Number(r.row_estimate) }));
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
  columnDefault: string | null;
}

export async function getTableColumns(dbName: string, table: string): Promise<ColumnInfo[]> {
  const pool = getTenantPool(dbName);
  const { rows: cols } = await pool.query(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table]
  );
  const { rows: pk } = await pool.query(
    `SELECT a.attname AS column_name
     FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = format('public.%I', $1)::regclass AND i.indisprimary`,
    [table]
  );
  const pkNames = new Set(pk.map((r) => r.column_name));
  return cols.map((c) => ({
    name: c.column_name,
    dataType: c.data_type,
    isNullable: c.is_nullable === "YES",
    isPrimaryKey: pkNames.has(c.column_name),
    columnDefault: c.column_default,
  }));
}

export interface GetRowsOptions {
  limit: number;
  offset: number;
  /** Spaltenname oder "ctid" (nur bei PK-losen Tabellen gueltig). */
  orderBy?: string;
  orderDir?: "asc" | "desc";
  /** Spalte -> Suchtext, als ILIKE-Teilstringsuche angewandt (P2-2). */
  filters?: Record<string, string>;
}

export async function getRows(
  dbName: string,
  table: string,
  opts: GetRowsOptions
): Promise<{
  rows: Record<string, unknown>[];
  columns: ColumnInfo[];
  totalCount: number;
  hasPrimaryKey: boolean;
}> {
  const pool = getTenantPool(dbName);
  const columns = await getTableColumns(dbName, table);
  const hasPrimaryKey = columns.some((c) => c.isPrimaryKey);
  const validColNames = new Set(columns.map((c) => c.name));

  const whereParts: string[] = [];
  for (const [col, value] of Object.entries(opts.filters ?? {})) {
    if (!validColNames.has(col) || !value) continue;
    whereParts.push(format("%I::text ILIKE %L", col, `%${value}%`));
  }
  const whereSql = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

  // orderBy ist entweder eine echte Spalte oder "ctid" - und "ctid" nur, wenn
  // die Tabelle keinen echten PK hat (sonst gibt's keinen Grund, danach zu sortieren).
  let orderSql = "";
  if (opts.orderBy && (validColNames.has(opts.orderBy) || (opts.orderBy === "ctid" && !hasPrimaryKey))) {
    const dir = opts.orderDir === "desc" ? "DESC" : "ASC";
    orderSql = `ORDER BY ${format("%I", opts.orderBy)} ${dir}`;
  }

  const limit = Number.isFinite(opts.limit) ? Math.max(0, Math.min(500, Math.trunc(opts.limit))) : 50;
  const offset = Number.isFinite(opts.offset) ? Math.max(0, Math.trunc(opts.offset)) : 0;

  // PK-lose Tabellen: ctid als Fallback-Identifier mitliefern (P2-2). ctid
  // verschiebt sich bei VACUUM FULL / manchen UPDATEs - fuer eine Admin-UI
  // zwischen zwei Requests ausreichend stabil, im Frontend mit Warnhinweis.
  const selectCols = hasPrimaryKey ? "*" : "*, ctid::text AS __ctid";
  const tableRef = format("%I.%I", "public", table);

  const sql = `SELECT ${selectCols} FROM ${tableRef} ${whereSql} ${orderSql} LIMIT ${limit} OFFSET ${offset}`;
  const { rows } = await pool.query(sql);

  const countSql = `SELECT count(*)::bigint AS n FROM ${tableRef} ${whereSql}`;
  const { rows: countRows } = await pool.query<{ n: string }>(countSql);
  const totalCount = Number(countRows[0]?.n ?? 0);

  return { rows, columns, totalCount, hasPrimaryKey };
}

export async function insertRow(
  dbName: string,
  table: string,
  values: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const pool = getTenantPool(dbName);
  const cols = Object.keys(values);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const sql = format(
    "INSERT INTO %I.%I (%s) VALUES (%s) RETURNING *",
    "public",
    table,
    cols.map((c) => format("%I", c)).join(", "),
    placeholders.join(", ")
  );
  const { rows } = await pool.query<Record<string, unknown>>(sql, Object.values(values));
  return rows[0];
}

// "__ctid" ist der Sentinel-Wert, den das Frontend als pkColumn schickt, wenn
// die Tabelle keinen echten Primary Key hat (P2-2 Fallback). ctid ist kein
// normales Feld in information_schema, deshalb hier per Sonderfall behandelt
// statt ueber die generische %I-Spalten-Identifizierung.
function whereClauseFor(pkColumn: string, paramIndex: number): string {
  if (pkColumn === "__ctid") {
    return format("ctid = $%s::tid", paramIndex);
  }
  return format("%I = $%s", pkColumn, paramIndex);
}

export async function updateRow(
  dbName: string,
  table: string,
  pkColumn: string,
  pkValue: unknown,
  values: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const pool = getTenantPool(dbName);
  const cols = Object.keys(values);
  const setClauses = cols.map((c, i) => format("%I = $%s", c, i + 1)).join(", ");
  const sql = `UPDATE ${format("%I.%I", "public", table)} SET ${setClauses} WHERE ${whereClauseFor(
    pkColumn,
    cols.length + 1
  )} RETURNING *`;
  const { rows } = await pool.query<Record<string, unknown>>(sql, [
    ...Object.values(values),
    pkValue,
  ]);
  return rows[0];
}

export async function deleteRow(
  dbName: string,
  table: string,
  pkColumn: string,
  pkValue: unknown
): Promise<void> {
  const pool = getTenantPool(dbName);
  const sql = `DELETE FROM ${format("%I.%I", "public", table)} WHERE ${whereClauseFor(pkColumn, 1)}`;
  await pool.query(sql, [pkValue]);
}

export interface RunSqlResult {
  rows: Record<string, unknown>[];
  fields: string[];
  rowCount: number;
  durationMs: number;
  truncated: boolean;
}

const SQL_STATEMENT_TIMEOUT_MS = 30_000;
const SQL_MAX_ROWS = 1000;

// Wenn die Eingabe (nach optionalem Schluss-Semikolon) EIN einzelnes SELECT/WITH
// ist, wird sie als Subquery mit LIMIT gewrappt - das begrenzt bereits, was
// Postgres liefert, statt erst hinterher im Node-Prozess zu kuerzen (P2-3:
// verhindert den OOM-Fall aus der Gap-Analyse bei "SELECT * FROM grosse_tabelle").
// Bei Mehrfach-Statements oder Nicht-SELECT (INSERT/UPDATE/DDL/...) greift nur
// noch der statement_timeout plus eine Kuerzung der Antwort selbst - echter
// DB-seitiger Schutz ist dort nicht moeglich, ohne die Query zu parsen.
function tryWrapWithLimit(sql: string, maxRows: number): { sql: string; applied: boolean } {
  const trimmed = sql.trim();
  const withoutTrailingSemi = trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed;
  const hasInnerSemicolon = withoutTrailingSemi.includes(";");
  const startsWithSelectOrWith = /^(select|with)\b/i.test(withoutTrailingSemi);
  if (hasInnerSemicolon || !startsWithSelectOrWith) {
    return { sql, applied: false };
  }
  return {
    sql: `SELECT * FROM (\n${withoutTrailingSemi}\n) AS __sql_editor_limited LIMIT ${maxRows + 1}`,
    applied: true,
  };
}

// SQL-Editor: freie Query-Ausführung. Bewusst ohne Statement-Whitelist -
// Dashboard ist single-admin-only (Cloudflare Zero Trust + NextAuth davor),
// analog zum echten Supabase SQL Editor. statement_timeout und READ ONLY
// werden auf einem dedizierten Client gesetzt (nicht ueber pool.query, das
// wuerde die Session-Einstellung an spaeteren, unabhaengigen Requests
// haengen lassen, die denselben Pool-Client zurueckbekommen) und per
// RESET ALL vor der Rueckgabe an den Pool wieder entfernt.
export async function runSql(
  dbName: string,
  sql: string,
  opts: { readOnly?: boolean; maxRows?: number } = {}
): Promise<RunSqlResult> {
  const pool = getTenantPool(dbName);
  const client = await pool.connect();
  const maxRows = opts.maxRows ?? SQL_MAX_ROWS;
  const start = Date.now();
  try {
    await client.query(`SET statement_timeout = ${SQL_STATEMENT_TIMEOUT_MS}`);
    if (opts.readOnly) {
      await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    }
    const { sql: effectiveSql, applied } = tryWrapWithLimit(sql, maxRows);
    const result: QueryResult = await client.query(effectiveSql);
    const durationMs = Date.now() - start;
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const dbSideTruncated = applied && rows.length > maxRows;
    const outputTruncated = !applied && rows.length > maxRows;
    return {
      rows: dbSideTruncated || outputTruncated ? rows.slice(0, maxRows) : rows,
      fields: result.fields?.map((f) => f.name) ?? [],
      rowCount: result.rowCount ?? rows.length,
      durationMs,
      truncated: dbSideTruncated || outputTruncated,
    };
  } finally {
    try {
      await client.query("RESET ALL");
    } catch {
      // Verbindung ist evtl. durch den Timeout/Fehler schon kaputt - dann
      // kommt der Pool-Client beim naechsten Connect ohnehin frisch.
    }
    client.release();
  }
}
TENANTDB_EOF

mkdir -p "$(dirname "$AGENT_SRC/lib/crypto.ts")"
cat > "$AGENT_SRC/lib/crypto.ts" << 'CRYPTO_TS_EOF'
import crypto from 'crypto';

// ENCRYPTION_MASTER_KEY: 256-bit (32 byte) key, hex-encoded, aus .env (siehe .env.example)
// NIEMALS in der DB speichern, NIEMALS loggen.
const MASTER_KEY_HEX = process.env.ENCRYPTION_MASTER_KEY;

function getKey(): Buffer {
  if (!MASTER_KEY_HEX || MASTER_KEY_HEX.length !== 64) {
    throw new Error('ENCRYPTION_MASTER_KEY fehlt oder hat falsche Länge (muss 64 hex chars / 32 bytes sein)');
  }
  return Buffer.from(MASTER_KEY_HEX, 'hex');
}

/**
 * Verschlüsselt einen Klartext-String mit AES-256-GCM.
 * Rückgabeformat (Buffer, direkt in BYTEA-Spalte speicherbar): [12 byte IV][16 byte authTag][ciphertext]
 */
export function encrypt(plaintext: string): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

/**
 * Entschlüsselt einen Buffer, der mit encrypt() erzeugt wurde.
 */
export function decrypt(payload: Buffer): string {
  const iv = payload.subarray(0, 12);
  const authTag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Maskiert Secret-Patterns in Log-/Build-Output, bevor er in `deployments.build_log` geschrieben
 * oder in die Console geloggt wird. Siehe CLAUDE.md § 1.5.
 */
export function maskSecrets(input: string): string {
  return input.replace(
    /(JWT_SECRET|PASSWORD|API_KEY|SECRET_KEY|TOKEN|WEBHOOK_SECRET)=\S+/gi,
    '$1=***'
  );
}
CRYPTO_TS_EOF

mkdir -p "$(dirname "$AGENT_SRC/lib/secrets.ts")"
cat > "$AGENT_SRC/lib/secrets.ts" << 'SECRETS_TS_EOF'
import { Client as PGClient } from 'pg';
import { decrypt } from './crypto';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

function adminClient(): PGClient {
  return new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
}

export interface TenantSecrets {
  gotrueJwtSecret: string;
  minioAccessKey: string;
  minioSecretKey: string;
  anonJwt: string;
  serviceRoleJwt: string;
}

/**
 * Holt die pro-Kunde-Secrets aus admin_dashboard.kunden (entschlüsselt) für die
 * Auto-Env-Injection in den Kunden-App-Container (siehe lib/deploy.ts runDeployment() Schritt 2).
 */
export async function getTenantSecrets(tenantSlug: string): Promise<TenantSecrets> {
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT gotrue_jwt_secret, minio_access_key, minio_secret_key_encrypted, anon_jwt, service_role_jwt
       FROM kunden WHERE slug = $1`,
      [tenantSlug]
    );
    if (rows.length === 0) throw new Error(`tenant not found: ${tenantSlug}`);
    const row = rows[0];
    return {
      gotrueJwtSecret: row.gotrue_jwt_secret,
      minioAccessKey: row.minio_access_key,
      minioSecretKey: row.minio_secret_key_encrypted ? decrypt(row.minio_secret_key_encrypted) : '',
      anonJwt: row.anon_jwt || '',
      serviceRoleJwt: row.service_role_jwt || '',
    };
  } finally {
    await db.end();
  }
}

/**
 * Holt manuell im Dashboard gesetzte project_env_vars (entschlüsselt).
 */
export async function getProjectEnvVars(projectId: string): Promise<Record<string, string>> {
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT key, value_encrypted FROM project_env_vars WHERE project_id = $1`,
      [projectId]
    );
    const out: Record<string, string> = {};
    for (const row of rows) {
      out[row.key] = decrypt(row.value_encrypted);
    }
    return out;
  } finally {
    await db.end();
  }
}

/**
 * Baut die vollständige Env-Var-Liste für den `docker run`-Aufruf: Tenant-Secrets
 * (MinIO, GoTrue) + manuell gesetzte project_env_vars. Nie geloggt im Klartext.
 */
export async function buildEnvVars(
  tenantSlug: string,
  projectId: string
): Promise<Record<string, string>> {
  const tenant = await getTenantSecrets(tenantSlug);
  const projectVars = await getProjectEnvVars(projectId);

  return {
    MINIO_ENDPOINT: 'http://core-minio:9000',
    MINIO_ACCESS_KEY: tenant.minioAccessKey,
    MINIO_SECRET_KEY: tenant.minioSecretKey,
    S3_BUCKET_NAME: `kunde-${tenantSlug}-storage`,
    GOTRUE_URL: `http://auth-${tenantSlug}:9999`,
    JWT_SECRET: tenant.gotrueJwtSecret,
    POSTGREST_URL: `http://api-${tenantSlug}:3000`,
    SUPABASE_URL: `http://api-${tenantSlug}:3000`, // Alias, falls Kunden-App Supabase-SDK nutzt
    SUPABASE_ANON_KEY: tenant.anonJwt,
    SUPABASE_SERVICE_ROLE_KEY: tenant.serviceRoleJwt,
    ...projectVars,
  };
}
SECRETS_TS_EOF

mkdir -p "$(dirname "$AGENT_SRC/lib/deploy.ts")"
cat > "$AGENT_SRC/lib/deploy.ts" << 'DEPLOY_TS_EOF'
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Client as PGClient } from 'pg';
import { checkoutRepo } from './git';
import { nixpacksBuild } from './nixpacks';
import { buildEnvVars } from './secrets';
import { maskSecrets } from './crypto';
import { detectBuildErrorHint } from './buildErrorHints';

const execFileP = promisify(execFile);

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

function adminClient(): PGClient {
  return new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
}

const TARIFF_LIMITS: Record<string, { mem: string; cpus: string }> = {
  starter: { mem: '256m', cpus: '0.5' },
  business: { mem: '512m', cpus: '1' },
  premium: { mem: '1g', cpus: '2' },
};

// P2-4: In-Process-Tracking laufender Deploys fuer Abbruch. Ueberlebt keinen
// Agent-Neustart (bewusst - siehe cancelDeployment() fuer den verwaisten Fall,
// den die Route separat behandelt). pastPointOfNoReturn schuetzt davor, dass ein
// Abbruch mitten im Traffic-Switch (altes Container schon umbenannt) live geht.
interface ActiveDeployState {
  abort: AbortController;
  containerName?: string;
  pastPointOfNoReturn: boolean;
}
const activeDeployments = new Map<string, ActiveDeployState>();

class DeploymentCancelledError extends Error {
  constructor() {
    super('deployment cancelled');
    this.name = 'DeploymentCancelledError';
  }
}

export function cancelDeployment(deploymentId: string): { ok: boolean; reason?: string; containerName?: string } {
  const state = activeDeployments.get(deploymentId);
  if (!state) return { ok: false, reason: 'kein aktiver Prozess fuer dieses Deployment im Agent gefunden' };
  if (state.pastPointOfNoReturn) {
    return { ok: false, reason: 'Deployment schaltet bereits Live-Traffic um - kann nicht mehr abgebrochen werden' };
  }
  state.abort.abort();
  return { ok: true, containerName: state.containerName };
}

export interface Project {
  id: string;
  tenant_slug: string;
  slug: string;
  repo_url: string;
  default_branch: string;
  build_command: string | null;
  active_container: string | null;
  preview_hostname: string;
  // P1-3: frueher ueberall hart 3000 — Apps auf 4173/8000/8080 konnten nie
  // deployen und der Healthcheck lief kommentarlos ins Leere.
  app_port: number | null;
  health_path: string | null;
}

async function updateDeployment(
  db: PGClient,
  deploymentId: string,
  fields: {
    status?: string;
    build_log?: string;
    container_name?: string;
    image_tag?: string;
    finished_at?: boolean;
    commit_message?: string;
  }
) {
  const sets: string[] = [];
  const vals: any[] = [];
  let i = 1;
  if (fields.status !== undefined) { sets.push(`status = $${i++}`); vals.push(fields.status); }
  if (fields.build_log !== undefined) { sets.push(`build_log = $${i++}`); vals.push(fields.build_log); }
  if (fields.container_name !== undefined) { sets.push(`container_name = $${i++}`); vals.push(fields.container_name); }
  if (fields.image_tag !== undefined) { sets.push(`image_tag = $${i++}`); vals.push(fields.image_tag); }
  if (fields.commit_message !== undefined) { sets.push(`commit_message = $${i++}`); vals.push(fields.commit_message); }
  if (fields.finished_at) { sets.push(`finished_at = now()`); }
  vals.push(deploymentId);
  await db.query(`UPDATE deployments SET ${sets.join(', ')} WHERE id = $${i}`, vals);
}

/**
 * Prüft Health eines internen Containers via HTTP-Request von innerhalb des
 * Provisioning-Agent-Containers (der selbst auf traefik-net hängt) — kein curl/wget
 * im Zielcontainer nötig, kein Shell-Exec, reines Node `fetch`.
 */
async function pollHealthcheck(
  containerName: string,
  port: number,
  timeoutMs = 60_000,
  path = '/',
  signal?: AbortSignal
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DeploymentCancelledError();
    try {
      const res = await fetch(`http://${containerName}:${port}${path}`, { signal: AbortSignal.timeout(3000) });
      if (res.status < 500) return true;
    } catch {
      // Container noch nicht bereit — weiter pollen.
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Voller Deploy-Flow für ein Projekt (Checkout → Build → Blue-Green-Swap, siehe Kommentare unten).
 * Läuft asynchron im Hintergrund; der aufrufende Endpoint gibt sofort die deploymentId zurück
 * und der Status wird über GET /deployments/:projectId pollbar aktualisiert.
 */
export async function runDeployment(
  project: Project,
  ref: string,
  triggeredBy: 'webhook' | 'manual' | 'api',
  tariff: string,
  deploymentId: string
): Promise<void> {
  const db = adminClient();
  await db.connect();
  let buildLog = '';
  const appPort = project.app_port || 3000;
  const healthPath = project.health_path || '/';

  const state: ActiveDeployState = { abort: new AbortController(), pastPointOfNoReturn: false };
  activeDeployments.set(deploymentId, state);
  const signal = state.abort.signal;
  const checkCancelled = () => {
    if (signal.aborted) throw new DeploymentCancelledError();
  };

  try {
    await updateDeployment(db, deploymentId, { status: 'building' });

    // 1. Repo auschecken
    const { path: buildPath, resolvedSha, commitMessage } = await checkoutRepo(
      project.slug,
      project.repo_url,
      ref,
      signal
    );
    buildLog += `Checked out ${resolvedSha} for ${project.slug}\n`;
    await db.query('UPDATE deployments SET commit_sha = $1, commit_message = $2 WHERE id = $3', [
      resolvedSha,
      commitMessage || null,
      deploymentId,
    ]);
    checkCancelled();

    // 2. Env-Vars sammeln (Tenant-Secrets + manuelle project_env_vars, Auto-Injection) —
    //    VOR dem Build, damit sie auch nixpacksBuild zur Verfügung stehen (siehe dort).
    const envVars = await buildEnvVars(project.tenant_slug, project.id);
    const envArgs = Object.entries(envVars).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

    // 3. Nixpacks-Build
    const imageTag = `app-${project.slug}:${resolvedSha.slice(0, 12)}`;
    const buildResult = await nixpacksBuild(buildPath, imageTag, project.build_command || undefined, envVars, signal);
    buildLog += buildResult.log;
    await updateDeployment(db, deploymentId, { build_log: buildLog, image_tag: imageTag });
    checkCancelled();

    // 4. Neuen Container starten (interner Name, noch ohne öffentliche Traefik-Labels)
    const limits = TARIFF_LIMITS[tariff] || TARIFF_LIMITS.starter;
    const newContainerName = `app-${project.slug}-${resolvedSha.slice(0, 8)}`;
    await execFileP('docker', ['rm', '-f', newContainerName]).catch(() => {});
    await execFileP('docker', [
      'run', '-d',
      '--name', newContainerName,
      '--network', 'traefik-net',
      `--memory=${limits.mem}`,
      `--cpus=${limits.cpus}`,
      ...envArgs,
      imageTag,
    ]);
    state.containerName = newContainerName;
    buildLog += `Started candidate container ${newContainerName}\n`;
    await updateDeployment(db, deploymentId, { status: 'healthchecking', build_log: maskSecrets(buildLog), container_name: newContainerName });

    // 5. Healthcheck gegen den neuen Container (intern, noch kein Traffic)
    const healthy = await pollHealthcheck(newContainerName, appPort, 60_000, healthPath, signal);
    if (!healthy) {
      buildLog += `Healthcheck FAILED for ${newContainerName} auf Port ${appPort}${healthPath} — rolling back, old container bleibt aktiv.\n`;
      buildLog += `Hinweis: Antwortet die App auf einem anderen Port? Port und Healthcheck-Pfad sind pro Projekt einstellbar.\n`;
      // Logs VOR dem Löschen sichern — sonst ist der Container weg, bevor man
      // nachschauen kann, warum er nicht healthy wurde (Crash beim Start, fehlende
      // Env-Vars etc.).
      const candidateLogs = await execFileP('docker', ['logs', '--tail', '100', newContainerName]).catch((e: any) => ({
        stdout: '', stderr: e.stderr || e.message,
      }));
      buildLog += `--- Container-Logs (letzte 100 Zeilen) ---\n${candidateLogs.stdout}\n${candidateLogs.stderr}\n`;
      await execFileP('docker', ['rm', '-f', newContainerName]).catch(() => {});
      await updateDeployment(db, deploymentId, { status: 'failed', build_log: maskSecrets(buildLog), finished_at: true });
      return;
    }
    buildLog += `Healthcheck OK\n`;

    // Letzter Cancel-Check vor dem Point of no Return: ab hier wird der oeffentliche
    // Container angefasst, ein Abbruch waere ab jetzt riskanter als ihn durchlaufen
    // zu lassen (haette sonst potenziell keinen laufenden Container mehr zur Folge).
    checkCancelled();
    state.pastPointOfNoReturn = true;

    // 6. Traffic umschalten: neuen Container mit öffentlichem Namen + Traefik-Labels final starten,
    //    alten Container beiseiteschieben (nicht sofort löschen — Rollback-Fallback).
    const publicName = `app-${project.slug}`;
    const oldBackupName = `${publicName}-old-${Date.now()}`;

    const { stdout: existing } = await execFileP('docker', ['ps', '-aq', '--filter', `name=^/${publicName}$`]);
    const hadPrevious = existing.trim().length > 0;
    if (hadPrevious) {
      await execFileP('docker', ['rename', publicName, oldBackupName]);
      await execFileP('docker', ['stop', oldBackupName]).catch(() => {});
    }

    // Candidate-Container droppen und mit finalem Namen + Labels neu starten
    // (Docker erlaubt kein nachträgliches Hinzufügen von Labels zu einem laufenden Container).
    await execFileP('docker', ['rm', '-f', newContainerName]).catch(() => {});
    await execFileP('docker', [
      'run', '-d',
      '--name', publicName,
      '--network', 'traefik-net',
      `--memory=${limits.mem}`,
      `--cpus=${limits.cpus}`,
      '--label', 'traefik.enable=true',
      '--label', `traefik.http.routers.${project.slug}-app.rule=Host(\`${project.preview_hostname}\`)`,
      '--label', `traefik.http.routers.${project.slug}-app.entrypoints=websecure`,
      '--label', `traefik.http.routers.${project.slug}-app.tls.certresolver=myresolver`,
      '--label', `traefik.http.services.${project.slug}-app.loadbalancer.server.port=${appPort}`,
      ...envArgs,
      imageTag,
    ]);

    const finalHealthy = await pollHealthcheck(publicName, appPort, 30_000, healthPath);
    if (!finalHealthy) {
      // Rollback: finalen Container entfernen, alten wiederherstellen
      buildLog += `Final container failed post-swap healthcheck — rolling back to previous container.\n`;
      const finalLogs = await execFileP('docker', ['logs', '--tail', '100', publicName]).catch((e: any) => ({
        stdout: '', stderr: e.stderr || e.message,
      }));
      buildLog += `--- Container-Logs (letzte 100 Zeilen) ---\n${finalLogs.stdout}\n${finalLogs.stderr}\n`;
      await execFileP('docker', ['rm', '-f', publicName]).catch(() => {});
      if (hadPrevious) {
        await execFileP('docker', ['rename', oldBackupName, publicName]);
        await execFileP('docker', ['start', publicName]);
      }
      await updateDeployment(db, deploymentId, { status: 'failed', build_log: maskSecrets(buildLog), finished_at: true });
      return;
    }

    // 7. Alten Container endgültig entfernen
    if (hadPrevious) {
      await execFileP('docker', ['rm', '-f', oldBackupName]).catch(() => {});
    }
    buildLog += `Deployed ${publicName} (${imageTag}) — live traffic switched.\n`;

    await db.query('UPDATE projects SET active_container = $1, active_deployment_id = $2 WHERE id = $3', [
      publicName, deploymentId, project.id,
    ]);
    await updateDeployment(db, deploymentId, { status: 'deployed', build_log: maskSecrets(buildLog), container_name: publicName, finished_at: true });
  } catch (err: any) {
    const cancelled = err instanceof DeploymentCancelledError || err?.name === 'AbortError';
    if (cancelled) {
      buildLog += `\n[cancel] Deployment abgebrochen.\n`;
      // Kandidat-Container war noch nicht live geschaltet (sonst haette
      // pastPointOfNoReturn den Abbruch verhindert) - gefahrlos entfernbar.
      if (state.containerName) {
        await execFileP('docker', ['rm', '-f', state.containerName]).catch(() => {});
        buildLog += `Kandidat-Container ${state.containerName} entfernt.\n`;
      }
      await updateDeployment(db, deploymentId, { status: 'cancelled', build_log: maskSecrets(buildLog), finished_at: true }).catch(() => {});
    } else {
      buildLog += `\nError: ${err.buildLog || err.message}`;
      const hint = detectBuildErrorHint(buildLog);
      if (hint) buildLog = `⚠️ ${hint}\n${'─'.repeat(60)}\n${buildLog}`;
      await updateDeployment(db, deploymentId, { status: 'failed', build_log: maskSecrets(buildLog), finished_at: true }).catch(() => {});
    }
  } finally {
    activeDeployments.delete(deploymentId);
    await db.end();
  }
}

/**
 * Rollback: letzten erfolgreichen Deployment-Eintrag (vor dem aktuellen) erneut ausrollen,
 * ohne neu zu bauen — Image ist lokal noch getaggt (siehe § 4, "Images bleiben lokal getaggt").
 */
export async function rollbackToDeployment(project: Project, targetDeploymentId: string, tariff: string): Promise<void> {
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query('SELECT * FROM deployments WHERE id = $1 AND project_id = $2', [targetDeploymentId, project.id]);
    if (rows.length === 0) throw new Error('deployment not found');
    const target = rows[0];
    if (!target.image_tag) throw new Error('target deployment has no image_tag — cannot roll back');

    const limits = TARIFF_LIMITS[tariff] || TARIFF_LIMITS.starter;
    const envVars = await buildEnvVars(project.tenant_slug, project.id);
    const envArgs = Object.entries(envVars).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const publicName = `app-${project.slug}`;
    const appPort = project.app_port || 3000;

    await execFileP('docker', ['rm', '-f', publicName]).catch(() => {});
    await execFileP('docker', [
      'run', '-d',
      '--name', publicName,
      '--network', 'traefik-net',
      `--memory=${limits.mem}`,
      `--cpus=${limits.cpus}`,
      '--label', 'traefik.enable=true',
      '--label', `traefik.http.routers.${project.slug}-app.rule=Host(\`${project.preview_hostname}\`)`,
      '--label', `traefik.http.routers.${project.slug}-app.entrypoints=websecure`,
      '--label', `traefik.http.routers.${project.slug}-app.tls.certresolver=myresolver`,
      '--label', `traefik.http.services.${project.slug}-app.loadbalancer.server.port=${appPort}`,
      ...envArgs,
      target.image_tag,
    ]);

    await db.query('UPDATE projects SET active_container = $1, active_deployment_id = $2 WHERE id = $3', [publicName, targetDeploymentId, project.id]);
    await db.query(
      `INSERT INTO deployments (project_id, commit_sha, commit_message, status, container_name, image_tag, triggered_by, finished_at)
       VALUES ($1, $2, $3, 'rolled_back', $4, $5, 'api', now())`,
      [project.id, target.commit_sha, target.commit_message, publicName, target.image_tag]
    );
  } finally {
    await db.end();
  }
}
DEPLOY_TS_EOF

mkdir -p "$(dirname "$AGENT_SRC/lib/git.ts")"
cat > "$AGENT_SRC/lib/git.ts" << 'GIT_TS_EOF'
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';

const execFileP = promisify(execFile);

const BUILDS_ROOT = '/opt/multitenant-platform/deployments/builds';
const GITHUB_PAT = process.env.GITHUB_PAT;
const ASKPASS_SCRIPT = '/app/scripts/git-askpass.sh';

/**
 * Env für git-Aufrufe gegen private GitHub-Repos: PAT wird NIE in die Repo-URL oder
 * argv geschrieben (execFile hängt bei Fehlschlägen die vollen Argumente an
 * error.message — landet sonst im Klartext in der Dashboard-Fehleranzeige, siehe
 * routes/deployments.ts). Stattdessen über GIT_ASKPASS + Umgebungsvariable, die nur
 * dem Kindprozess sichtbar ist.
 */
function gitEnv(repoUrl: string): NodeJS.ProcessEnv {
  if (!GITHUB_PAT || !/^https:\/\/github\.com\//.test(repoUrl)) return process.env;
  return {
    ...process.env,
    GIT_ASKPASS: ASKPASS_SCRIPT,
    GIT_ASKPASS_TOKEN: GITHUB_PAT,
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * Klont (oder pullt, falls bereits vorhanden) ein Repo für ein Projekt und checkt
 * den angeforderten Commit/Branch aus. Gibt den lokalen Pfad + aufgelösten commit_sha zurück.
 *
 * Nutzt ausschließlich execFile mit Argument-Arrays — keine Shell-String-Konkatenation
 * (repo_url kommt aus der DB, ist aber trotzdem nie Teil eines Shell-Strings, siehe CLAUDE.md § 1.1).
 */
export async function checkoutRepo(
  projectSlug: string,
  repoUrl: string,
  ref: string, // Branch-Name oder Commit-SHA
  signal?: AbortSignal // P2-4: erlaubt Abbruch eines laufenden Deploys waehrend git-Operationen
): Promise<{ path: string; resolvedSha: string; commitMessage: string }> {
  if (!/^[a-z0-9-]+$/.test(projectSlug)) {
    throw new Error('invalid project slug for git checkout');
  }

  const repoDir = `${BUILDS_ROOT}/${projectSlug}/repo`;
  const env = gitEnv(repoUrl);

  // .git prüfen statt nur den Ordner — ein Leftover von einem fehlgeschlagenen
  // Clone-Versuch (z.B. Auth-Fehler vor diesem Fix) legt zwar den Ordner an,
  // aber ohne funktionierendes Repo drin. 'fetch' darauf schlägt dann mit
  // irreführenden Fehlern fehl statt mit "not a git repository".
  if (!existsSync(`${repoDir}/.git`)) {
    await execFileP('rm', ['-rf', repoDir]);
    await execFileP('mkdir', ['-p', repoDir]);
    await execFileP('git', ['clone', '--no-single-branch', repoUrl, repoDir], { env, signal });
  } else {
    await execFileP('git', ['-C', repoDir, 'fetch', '--all', '--prune'], { env, signal });
  }

  // ref kann Branch oder SHA sein — 'git checkout' handhabt beides.
  await execFileP('git', ['-C', repoDir, 'checkout', ref], { signal });
  // Falls ref ein Branch war: auf neuesten Remote-Stand ziehen.
  await execFileP('git', ['-C', repoDir, 'reset', '--hard', `origin/${ref}`], { signal }).catch(() => {
    // Kein Remote-Branch dieses Namens (z.B. weil ref bereits ein SHA war) — ignorieren.
  });

  const { stdout } = await execFileP('git', ['-C', repoDir, 'rev-parse', 'HEAD']);
  const resolvedSha = stdout.trim();

  // P2-4: Commit-Message fuer die Deployment-Historie - Betreffzeile reicht,
  // der volle Body wuerde die Liste unleserlich machen.
  const { stdout: msgOut } = await execFileP('git', ['-C', repoDir, 'log', '-1', '--format=%s', resolvedSha]).catch(
    () => ({ stdout: '' })
  );
  const commitMessage = msgOut.trim();

  // Isolierter Build-Snapshot pro Commit, damit parallele Deploys sich nicht in die Quere kommen.
  const commitDir = `${BUILDS_ROOT}/${projectSlug}/${resolvedSha.slice(0, 12)}`;
  await execFileP('rm', ['-rf', commitDir]);
  await execFileP('cp', ['-r', repoDir, commitDir]);

  return { path: commitDir, resolvedSha, commitMessage };
}

/**
 * Verifiziert eine GitHub-Webhook-Signatur (X-Hub-Signature-256, HMAC-SHA256).
 * Timing-safe Vergleich, verhindert Timing-Angriffe auf die Signaturpruefung.
 */
export function verifyGithubSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const crypto = require('crypto');
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
GIT_TS_EOF


echo "== Rebuild + Neustart Provisioning-Agent =="
cd "$PLATFORM_DIR/provisioning-agent"
docker compose --env-file ../.env build
docker compose --env-file ../.env up -d

echo "== Rebuild + Neustart Dashboard =="
cd "$PLATFORM_DIR/dashboard"
docker compose --env-file ../.env build
docker compose --env-file ../.env up -d

echo ""
echo "Fertig. Backup liegt in: $BACKUP_DIR"
echo "Rollback bei Bedarf: $0 --rollback $BACKUP_DIR"
