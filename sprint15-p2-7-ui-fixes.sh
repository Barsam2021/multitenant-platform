#!/usr/bin/env bash
# Sprint 15 — P2-7: kleinere UI-Defekte
# Auf der VPS ausführen: /opt/multitenant-platform
#
# Was passiert:
#   - .nav-link.active existierte in globals.css, wurde nie gesetzt: neue
#     SidebarNav.tsx (Client-Komponente mit usePathname) markiert den aktiven
#     Menuepunkt und setzt beim Routenwechsel die Mobile-Drawer-Checkbox
#     zurueck (vorher blieb das Menue auf kleinen Screens nach Tap offen)
#   - Neuer ProjectContext.tsx: /api/projects wird einmal im [slug]/layout.tsx
#     geladen statt von vier Unterseiten (Uebersicht, Domains, Env-Vars,
#     Deployments) unabhaengig voneinander - vier Requests weniger pro
#     Tab-Wechsel-Runde
#   - 401/403 vom Agent wurden in drei Seiten (Env-Vars, Deployments,
#     Projektliste) als leere Liste gerendert statt als Fehlermeldung -
#     behoben
#   - index.ts cleanupTenantResources(): loescht jetzt projects-Zeilen mit
#     (DELETE FROM projects WHERE tenant_slug=$1 vor dem Loeschen der
#     kunden-Zeile) statt sie per ON DELETE SET NULL als unsichtbaren
#     Datenbank-Muell zurueckzulassen; neue Migration raeumt bereits
#     bestehende Waisen auf
#   - Audit-Log: Filter nach Aktion und Zeitraum, echte Pagination (totalCount
#     statt fest 100 Eintraege ohne jede Einschraenkung), CSV-Export
#   - Neu: app/icon.tsx (dynamisch generiertes Favicon, next/og), app/error.tsx,
#     app/not-found.tsx - vorher generische Next.js-Fehlerseiten ohne
#     Plattformbezug
#   - Rebuild + Neustart von Dashboard UND Provisioning-Agent
#
# Rollback: ./sprint15-p2-7-ui-fixes.sh --rollback _backup-sprint15-<timestamp>
# Hinweis: Migration ist additiv (reines Aufraeumen), betrifft beim Rollback
# nichts weiter - bereits geloeschte Waisen-Zeilen kommen nicht zurueck (war
# ohnehin nur unsichtbarer Muell ohne Container/Router/Nutzen dahinter).

set -euo pipefail

PLATFORM_DIR="/opt/multitenant-platform"
DASHBOARD_SRC="$PLATFORM_DIR/dashboard/src"
AGENT_SRC="$PLATFORM_DIR/provisioning-agent/src"
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$PLATFORM_DIR/_backup-sprint15-$TS"

FILES=(
  "provisioning-agent/src/index.ts"
  "provisioning-agent/src/routes/audit.ts"
  "dashboard/src/app/dashboard/layout.tsx"
  "dashboard/src/app/dashboard/projects/[slug]/layout.tsx"
  "dashboard/src/app/dashboard/projects/[slug]/page.tsx"
  "dashboard/src/app/dashboard/projects/[slug]/domains/page.tsx"
  "dashboard/src/app/dashboard/projects/[slug]/env/page.tsx"
  "dashboard/src/app/dashboard/projects/[slug]/deployments/page.tsx"
  "dashboard/src/app/dashboard/projects/page.tsx"
  "dashboard/src/app/api/audit-logs/route.ts"
  "dashboard/src/app/dashboard/audit/page.tsx"
)
NEW_FILES=(
  "core-postgres/init-scripts/15_cleanup_orphaned_projects.sql"
  "dashboard/src/components/SidebarNav.tsx"
  "dashboard/src/components/ProjectContext.tsx"
  "dashboard/src/app/icon.tsx"
  "dashboard/src/app/error.tsx"
  "dashboard/src/app/not-found.tsx"
)

if [[ "${1:-}" == "--rollback" ]]; then
  RESTORE_FROM="${2:?Verzeichnis angeben: ./sprint15-p2-7-ui-fixes.sh --rollback _backup-sprint15-XXXXXXXX-XXXXXX}"
  cd "$PLATFORM_DIR"
  echo "Rollback aus $RESTORE_FROM ..."
  for f in "${FILES[@]}"; do
    if [[ -f "$RESTORE_FROM/$f" ]]; then
      mkdir -p "$(dirname "$f")"
      cp "$RESTORE_FROM/$f" "$f"
      echo "  restored: $f"
    fi
  done
  for f in "${NEW_FILES[@]}"; do
    rm -f "$f"
    echo "  removed (war neu in Sprint 15): $f"
  done
  echo "Rebuild..."
  cd "$PLATFORM_DIR/provisioning-agent" && docker compose --env-file ../.env build && docker compose --env-file ../.env up -d
  cd "$PLATFORM_DIR/dashboard" && docker compose --env-file ../.env build && docker compose --env-file ../.env up -d
  echo "Rollback abgeschlossen."
  exit 0
fi

echo "== Sprint 15 (P2-7): Backup nach $BACKUP_DIR =="
cd "$PLATFORM_DIR"
mkdir -p "$BACKUP_DIR"
for f in "${FILES[@]}"; do
  if [[ -f "$f" ]]; then
    mkdir -p "$BACKUP_DIR/$(dirname "$f")"
    cp "$f" "$BACKUP_DIR/$f"
  fi
done
echo "Backup fertig."

echo "== Geaenderte/neue Dateien schreiben =="

mkdir -p "$(dirname "$PLATFORM_DIR/core-postgres/init-scripts/15_cleanup_orphaned_projects.sql")"
cat > "$PLATFORM_DIR/core-postgres/init-scripts/15_cleanup_orphaned_projects.sql" << 'MIGRATION15_EOF'
-- P2-7: projects.tenant_slug hat ON DELETE SET NULL (03_fix_projects_schema.sql).
-- Vor diesem Fix loeschte DELETE /tenants/:slug die kunden-Zeile, ohne die
-- zugehoerigen projects-Zeilen mitzuloeschen - sie blieben mit tenant_slug=NULL
-- zurueck, fallen aus dem JOIN kunden in GET /projects raus und sind seitdem in
-- keiner UI mehr sichtbar, existieren aber weiter in der DB (Container/Router
-- dafuer sind ohnehin schon durch cleanupTenantResources() entfernt worden -
-- das hier ist reines Wegraeumen der verwaisten Zeile selbst).
--
-- index.ts cleanupTenantResources() loescht ab jetzt projects mit, dieser Teil
-- ist nur fuer den Bestand.
--
-- Idempotent (kein Effekt mehr nach dem ersten Lauf).
\connect admin_dashboard

DELETE FROM projects WHERE tenant_slug IS NULL;
MIGRATION15_EOF

mkdir -p "$(dirname "$AGENT_SRC/index.ts")"
cat > "$AGENT_SRC/index.ts" << 'INDEX_TS_EOF'
import express from 'express';
import rateLimit from 'express-rate-limit';
import { Client } from 'pg';
import format from 'pg-format';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, mkdir } from 'fs/promises';
import crypto from 'crypto';
import { projectsRouter } from './routes/projects';
import { tenantsRouter } from './routes/tenants';
import { deploymentsRouter } from './routes/deployments';
import { domainsRouter, resumePendingDomainChecks, healMissingRouters } from './routes/domains';
import { webhooksRouter } from './routes/webhooks';
import { githubRouter } from './routes/github';
import { backupsRouter } from './routes/backups';
import { secretsRouter } from './routes/secrets';
import { auditRouter } from './routes/audit';
import { statsRouter } from './routes/stats';
import { encrypt } from './lib/crypto';
import { signTenantJwt } from './lib/jwt';
import { logAudit } from './lib/audit';
import { deleteMonitor, isMonitoringConfigured } from './lib/monitoring';
import { removeAllRoutersForProject } from './lib/traefikDynamic';

const execFileP = promisify(execFile);
const app = express();

// Phase 6: Rate-Limiting. In-Memory reicht für Single-VPS-Setup (kein Redis nötig,
// ein Prozess = ein Zähler-Store). Drei Stufen: global grosszügig, Webhooks eigenes
// Limit (kommen von GitHub, nicht vom Admin), Tenant-/Secret-Operationen strenger,
// weil sie teuer sind (DB-Erstellung, Container-Start, Secret-Rotation).
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
const webhookLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
const sensitiveOpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const AGENT_SECRET = process.env.PROVISIONING_AGENT_SECRET!;
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;
const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';

app.use('/webhooks', webhookLimiter, express.raw({ type: 'application/json', limit: '5mb' }), webhooksRouter);

app.use(globalLimiter);
app.use(express.json());
app.use((req, res, next) => {
  if (req.headers['x-agent-secret'] !== AGENT_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// P0-4: geteilte Aufraeumlogik fuer einen Tenant — wird sowohl fuer den echten
// DELETE-Endpunkt genutzt als auch fuer das automatische Rollback, wenn
// POST /tenants auf halbem Weg scheitert. Jeder Schritt ist einzeln
// fehlertolerant (sammelt Warnungen statt abzubrechen): ein Tenant, der nur
// teilweise angelegt wurde, hat naturgemaess nicht alle Ressourcen — DROP
// DATABASE IF EXISTS/DROP ROLE IF EXISTS sind No-Ops, mc-Befehle auf nicht
// existente Buckets/User/Policies schlagen einzeln fehl und werden geloggt,
// statt den gesamten Cleanup abzubrechen (frueher riss ein einzelner Fehler,
// z.B. bei DROP DATABASE, den kompletten Rest des Cleanups mit sich).
async function cleanupTenantResources(slug: string): Promise<{ warnings: string[] }> {
  const dbName = `kunde_${slug}`;
  const tenantDir = `/opt/multitenant-platform/kunden-instances/${slug}`;
  const warnings: string[] = [];

  if (isMonitoringConfigured()) {
    try {
      const monitorAdmin = new Client({
        connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
      });
      await monitorAdmin.connect();
      const { rows: projectRows } = await monitorAdmin.query(
        'SELECT kuma_monitor_id FROM projects WHERE tenant_slug = $1 AND kuma_monitor_id IS NOT NULL',
        [slug]
      );
      await monitorAdmin.end();
      for (const p of projectRows) {
        await deleteMonitor(p.kuma_monitor_id).catch((e: any) =>
          warnings.push(`Monitor ${p.kuma_monitor_id} löschen fehlgeschlagen: ${e.message}`)
        );
      }
    } catch (e: any) {
      warnings.push(`Monitor-Cleanup fehlgeschlagen: ${e.message}`);
    }
  }

  try {
    const routerDb = new Client({
      connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
    });
    await routerDb.connect();
    const { rows: slugRows } = await routerDb.query('SELECT slug FROM projects WHERE tenant_slug = $1', [slug]);
    await routerDb.end();
    for (const p of slugRows) {
      await removeAllRoutersForProject(p.slug);
    }
  } catch (e: any) {
    warnings.push(`Traefik-Router-Cleanup fehlgeschlagen: ${e.message}`);
  }

  try {
    await execFileP('docker', ['compose', '-f', `${tenantDir}/docker-compose.yml`, 'down']);
  } catch (e: any) {
    warnings.push(`Container-Stop fehlgeschlagen (evtl. nie gestartet): ${e.message}`);
  }

  try {
    const master = new Client({
      connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/postgres`,
    });
    await master.connect();
    await master.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [dbName]);
    await master.query(format('DROP DATABASE IF EXISTS %I;', dbName));
    await master.query(format('DROP ROLE IF EXISTS %I;', `authenticator_${slug}`));
    await master.end();
  } catch (e: any) {
    warnings.push(`DB/Rolle löschen fehlgeschlagen: ${e.message}`);
  }

  await execFileP('mc', ['rb', '--force', `localminio/kunde-${slug}-storage`]).catch((e: any) =>
    warnings.push(`MinIO-Bucket löschen fehlgeschlagen (evtl. nie angelegt): ${e.message}`)
  );

  try {
    const admin2 = new Client({
      connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
    });
    await admin2.connect();
    const { rows } = await admin2.query('SELECT minio_access_key FROM kunden WHERE slug = $1', [slug]);
    await admin2.end();
    if (rows[0]?.minio_access_key) {
      await execFileP('mc', ['admin', 'user', 'remove', 'localminio', rows[0].minio_access_key]).catch((e: any) =>
        warnings.push(`MinIO-User löschen fehlgeschlagen: ${e.message}`)
      );
    }
  } catch (e: any) {
    warnings.push(`MinIO-User-Lookup fehlgeschlagen: ${e.message}`);
  }

  await execFileP('mc', ['admin', 'policy', 'remove', 'localminio', `kunde-${slug}-policy`]).catch((e: any) =>
    warnings.push(`MinIO-Policy löschen fehlgeschlagen (evtl. nie angelegt): ${e.message}`)
  );

  await execFileP('rm', ['-rf', tenantDir]).catch((e: any) =>
    warnings.push(`Verzeichnis löschen fehlgeschlagen: ${e.message}`)
  );

  try {
    const admin3 = new Client({
      connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
    });
    await admin3.connect();
    // P2-7: projects.tenant_slug hat ON DELETE SET NULL - ohne dieses DELETE
    // blieben Projekt-Zeilen als unsichtbarer Muell zurueck (GET /projects joint
    // gegen kunden, ein NULL-tenant_slug faellt aus dem Join raus, taucht in
    // keiner UI mehr auf, existiert aber weiter in der DB).
    await admin3.query('DELETE FROM projects WHERE tenant_slug = $1', [slug]);
    await admin3.query('DELETE FROM kunden WHERE slug = $1', [slug]);
    await admin3.end();
  } catch (e: any) {
    warnings.push(`DB-Zeile löschen fehlgeschlagen: ${e.message}`);
  }

  return { warnings };
}

app.post('/tenants', sensitiveOpLimiter, async (req, res) => {
  const { tenantSlug, tariff, displayName, contactEmail, notes } = req.body;
  const tenantTariff = ['starter','business','premium'].includes(tariff) ? tariff : 'starter';

  if (!tenantSlug || !/^[a-z0-9-]+$/.test(tenantSlug)) {
    return res.status(400).json({ error: 'invalid slug' });
  }

  // P0-4: MUSS vor jeder Ressourcen-Erstellung stehen. Ohne diesen Check wuerde
  // ein Slug-Konflikt erst bei "CREATE DATABASE" (Postgres-Fehler) auffallen,
  // UND das anschliessende automatische Rollback wuerde den bereits bestehenden,
  // funktionierenden Tenant mit demselben Slug versehentlich mitloeschen —
  // das waere ein destruktiverer Bug als das, was P0-4 eigentlich beheben soll.
  // Eigener try/catch: schlaegt schon DIESE Verbindung fehl, ist noch nichts
  // angelegt, ein Rollback-Versuch waere unnoetig und wuerde nur verwirren.
  try {
    const existsCheck = new Client({
      connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
    });
    await existsCheck.connect();
    const { rows: existingRows } = await existsCheck.query('SELECT 1 FROM kunden WHERE slug = $1', [tenantSlug]);
    await existsCheck.end();
    if (existingRows.length > 0) {
      return res.status(409).json({ error: `Tenant "${tenantSlug}" existiert bereits` });
    }
  } catch (err: any) {
    console.error('Slug-Existenzprüfung fehlgeschlagen:', err.message);
    return res.status(500).json({ error: `Konnte nicht prüfen, ob Slug bereits existiert: ${err.message}` });
  }

  const dbName = `kunde_${tenantSlug}`;
  const jwtSecret = crypto.randomBytes(32).toString('hex');
  const anonJwt = signTenantJwt(jwtSecret, 'anon');
  const serviceRoleJwt = signTenantJwt(jwtSecret, 'service_role');
  const authenticatorPw = crypto.randomBytes(16).toString('hex');
  const authenticatorRole = `authenticator_${tenantSlug}`;

  try {
    const master = new Client({
      connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/postgres`,
    });
    await master.connect();
    await master.query(format('CREATE DATABASE %I;', dbName));
    await master.end();

    const tenant = new Client({
      connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/${dbName}`,
    });
    await tenant.connect();
    const rolesSql = await readFile(
      '/opt/multitenant-platform/core-postgres/templates/authenticator-role.sql.template',
      'utf8'
    );
    await tenant.query(
      rolesSql.replace(/__AUTH_ROLE__/g, authenticatorRole).replace(/CHANGE_ME/g, authenticatorPw)
    );
    await tenant.query(format('CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION %I;', authenticatorRole));
    await tenant.query(format('GRANT ALL ON SCHEMA auth TO %I;', authenticatorRole));
    await tenant.query(format('ALTER ROLE %I IN DATABASE %I SET search_path = auth, public;', authenticatorRole, dbName));
    await tenant.end();

    const tierPrefix = tenantTariff.toUpperCase();
    const postgrestMem = process.env[`${tierPrefix}_POSTGREST_MEM`] || '64m';
    const postgrestCpus = process.env[`${tierPrefix}_POSTGREST_CPUS`] || '0.25';
    const gotrueMem = process.env[`${tierPrefix}_GOTRUE_MEM`] || '128m';
    const gotrueCpus = process.env[`${tierPrefix}_GOTRUE_CPUS`] || '0.25';

    const template = await readFile('/app/templates/tenant-compose.yml', 'utf8');
    const compose = template
      .replace(/\$\{SLUG\}/g, tenantSlug)
      .replace(/\$\{JWT_SECRET\}/g, jwtSecret)
      .replace(/\$\{AUTH_PW\}/g, authenticatorPw)
      .replace(/\$\{AUTH_ROLE\}/g, authenticatorRole)
      .replace(/\$\{PLATFORM_DOMAIN\}/g, process.env.PLATFORM_DOMAIN as string)
      .replace(/\$\{POSTGREST_MEM\}/g, postgrestMem)
      .replace(/\$\{POSTGREST_CPUS\}/g, postgrestCpus)
      .replace(/\$\{GOTRUE_MEM\}/g, gotrueMem)
      .replace(/\$\{GOTRUE_CPUS\}/g, gotrueCpus)
      // P1-7: hier stand bisher hart '' — RESEND_API_KEY wurde nie tatsächlich
      // durchgereicht, GOTRUE_SMTP_PASS war deshalb bei JEDEM Tenant leer und
      // GoTrue konnte nie eine Bestätigungsmail verschicken (bei
      // GOTRUE_MAILER_AUTOCONFIRM=false heisst das: kein Tenant-User konnte sich
      // je registrieren). RESEND_API_KEY ist eine globale Plattform-Variable
      // (.env.example), keine pro-Tenant-Einstellung — resend_api_key_encrypted
      // in kunden bleibt bewusst ungenutzt (siehe routes/secrets.ts Kommentar).
      .replace(/\$\{RESEND_API_KEY\}/g, process.env.RESEND_API_KEY || '')
      .replace(/\$\{TENANT_NAME\}/g, tenantSlug);

    if (!process.env.RESEND_API_KEY) {
      console.warn(
        `RESEND_API_KEY nicht gesetzt — GoTrue-Bestätigungsmails für Tenant "${tenantSlug}" ` +
        `werden fehlschlagen, kein User kann sich registrieren, bis .env ergänzt und ` +
        `der auth-Container neu gestartet wird.`
      );
    }

    const tenantDir = `/opt/multitenant-platform/kunden-instances/${tenantSlug}`;
    await mkdir(tenantDir, { recursive: true });
    await writeFile(`${tenantDir}/docker-compose.yml`, compose);

    await execFileP('docker', ['compose', '-f', `${tenantDir}/docker-compose.yml`, 'up', '-d', 'auth']);
    await new Promise((r) => setTimeout(r, 8000));

    await execFileP('mc', ['alias', 'set', 'localminio', 'http://core-minio:9000', process.env.MINIO_ROOT_USER!, process.env.MINIO_ROOT_PASSWORD!]);
    try {
      await execFileP('mc', ['mb', `localminio/kunde-${tenantSlug}-storage`]);
    } catch (e: any) {
      if (!e.message.includes('already own it')) throw e;
    }

    const minioAccessKey = crypto.randomBytes(16).toString('hex');
    const minioSecretKey = crypto.randomBytes(24).toString('hex');
    await execFileP('mc', ['admin', 'user', 'add', 'localminio', minioAccessKey, minioSecretKey]);
    const policyDoc = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
        Resource: [
          `arn:aws:s3:::kunde-${tenantSlug}-storage`,
          `arn:aws:s3:::kunde-${tenantSlug}-storage/*`,
        ],
      }],
    });
    const policyPath = `/tmp/policy-${tenantSlug}.json`;
    await writeFile(policyPath, policyDoc);
    await execFileP('mc', ['admin', 'policy', 'create', 'localminio', `kunde-${tenantSlug}-policy`, policyPath]);
    await execFileP('mc', ['admin', 'policy', 'attach', 'localminio', `kunde-${tenantSlug}-policy`, '--user', minioAccessKey]);

    await execFileP('docker', ['compose', '-f', `${tenantDir}/docker-compose.yml`, 'up', '-d', 'api']);

    const admin = new Client({
      connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
    });
    await admin.connect();
    await admin.query(
      'INSERT INTO kunden (slug, db_name, tariff, gotrue_jwt_secret, authenticator_password, minio_access_key, minio_secret_key_encrypted, anon_jwt, service_role_jwt, display_name, contact_email, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
      [
        tenantSlug, dbName, tenantTariff, jwtSecret, authenticatorPw, minioAccessKey, encrypt(minioSecretKey), anonJwt, serviceRoleJwt,
        // P2-6: display_name faellt auf den Slug zurueck statt leer zu bleiben -
        // die Projektliste braucht immer einen anzeigbaren Namen.
        (typeof displayName === 'string' && displayName.trim()) || tenantSlug,
        typeof contactEmail === 'string' ? contactEmail.trim() || null : null,
        typeof notes === 'string' ? notes.trim() || null : null,
      ]
    );
    await admin.end();

    await logAudit('tenant.create', tenantSlug, { tariff: tenantTariff, dbName });
    res.json({ status: 'ok', slug: tenantSlug, dbName });
  } catch (err: any) {
    console.error('Provisioning failed:', err.message);
    console.error(`Führe Rollback für "${tenantSlug}" aus...`);
    const { warnings } = await cleanupTenantResources(tenantSlug).catch((cleanupErr: any) => {
      console.error('Rollback selbst fehlgeschlagen:', cleanupErr.message);
      return { warnings: [`Rollback-Funktion selbst fehlgeschlagen: ${cleanupErr.message}`] };
    });
    if (warnings.length > 0) {
      console.error(`Rollback für "${tenantSlug}" mit Warnungen abgeschlossen:`, warnings);
    } else {
      console.error(`Rollback für "${tenantSlug}" vollständig — Slug ist wieder frei.`);
    }
    await logAudit('tenant.create.failed_rollback', tenantSlug, { error: err.message, rollbackWarnings: warnings }).catch(() => {});
    res.status(500).json({
      error: warnings.length === 0
        ? `${err.message} (automatisch zurückgerollt — Slug ist wieder frei)`
        : `${err.message} (Rollback mit Warnungen — Server-Log prüfen, ggf. manuell nachräumen)`,
      rollbackWarnings: warnings,
    });
  }
});


app.delete('/tenants/:slug', sensitiveOpLimiter, async (req, res) => {
  const { slug } = req.params;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'invalid slug' });
  }

  try {
    const { warnings } = await cleanupTenantResources(slug);
    await logAudit('tenant.delete', slug, { warnings });
    res.json({ status: 'ok', slug, warnings: warnings.length > 0 ? warnings : undefined });
  } catch (err: any) {
    console.error('Tenant deletion failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use(projectsRouter);
app.use(tenantsRouter);
app.use(deploymentsRouter);
app.use(domainsRouter);
app.use(githubRouter);
app.use(backupsRouter);
app.use(secretsRouter); // rate-limitet sich selbst, siehe routes/secrets.ts
app.use(auditRouter);
app.use(statsRouter); // P1-8: /stats + /stats/overview, siehe routes/stats.ts


app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(3001, () => {
  console.log('Provisioning Agent (mit Deployment Engine) listening on :3001');
  // P1-1c: offene Domain-Verifikationen nach einem Neustart wieder aufnehmen.
  // Erst fehlende Router reparieren, dann offene Verifikationen fortsetzen.
  healMissingRouters()
    .catch((err) => console.error('healMissingRouters fehlgeschlagen:', err.message))
    .then(() => resumePendingDomainChecks())
    .catch((err) => console.error('resumePendingDomainChecks fehlgeschlagen:', err.message));
});
INDEX_TS_EOF

mkdir -p "$(dirname "$AGENT_SRC/routes/audit.ts")"
cat > "$AGENT_SRC/routes/audit.ts" << 'AUDIT_ROUTE_TS_EOF'
import { Router } from 'express';
import { Client as PGClient } from 'pg';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

function adminClient(): PGClient {
  return new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
}

export const auditRouter = Router();

// GET /audit-logs?limit&offset&action&from&to (P2-7: Filter/Pagination statt
// fest 100 Eintraege ohne jede Einschraenkung). Liefert zusaetzlich totalCount
// fuer echte Seitenzahlen, analog zum Tabellen-Editor (P2-2).
auditRouter.get('/audit-logs', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const action = typeof req.query.action === 'string' ? req.query.action : undefined;
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;

  const whereParts: string[] = [];
  const vals: any[] = [];
  let i = 1;
  if (action) { whereParts.push(`action = $${i++}`); vals.push(action); }
  if (from) { whereParts.push(`created_at >= $${i++}`); vals.push(from); }
  if (to) { whereParts.push(`created_at <= $${i++}`); vals.push(to); }
  const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT id, actor, action, target, meta, created_at
       FROM audit_logs ${whereSql} ORDER BY created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
      [...vals, limit, offset]
    );
    const { rows: countRows } = await db.query(
      `SELECT count(*)::bigint AS n FROM audit_logs ${whereSql}`,
      vals
    );
    const { rows: actionRows } = await db.query(
      `SELECT DISTINCT action FROM audit_logs ORDER BY action`
    );
    res.json({
      logs: rows,
      totalCount: Number(countRows[0]?.n ?? 0),
      actions: actionRows.map((r) => r.action),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});
AUDIT_ROUTE_TS_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/components/SidebarNav.tsx")"
cat > "$DASHBOARD_SRC/components/SidebarNav.tsx" << 'SIDEBARNAV_EOF'
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

const NAV_ITEMS: { href: string; label: string; exact?: boolean }[] = [
  { href: "/dashboard", label: "Übersicht", exact: true },
  { href: "/dashboard/projects", label: "Projekte" },
  { href: "/dashboard/backups", label: "Backups" },
  { href: "/dashboard/audit", label: "Audit-Log" },
];

/**
 * P2-7: zwei Defekte auf einmal behoben.
 * 1) .nav-link.active existierte in globals.css, wurde aber nie gesetzt - Sidebar
 *    hatte nie einen erkennbaren aktiven Zustand.
 * 2) Der Mobile-Drawer nutzte ein reines CSS-Checkbox-Muster ohne Reset - nach
 *    einem Tap auf einen Link blieb das Menü auf kleinen Screens offen.
 * Beides braucht usePathname(), also eine Client-Komponente statt des bisherigen
 * Server-Component-Layouts. footer (ThemeToggle/Abmelden) bleibt server-seitig
 * und wird als children durchgereicht.
 */
export function SidebarNav({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const toggleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (toggleRef.current) toggleRef.current.checked = false;
  }, [pathname]);

  return (
    <>
      <input ref={toggleRef} type="checkbox" id="nav-toggle" className="nav-toggle" />
      <label htmlFor="nav-toggle" className="hamburger-btn" aria-label="Menü öffnen">
        ☰
      </label>
      <label htmlFor="nav-toggle" className="nav-overlay" aria-hidden="true"></label>
      <aside className="sidebar">
        <div className="sidebar-brand">
          UP2 <span>Console</span>
        </div>
        {NAV_ITEMS.map((item) => {
          const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href} className={`nav-link${active ? " active" : ""}`}>
              {item.label}
            </Link>
          );
        })}
        <div style={{ flex: 1 }} />
        {children}
      </aside>
    </>
  );
}
SIDEBARNAV_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/components/ProjectContext.tsx")"
cat > "$DASHBOARD_SRC/components/ProjectContext.tsx" << 'PROJECTCONTEXT_EOF'
"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

export interface Project {
  id: string;
  slug: string;
  tenant_slug: string;
  repo_url: string | null;
  default_branch: string;
  active_container: string | null;
  active_deployment_id: string | null;
  preview_hostname: string;
  app_port: number;
  health_path: string;
}

interface ProjectContextValue {
  project: Project | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

/**
 * P2-7: Vorher lud jede Unterseite (Uebersicht, Domains, Env-Vars, Deployments)
 * unabhaengig voneinander /api/projects und filterte clientseitig nach
 * tenant_slug - vier Requests bei vier Tab-Wechseln fuer dieselben Daten.
 * Jetzt einmal hier im Layout laden, ueber Context an alle Tabs verteilen.
 */
export function ProjectProvider({ slug, children }: { slug: string; children: React.ReactNode }) {
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/projects")
      .then((r) => r.json())
      .then((list) => {
        if (!Array.isArray(list)) {
          setError(list?.error || "Projekte konnten nicht geladen werden");
          setProject(null);
          return;
        }
        const p = list.find((x: Project) => x.tenant_slug === slug);
        setProject(p || null);
        setError(null);
      })
      .catch(() => setError("Verbindung zum Provisioning Agent fehlgeschlagen"))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <ProjectContext.Provider value={{ project, loading, error, reload: load }}>
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) {
    throw new Error("useProject() muss innerhalb von <ProjectProvider> aufgerufen werden");
  }
  return ctx;
}
PROJECTCONTEXT_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/app/dashboard/layout.tsx")"
cat > "$DASHBOARD_SRC/app/dashboard/layout.tsx" << 'DASHLAYOUT_EOF'
import { auth, signOut } from "@/auth";
import { redirect } from "next/navigation";
import ThemeToggle from "@/components/ThemeToggle";
import { SidebarNav } from "@/components/SidebarNav";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return (
    <div className="shell">
      <SidebarNav>
        <ThemeToggle />
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          <button className="nav-link" style={{ width: "100%", textAlign: "left" }}>
            Abmelden
          </button>
        </form>
      </SidebarNav>
      <main className="main">{children}</main>
    </div>
  );
}
DASHLAYOUT_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/app/dashboard/projects/[slug]/layout.tsx")"
cat > "$DASHBOARD_SRC/app/dashboard/projects/[slug]/layout.tsx" << 'SLUGLAYOUT_EOF'
"use client";

import Link from "next/link";
import { usePathname, useParams } from "next/navigation";
import { ProjectProvider } from "@/components/ProjectContext";

const TABS = [
  { href: "", label: "Übersicht" },
  { href: "/tables", label: "Tabellen" },
  { href: "/sql", label: "SQL" },
  { href: "/deployments", label: "Deployments" },
  { href: "/env", label: "Env-Vars" },
  { href: "/domains", label: "Domains" },
];

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { slug } = useParams<{ slug: string }>();
  const base = `/dashboard/projects/${slug}`;

  return (
    <ProjectProvider slug={slug}>
      <div className="content">
        <div className="project-tabs">
          {TABS.map((t) => {
            const href = `${base}${t.href}`;
            const active = pathname === href;
            return (
              <Link
                key={t.href}
                href={href}
                className="project-tab"
                style={{
                  color: active ? "var(--text)" : "var(--text-dim)",
                  borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
                }}
              >
                {t.label}
              </Link>
            );
          })}
        </div>
        {children}
      </div>
    </ProjectProvider>
  );
}
SLUGLAYOUT_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/app/dashboard/projects/[slug]/page.tsx")"
cat > "$DASHBOARD_SRC/app/dashboard/projects/[slug]/page.tsx" << 'SLUGPAGE_EOF'
"use client";

import { useEffect, useState, use } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { useProject } from "@/components/ProjectContext";

interface Tenant {
  slug: string;
  db_name: string;
  tariff: string;
  display_name: string | null;
  contact_email: string | null;
  notes: string | null;
  status: string;
}

interface GithubRepo {
  name: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
  updatedAt: string;
}

export default function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const { project, loading, reload: reloadProject } = useProject();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [previewHostname, setPreviewHostname] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [webhookNote, setWebhookNote] = useState<string | null>(null);
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [manualEntry, setManualEntry] = useState(false);
  const [rotating, setRotating] = useState<"jwt" | "minio" | null>(null);
  const [rotateNote, setRotateNote] = useState<string | null>(null);
  const [rotateTarget, setRotateTarget] = useState<"jwt" | "minio" | null>(null);
  const [editingCustomer, setEditingCustomer] = useState(false);
  const [customerForm, setCustomerForm] = useState({ displayName: "", contactEmail: "", notes: "" });
  const [savingCustomer, setSavingCustomer] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (project?.preview_hostname) setPreviewHostname(project.preview_hostname);
  }, [project]);

  useEffect(() => {
    fetch("/api/tenants")
      .then((r) => r.json())
      .then((d) => {
        const t = d.tenants?.find((x: Tenant) => x.slug === slug);
        if (!t) setError("Projekt nicht gefunden");
        else {
          setTenant(t);
          setCustomerForm({
            displayName: t.display_name || "",
            contactEmail: t.contact_email || "",
            notes: t.notes || "",
          });
        }
      });
    fetch("/api/github/repos")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) {
          setReposError(d.error);
          setManualEntry(true);
        } else if (Array.isArray(d.repos)) {
          setRepos(d.repos);
        }
      })
      .catch(() => {
        setReposError("Repo-Liste konnte nicht geladen werden.");
        setManualEntry(true);
      });
  }, [slug]);

  function handleRepoSelect(fullName: string) {
    const repo = repos?.find((r) => r.fullName === fullName);
    if (!repo) return;
    setRepoUrl(repo.cloneUrl);
    setDefaultBranch(repo.defaultBranch || "main");
  }

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setConnecting(true);
    setConnectError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantSlug: slug,
          slug,
          repoUrl,
          defaultBranch,
          repoProvider: "github",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setConnectError(data.error || "Verbinden fehlgeschlagen");
        return;
      }
      reloadProject();
      setPreviewHostname(data.previewHostname || null);
      setWebhookNote(
        data.githubWebhook?.registered
          ? "GitHub-Webhook automatisch registriert — Push auf den Branch löst künftig einen Deploy aus."
          : `Webhook nicht automatisch registriert (${data.githubWebhook?.reason || "unbekannt"}). Manuell nachtragen: ${data.webhookUrl}`
      );
    } catch {
      setConnectError("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setConnecting(false);
    }
  }

  async function handleDeploy() {
    if (!project) return;
    setDeploying(true);
    try {
      const res = await fetch("/api/deployments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const data = await res.json();
      if (!res.ok) toast.error(data.error || "Deploy fehlgeschlagen");
    } catch {
      toast.error("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setDeploying(false);
    }
  }

  async function handleRotate(secret: "jwt" | "minio") {
    setRotating(secret);
    setRotateNote(null);
    try {
      const res = await fetch(`/api/tenants/${slug}/rotate-secret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret }),
      });
      const data = await res.json();
      const note = res.ok ? data.note || "Rotation abgeschlossen." : data.error || "Rotation fehlgeschlagen";
      setRotateNote(note);
      if (res.ok) toast.success(note); else toast.error(note);
    } catch {
      setRotateNote("Verbindung zum Provisioning Agent fehlgeschlagen");
      toast.error("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setRotating(null);
    }
  }

  async function handleSaveCustomer() {
    setSavingCustomer(true);
    try {
      const res = await fetch(`/api/tenants/${slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: customerForm.displayName,
          contactEmail: customerForm.contactEmail,
          notes: customerForm.notes,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Speichern fehlgeschlagen");
        return;
      }
      setTenant((prev) => (prev ? { ...prev, display_name: data.display_name, contact_email: data.contact_email, notes: data.notes } : prev));
      toast.success("Kundendaten gespeichert.");
      setEditingCustomer(false);
    } catch {
      toast.error("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setSavingCustomer(false);
    }
  }

  if (loading) return <div className="empty-state">Lade…</div>;
  if (error) return <div className="error-box">{error}</div>;

  return (
    <div>
      <h2 style={{ marginTop: 0, fontSize: 16 }}>{tenant?.display_name || slug}</h2>
      {tenant && (
        <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 12 }}>
          {slug} · {tenant.db_name} · Tarif {tenant.tariff}
          {tenant.status === "suspended" && (
            <span style={{ color: "#e0a340", marginLeft: 8 }}>gesperrt</span>
          )}
        </div>
      )}

      {tenant && (
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 14,
            marginBottom: 20,
            background: "var(--panel)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Kundendaten</span>
            {!editingCustomer && (
              <button className="btn" onClick={() => setEditingCustomer(true)}>
                Bearbeiten
              </button>
            )}
          </div>

          {editingCustomer ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
              <div>
                <label style={{ fontSize: 11, color: "var(--text-dim)" }}>Anzeigename</label>
                <input
                  value={customerForm.displayName}
                  onChange={(e) => setCustomerForm((f) => ({ ...f, displayName: e.target.value }))}
                  style={{ width: "100%" }}
                />
              </div>
              <div>
                <label style={{ fontSize: 11, color: "var(--text-dim)" }}>Kontakt-E-Mail</label>
                <input
                  type="email"
                  value={customerForm.contactEmail}
                  onChange={(e) => setCustomerForm((f) => ({ ...f, contactEmail: e.target.value }))}
                  style={{ width: "100%" }}
                />
              </div>
              <div>
                <label style={{ fontSize: 11, color: "var(--text-dim)" }}>Notiz</label>
                <textarea
                  rows={3}
                  value={customerForm.notes}
                  onChange={(e) => setCustomerForm((f) => ({ ...f, notes: e.target.value }))}
                  style={{ width: "100%" }}
                />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-primary" onClick={handleSaveCustomer} disabled={savingCustomer}>
                  {savingCustomer ? "Speichere…" : "Speichern"}
                </button>
                <button className="btn" onClick={() => setEditingCustomer(false)} disabled={savingCustomer}>
                  Abbrechen
                </button>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 8, fontSize: 13, color: "var(--text-dim)", display: "flex", flexDirection: "column", gap: 4 }}>
              <span>{tenant.contact_email || "Keine Kontakt-E-Mail hinterlegt."}</span>
              {tenant.notes && <span style={{ whiteSpace: "pre-wrap" }}>{tenant.notes}</span>}
            </div>
          )}
        </div>
      )}

      {tenant && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 20 }}>
          <button className="btn" onClick={() => setRotateTarget("jwt")} disabled={rotating !== null}>
            {rotating === "jwt" ? "Rotiere…" : "JWT-Secret rotieren"}
          </button>
          <button className="btn" onClick={() => setRotateTarget("minio")} disabled={rotating !== null}>
            {rotating === "minio" ? "Rotiere…" : "MinIO-Secret rotieren"}
          </button>
          {rotateNote && <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{rotateNote}</span>}
        </div>
      )}

      <ConfirmDialog
        open={!!rotateTarget}
        onClose={() => setRotateTarget(null)}
        onConfirm={() => rotateTarget && handleRotate(rotateTarget)}
        title={`${rotateTarget === "jwt" ? "JWT-Secret" : "MinIO-Secret"} rotieren`}
        description={`Für "${slug}". Bestehende Sessions/Zugriffe können ungültig werden.`}
        confirmLabel="Rotieren"
      />

      {!project && (
        <form
          onSubmit={handleConnect}
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 10,
            padding: 14,
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--panel)",
          }}
        >
          {!manualEntry && repos && repos.length > 0 && (
            <select
              value={repos.find((r) => r.cloneUrl === repoUrl)?.fullName || ""}
              onChange={(e) => handleRepoSelect(e.target.value)}
              style={{ minWidth: 320 }}
              required
            >
              <option value="" disabled>
                Repo auswählen…
              </option>
              {repos.map((r) => (
                <option key={r.fullName} value={r.fullName}>
                  {r.fullName}
                  {r.private ? " (privat)" : ""}
                </option>
              ))}
            </select>
          )}

          {!manualEntry && (!repos || repos.length === 0) && !reposError && (
            <span style={{ color: "var(--text-dim)", fontSize: 13 }}>Lade Repos…</span>
          )}

          {manualEntry && (
            <input
              placeholder="Repo-URL (https://github.com/...)"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              style={{ minWidth: 320 }}
              required
            />
          )}

          <input
            placeholder="Branch"
            value={defaultBranch}
            onChange={(e) => setDefaultBranch(e.target.value)}
            style={{ width: 100 }}
          />
          <button className="btn btn-primary" type="submit" disabled={connecting || !repoUrl}>
            {connecting ? "Verbinde…" : "Projekt verbinden"}
          </button>
          {repos && repos.length > 0 && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setManualEntry((v) => !v);
                setRepoUrl("");
              }}
            >
              {manualEntry ? "Aus Liste wählen" : "URL manuell eintragen"}
            </button>
          )}
          {connectError && <span style={{ color: "var(--danger)" }}>{connectError}</span>}
          {reposError && (
            <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{reposError}</span>
          )}
        </form>
      )}

      {project && (
        <div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16 }}>
            <button className="btn btn-primary" onClick={handleDeploy} disabled={deploying}>
              {deploying ? "Löse aus…" : "Deploy"}
            </button>
            {project.active_container && <span className="pk-badge">live: {project.active_container}</span>}
          </div>
          <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
            Repo: {project.repo_url} ({project.default_branch})
          </div>
          {previewHostname && (
            <div style={{ fontSize: 13, marginTop: 6 }}>
              Preview:{" "}
              <a href={`https://${previewHostname}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                {previewHostname}
              </a>
            </div>
          )}
          {webhookNote && (
            <div style={{ fontSize: 12, marginTop: 10, color: "var(--text-dim)" }}>{webhookNote}</div>
          )}
        </div>
      )}
    </div>
  );
}
SLUGPAGE_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/app/dashboard/projects/[slug]/domains/page.tsx")"
cat > "$DASHBOARD_SRC/app/dashboard/projects/[slug]/domains/page.tsx" << 'DOMAINSPAGE_EOF'
"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { Modal, CopyValue } from "@/components/Modal";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { useProject } from "@/components/ProjectContext";

interface Instruction {
  type: "A" | "CNAME";
  name: string;
  value: string;
  ttl: number;
  note?: string;
}

interface Domain {
  id: string;
  hostname: string;
  kind: string;
  status: string;
  dns_verified: boolean;
  tls_issued: boolean;
  last_check_at: string | null;
  last_error: string | null;
  verification_method: string | null;
  is_primary: boolean;
  created_at: string;
  instructions: Instruction[];
}

const STATUS_META: Record<string, { label: string; color: string; dot: string }> = {
  live:        { label: "Live",                  color: "var(--success, #16a34a)", dot: "#16a34a" },
  tls_pending: { label: "Zertifikat wird ausgestellt", color: "#ca8a04",           dot: "#ca8a04" },
  dns_ok:      { label: "DNS OK",                color: "#ca8a04",                 dot: "#ca8a04" },
  pending_dns: { label: "Warte auf DNS",         color: "var(--text-muted)",       dot: "#9ca3af" },
  failed:      { label: "Fehlgeschlagen",        color: "var(--danger, #dc2626)",  dot: "#dc2626" },
};

function relTime(iso: string | null): string {
  if (!iso) return "noch nie geprüft";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "gerade eben";
  if (m < 60) return `vor ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `vor ${h} h`;
  return `vor ${Math.floor(h / 24)} Tagen`;
}

function InstructionTable({ instructions }: { instructions: Instruction[] }) {
  if (!instructions?.length) return null;
  return (
    <div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
            <th style={{ padding: "6px 8px 6px 0", fontWeight: 500 }}>Typ</th>
            <th style={{ padding: "6px 8px", fontWeight: 500 }}>Name</th>
            <th style={{ padding: "6px 8px", fontWeight: 500 }}>Wert</th>
            <th style={{ padding: "6px 0 6px 8px", fontWeight: 500 }}>TTL</th>
          </tr>
        </thead>
        <tbody>
          {instructions.map((r, i) => (
            <tr key={i} style={{ borderTop: "1px solid var(--border)" }}>
              <td style={{ padding: "8px 8px 8px 0" }}><strong>{r.type}</strong></td>
              <td style={{ padding: "8px" }}><CopyValue value={r.name} /></td>
              <td style={{ padding: "8px" }}><CopyValue value={r.value} /></td>
              <td style={{ padding: "8px 0 8px 8px", color: "var(--text-muted)" }}>{r.ttl}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {instructions.some((r) => r.note) && (
        <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--text-muted)" }}>
          {instructions.filter((r) => r.note).map((r, i) => (
            <li key={i} style={{ marginBottom: 3 }}><strong>{r.type}:</strong> {r.note}</li>
          ))}
        </ul>
      )}
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10, marginBottom: 0 }}>
        Es genügt <strong>einer</strong> dieser Einträge. Nach dem Speichern beim Registrar
        kann die Verbreitung wenige Minuten bis 24 Stunden dauern.
      </p>
    </div>
  );
}

export default function DomainsPage() {
  const params = useParams();
  const slug = params.slug as string;
  const { project, loading: projectLoading } = useProject();

  const [domains, setDomains] = useState<Domain[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Domain | null>(null);
  const toastApi = useToast();

  // Dialog-Zustand
  const [modalOpen, setModalOpen] = useState(false);
  const [newHost, setNewHost] = useState("");
  const [adding, setAdding] = useState(false);
  const [addResult, setAddResult] = useState<any>(null);

  const notify = (msg: string, kind: "ok" | "err" = "ok") => {
    if (kind === "ok") toastApi.success(msg);
    else toastApi.error(msg);
  };

  const loadDomains = useCallback(async (projectId: string) => {
    const res = await fetch(`/api/domains?projectId=${projectId}`);
    const data = await res.json();
    setDomains(Array.isArray(data) ? data : []);
  }, []);

  useEffect(() => {
    if (project) loadDomains(project.id);
  }, [project, loadDomains]);

  // Polling nur solange etwas offen ist — und nur bei sichtbarem Tab (P3-2).
  useEffect(() => {
    if (!project) return;
    const pending = domains.some((d) => d.status !== "live" && d.status !== "failed");
    if (!pending) return;
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") loadDomains(project.id);
    }, 15000);
    return () => clearInterval(iv);
  }, [project, domains, loadDomains]);

  async function handleAdd() {
    if (!project || !newHost.trim()) return;
    setAdding(true);
    setAddResult(null);
    try {
      const res = await fetch("/api/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, hostname: newHost.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAddResult({ error: data.error || "Fehler beim Anlegen." });
      } else {
        setAddResult(data);
        await loadDomains(project.id);
      }
    } catch (err) {
      setAddResult({ error: (err as Error).message });
    } finally {
      setAdding(false);
    }
  }

  async function handleVerify(domainId: string) {
    setVerifying(domainId);
    try {
      const res = await fetch(`/api/domains/${domainId}/verify`, { method: "POST" });
      const data = await res.json();
      if (project) await loadDomains(project.id);
      if (data.status === "live") notify("Domain ist live.", "ok");
      else if (data.status === "tls_pending") notify("DNS stimmt. Zertifikat wird ausgestellt — in ~60 Sekunden erneut prüfen.", "ok");
      else notify(data.error || "Noch nicht verifiziert.", "err");
    } catch (err) {
      notify((err as Error).message, "err");
    } finally {
      setVerifying(null);
    }
  }

  async function handleSetPrimary(d: Domain) {
    const res = await fetch(`/api/domains/${d.id}/primary`, { method: "POST" });
    const data = await res.json();
    if (res.ok) {
      notify(`${d.hostname} ist jetzt Primärdomain. Alle anderen leiten per 301 dorthin um.`, "ok");
      if (project) await loadDomains(project.id);
    } else {
      notify(data.error || "Fehlgeschlagen.", "err");
    }
  }

  async function handleDelete(d: Domain) {
    const res = await fetch(`/api/domains/${d.id}`, { method: "DELETE" });
    const data = await res.json();
    if (res.ok) {
      notify(`${d.hostname} entfernt.`, "ok");
      if (project) await loadDomains(project.id);
    } else {
      notify(data.error || "Löschen fehlgeschlagen.", "err");
    }
  }

  if (projectLoading) return <p style={{ color: "var(--text-muted)" }}>Lade…</p>;
  if (!project) return <p style={{ color: "var(--text-muted)" }}>Kein Projekt für diesen Tenant.</p>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Domains</h2>
        <button className="btn btn-primary" onClick={() => { setNewHost(""); setAddResult(null); setModalOpen(true); }}>
          Domain hinzufügen
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {domains.map((d) => {
          const meta = STATUS_META[d.status] || STATUS_META.pending_dns;
          const isOpen = expanded === d.id;
          return (
            <div key={d.id} style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-card)" }}>
              <div style={{ padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: meta.dot, flexShrink: 0 }} />
                    <a href={`https://${d.hostname}`} target="_blank" rel="noreferrer"
                       style={{ fontWeight: 500, wordBreak: "break-all", color: "inherit" }}>
                      {d.hostname}
                    </a>
                    {d.is_primary && (
                      <span style={{ fontSize: 11, color: "#16a34a", border: "1px solid #16a34a",
                                     borderRadius: 4, padding: "1px 5px" }}>
                        Primär
                      </span>
                    )}
                    {d.kind === "subdomain" && (
                      <span style={{ fontSize: 11, color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 5px" }}>
                        Preview
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: meta.color, marginTop: 4 }}>
                    {meta.label}
                    {d.verification_method && <span style={{ color: "var(--text-muted)" }}> · via {d.verification_method}</span>}
                    {d.kind === "custom" && <span style={{ color: "var(--text-muted)" }}> · {relTime(d.last_check_at)}</span>}
                    {d.kind === "custom" && !d.is_primary && domains.some((x) => x.is_primary) && (
                      <span style={{ color: "var(--text-muted)" }}>
                        {" "}· leitet weiter auf {domains.find((x) => x.is_primary)?.hostname}
                      </span>
                    )}
                  </div>
                  {d.last_error && d.status !== "live" && (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.5 }}>
                      {d.last_error}
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  {d.kind === "custom" && (
                    <>
                      <button className="btn" onClick={() => setExpanded(isOpen ? null : d.id)}>
                        {isOpen ? "Konfiguration ausblenden" : "DNS-Konfiguration"}
                      </button>
                      <button className="btn" onClick={() => handleVerify(d.id)} disabled={verifying === d.id}>
                        {verifying === d.id ? "Prüfe…" : "Erneut prüfen"}
                      </button>
                      {!d.is_primary && (d.status === "live" || d.status === "tls_pending") && (
                        <button className="btn" onClick={() => handleSetPrimary(d)}>Als Primär</button>
                      )}
                      <button className="btn btn-danger" onClick={() => setDeleteTarget(d)}>Entfernen</button>
                    </>
                  )}
                </div>
              </div>

              {isOpen && (
                <div style={{ borderTop: "1px solid var(--border)", padding: "14px 16px", background: "var(--bg-subtle, rgba(0,0,0,0.02))" }}>
                  <InstructionTable instructions={d.instructions} />
                </div>
              )}
            </div>
          );
        })}
        {domains.length === 0 && (
          <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Noch keine Domains.</p>
        )}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Domain hinzufügen">
        {!addResult && (
          <>
            <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 0 }}>
              Hostname eintragen, den der Kunde nutzen soll. Die nötigen DNS-Einträge
              zeigen wir im nächsten Schritt — und dauerhaft in der Domain-Liste.
            </p>
            <input
              value={newHost}
              onChange={(e) => setNewHost(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              placeholder="kunde.at oder www.kunde.at"
              style={{
                width: "100%", padding: "10px 12px", borderRadius: 8,
                border: "1px solid var(--border)", background: "var(--bg)",
                color: "var(--text)", fontSize: 14, marginBottom: 14,
              }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setModalOpen(false)}>Abbrechen</button>
              <button className="btn btn-primary" onClick={handleAdd} disabled={adding || !newHost.trim()}>
                {adding ? "Lege an…" : "Hinzufügen"}
              </button>
            </div>
          </>
        )}

        {addResult?.error && (
          <>
            <div style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid #dc2626",
                          background: "rgba(220,38,38,0.08)", color: "#dc2626", fontSize: 13, marginBottom: 14 }}>
              {addResult.error}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setAddResult(null)}>Zurück</button>
            </div>
          </>
        )}

        {addResult && !addResult.error && (
          <>
            <p style={{ fontSize: 14, marginTop: 0 }}>
              <strong>{addResult.hostname}</strong> ist angelegt.
            </p>

            {addResult.autoDns?.ok ? (
              <div style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid #16a34a",
                            background: "rgba(22,163,74,0.08)", color: "#16a34a", fontSize: 13, marginBottom: 14 }}>
                DNS-Eintrag automatisch über {addResult.autoDns.provider} gesetzt.
                Die Prüfung läuft im Hintergrund.
              </div>
            ) : (
              <div style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid var(--border)",
                            fontSize: 13, marginBottom: 14, color: "var(--text-muted)" }}>
                Kein automatischer Eintrag möglich — bitte beim Registrar setzen:
              </div>
            )}

            <InstructionTable instructions={addResult.instructions || []} />

            {(() => {
              const h: string = addResult.hostname || "";
              // kunde.at und www.kunde.at gehoeren zusammen — Kunden erwarten, dass
              // beide funktionieren. Wir schlagen die Gegenvariante direkt vor.
              const partner = h.startsWith("www.") ? h.slice(4) : `www.${h}`;
              const exists = domains.some((d) => d.hostname === partner);
              if (exists || h.split(".").length > 3) return null;
              return (
                <div style={{ marginTop: 16, padding: "10px 14px", borderRadius: 8,
                              border: "1px solid var(--border)", fontSize: 13 }}>
                  <strong>{partner}</strong> gleich mitanlegen? Eine der beiden wird
                  Primärdomain, die andere leitet per 301 dorthin um.
                  <div style={{ marginTop: 8 }}>
                    <button className="btn" onClick={() => { setNewHost(partner); setAddResult(null); }}>
                      {partner} hinzufügen
                    </button>
                  </div>
                </div>
              );
            })()}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 }}>
              <button className="btn" onClick={() => setModalOpen(false)}>Schließen</button>
              <button className="btn btn-primary"
                      onClick={async () => { await handleVerify(addResult.domainId); setModalOpen(false); }}>
                Eintrag gesetzt — jetzt prüfen
              </button>
            </div>
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && handleDelete(deleteTarget)}
        title={`${deleteTarget?.hostname ?? ""} entfernen`}
        description="Der Traefik-Router wird gelöscht, die Domain ist danach nicht mehr erreichbar."
        confirmLabel="Entfernen"
      />
    </div>
  );
}
DOMAINSPAGE_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/app/dashboard/projects/[slug]/env/page.tsx")"
cat > "$DASHBOARD_SRC/app/dashboard/projects/[slug]/env/page.tsx" << 'ENVPAGE_EOF'
"use client";

import { useEffect, useState, use, useCallback } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { useProject } from "@/components/ProjectContext";

interface EnvVar {
  key: string;
}

interface ApiKeys {
  postgrestUrl: string;
  anonKey: string;
  serviceRoleKey: string;
}

export default function EnvVarsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const { project } = useProject();
  const [vars, setVars] = useState<EnvVar[]>([]);
  const [envKey, setEnvKey] = useState("");
  const [envValue, setEnvValue] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKeys | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [bulkText, setBulkText] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkStatus, setBulkStatus] = useState<string | null>(null);
  const [keyToDelete, setKeyToDelete] = useState<string | null>(null);
  const toast = useToast();

  const loadVars = useCallback((projectId: string) => {
    fetch(`/api/projects/${projectId}/env`)
      .then((r) => r.json())
      // P2-7: bei 401/403 (o.ae.) ist die Antwort ein {error}-Objekt statt eines
      // Arrays - vorher wurde das still ignoriert, die Liste blieb leer ohne
      // jeden Hinweis, dass ueberhaupt ein Fehler aufgetreten ist.
      .then((d) => (Array.isArray(d) ? setVars(d) : setStatus(d?.error || "Env-Vars konnten nicht geladen werden")))
      .catch(() => setStatus("Verbindung zum Provisioning Agent fehlgeschlagen"));
  }, []);

  useEffect(() => {
    if (project) loadVars(project.id);
  }, [project, loadVars]);

  useEffect(() => {
    fetch(`/api/tenants/${slug}/api-keys`)
      .then((r) => r.json())
      .then((d) => d && d.anonKey && setApiKeys(d))
      .catch(() => {});
  }, [slug]);

  function copyToClipboard(label: string, value: string) {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  async function handleBulkImport() {
    if (!project || !bulkText.trim()) return;
    setBulkStatus("Importiere…");
    try {
      const res = await fetch(`/api/projects/${project.id}/env/bulk`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envText: bulkText }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBulkStatus(data.error || "Fehler beim Import");
        return;
      }
      setBulkStatus(
        `${data.imported} Variable${data.imported === 1 ? "" : "n"} importiert.` +
          (data.skipped?.length ? ` ${data.skipped.length} übersprungen (ungültiges Format).` : "")
      );
      setBulkText("");
      loadVars(project.id);
    } catch {
      setBulkStatus("Verbindung zum Provisioning Agent fehlgeschlagen");
    }
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setBulkText(String(reader.result || ""));
    reader.readAsText(file);
    e.target.value = "";
  }

  async function handleSet(e: React.FormEvent) {
    e.preventDefault();
    if (!project) return;
    if (!/^[A-Z0-9_]+$/.test(envKey)) {
      setStatus("Key: nur A-Z, 0-9, _ erlaubt");
      return;
    }
    setStatus("Speichere…");
    try {
      const res = await fetch(`/api/projects/${project.id}/env`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: envKey, value: envValue }),
      });
      const data = await res.json();
      setStatus(res.ok ? "Gespeichert." : data.error || "Fehler");
      if (res.ok) {
        setEnvKey("");
        setEnvValue("");
        loadVars(project.id);
      }
    } catch {
      setStatus("Verbindung zum Provisioning Agent fehlgeschlagen");
    }
  }

  async function handleDelete(key: string) {
    if (!project) return;
    const res = await fetch(`/api/projects/${project.id}/env`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (res.ok) {
      toast.success(`${key} gelöscht.`);
      loadVars(project.id);
    } else {
      toast.error("Löschen fehlgeschlagen");
    }
  }

  if (!project) return <div className="empty-state">Kein Projekt verbunden — siehe Übersicht-Tab.</div>;

  return (
    <div>
      {apiKeys && (
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 16,
            marginBottom: 24,
            background: "var(--panel)",
          }}
        >
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Project API Keys</h2>
          {[
            { label: "POSTGREST_URL", value: apiKeys.postgrestUrl },
            { label: "SUPABASE_ANON_KEY", value: apiKeys.anonKey },
            { label: "SUPABASE_SERVICE_ROLE_KEY", value: apiKeys.serviceRoleKey },
          ].map((row) => (
            <div
              key={row.label}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "10px 12px",
                marginBottom: 6,
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                gap: 8,
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {row.label} = {row.value}
              </span>
              <button className="btn" onClick={() => copyToClipboard(row.label, row.value)}>
                {copied === row.label ? "Kopiert!" : "Copy"}
              </button>
            </div>
          ))}
          <div style={{ fontSize: 12, marginTop: 10, color: "var(--text-dim)" }}>
            ⚠️ Service Role Key umgeht sämtliche RLS-Policies — niemals im Frontend-Code der
            Kunden-App verwenden.
          </div>
        </div>
      )}

      <h2 style={{ marginTop: 0, fontSize: 16 }}>Environment Variables</h2>

      <div style={{ marginBottom: 20 }}>
        {vars.length === 0 && <div className="empty-state">Keine Env-Vars gesetzt.</div>}
        {vars.map((v) => (
          <div
            key={v.key}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "10px 12px",
              marginBottom: 6,
              background: "var(--panel)",
              fontFamily: "var(--font-mono)",
              fontSize: 13,
            }}
          >
            <span>{v.key} = ••••••••</span>
            <button className="btn btn-danger" onClick={() => setKeyToDelete(v.key)}>
              Löschen
            </button>
          </div>
        ))}
      </div>

      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 16,
          marginBottom: 20,
          background: "var(--panel)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>.env importieren</h3>
          <button className="btn" onClick={() => setBulkOpen((v) => !v)}>
            {bulkOpen ? "Zuklappen" : "Öffnen"}
          </button>
        </div>
        {bulkOpen && (
          <div style={{ marginTop: 10 }}>
            <textarea
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={"KEY=value\nANOTHER_KEY=value2"}
              rows={8}
              style={{
                width: "100%",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                boxSizing: "border-box",
                resize: "vertical",
              }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
              <input type="file" accept=".env,text/plain" onChange={handleFileUpload} />
              <button className="btn btn-primary" onClick={handleBulkImport} disabled={!bulkText.trim()}>
                Importieren
              </button>
            </div>
            {bulkStatus && <div style={{ fontSize: 12, marginTop: 6, color: "var(--text-dim)" }}>{bulkStatus}</div>}
            <div style={{ fontSize: 11, marginTop: 6, color: "var(--text-faint)" }}>
              Bestehende Keys mit gleichem Namen werden überschrieben. Kommentare (#) und Leerzeilen werden ignoriert.
            </div>
          </div>
        )}
      </div>

      <form onSubmit={handleSet} style={{ display: "flex", gap: 8 }}>
        <input placeholder="KEY" value={envKey} onChange={(e) => setEnvKey(e.target.value.toUpperCase())} />
        <input placeholder="value" value={envValue} onChange={(e) => setEnvValue(e.target.value)} style={{ flex: 1 }} />
        <button className="btn btn-primary" type="submit">Setzen</button>
      </form>
      {status && <div style={{ fontSize: 12, marginTop: 6, color: "var(--text-dim)" }}>{status}</div>}
      <div style={{ fontSize: 12, marginTop: 16, color: "var(--text-faint)" }}>
        Automatisch injiziert (nicht hier gesetzt): MINIO_*, S3_BUCKET_NAME, GOTRUE_URL, JWT_SECRET,
        POSTGREST_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
      </div>

      <ConfirmDialog
        open={!!keyToDelete}
        onClose={() => setKeyToDelete(null)}
        onConfirm={() => keyToDelete && handleDelete(keyToDelete)}
        title={`${keyToDelete ?? ""} löschen`}
        description="Wirkt erst nach dem nächsten Redeploy."
        confirmLabel="Löschen"
      />
    </div>
  );
}
ENVPAGE_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/app/dashboard/projects/[slug]/deployments/page.tsx")"
cat > "$DASHBOARD_SRC/app/dashboard/projects/[slug]/deployments/page.tsx" << 'DEPLOYPAGE_EOF'
"use client";

import { useEffect, useState, use, useCallback, useRef } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { useProject } from "@/components/ProjectContext";

interface Deployment {
  id: string;
  commit_sha: string | null;
  commit_message: string | null;
  status: string;
  container_name: string | null;
  image_tag: string | null;
  triggered_by: string;
  created_at: string;
  finished_at: string | null;
}

const ACTIVE_STATES = ["queued", "building", "healthchecking"];
const CANCELLABLE_STATES = ["queued", "building", "healthchecking"];

const STATUS_COLOR: Record<string, string> = {
  queued: "var(--text-dim)",
  building: "var(--accent)",
  healthchecking: "var(--accent)",
  deployed: "#2da44e",
  failed: "var(--danger)",
  rolled_back: "var(--text-dim)",
  cancelled: "var(--text-faint)",
};

function duration(start: string, end: string | null): string {
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const secs = Math.max(0, Math.round((e - s) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

// Nur fuer github.com-Repos - andere Provider (GitLab, Bitbucket, selbst-gehostet)
// haben andere Commit-URL-Schemata, das lohnt sich hier nicht zu raten.
function githubCommitUrl(repoUrl: string | null, sha: string | null): string | null {
  if (!repoUrl || !sha) return null;
  const m = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/.]+)(\.git)?\/?$/);
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}/commit/${sha}`;
}

function LogViewer({ slug, deployment }: { slug: string; deployment: Deployment }) {
  const [log, setLog] = useState("");
  const [loaded, setLoaded] = useState(false);
  const offsetRef = useRef(0);
  const isActive = ACTIVE_STATES.includes(deployment.status);

  const fetchDelta = useCallback(async () => {
    const res = await fetch(`/api/deployments/single/${deployment.id}?logOffset=${offsetRef.current}`);
    const data = await res.json();
    if (data.error) return;
    if (data.logDelta) {
      setLog((prev) => prev + data.logDelta);
    }
    offsetRef.current = data.logTotalLength ?? offsetRef.current;
    setLoaded(true);
  }, [deployment.id]);

  useEffect(() => {
    fetchDelta();
    if (!isActive) return;
    const interval = setInterval(fetchDelta, 2000);
    return () => clearInterval(interval);
  }, [fetchDelta, isActive]);

  return (
    <pre
      style={{
        marginTop: 8,
        maxHeight: 600,
        overflowY: "auto",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        background: "var(--bg)",
        padding: 8,
        borderRadius: 6,
        whiteSpace: "pre-wrap",
      }}
    >
      {loaded ? log || "(noch kein Log)" : "Lade…"}
    </pre>
  );
}

export default function DeploymentsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const { project, error: projectError } = useProject();
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [openLogs, setOpenLogs] = useState<Set<string>>(new Set());
  const [rollbackTarget, setRollbackTarget] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const toast = useToast();

  const loadDeployments = useCallback((projectId: string) => {
    fetch(`/api/deployments/${projectId}`)
      .then((r) => r.json())
      // P2-7: 401/403 kam vorher als leere Liste an, nicht als Fehlermeldung.
      .then((d) => (Array.isArray(d) ? setDeployments(d) : setError(d?.error || "Deployment-Historie konnte nicht geladen werden")))
      .catch(() => setError("Deployment-Historie konnte nicht geladen werden"));
  }, []);

  useEffect(() => {
    if (!project) return;
    loadDeployments(project.id);
    const interval = setInterval(() => {
      setDeployments((current) => {
        if (current.some((d) => ACTIVE_STATES.includes(d.status))) {
          loadDeployments(project.id);
        }
        return current;
      });
    }, 3000);
    return () => clearInterval(interval);
  }, [project, loadDeployments]);

  function toggleLogs(id: string) {
    setOpenLogs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function downloadLog(d: Deployment) {
    const res = await fetch(`/api/deployments/single/${d.id}`);
    const data = await res.json();
    const blob = new Blob([data.build_log || ""], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `deploy-${d.id.slice(0, 8)}-${d.status}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleDeploy() {
    if (!project) return;
    setDeploying(true);
    setError(null);
    try {
      const res = await fetch("/api/deployments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Deploy fehlgeschlagen");
        toast.error(data.error || "Deploy fehlgeschlagen");
        return;
      }
      loadDeployments(project.id);
    } catch {
      setError("Verbindung zum Provisioning Agent fehlgeschlagen");
      toast.error("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setDeploying(false);
    }
  }

  async function handleRollback(deploymentId: string) {
    if (!project) return;
    setError(null);
    try {
      const res = await fetch(`/api/deployments/${deploymentId}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Rollback fehlgeschlagen");
        toast.error(data.error || "Rollback fehlgeschlagen");
        return;
      }
      toast.success("Rollback gestartet.");
      loadDeployments(project.id);
    } catch {
      setError("Verbindung zum Provisioning Agent fehlgeschlagen");
      toast.error("Verbindung zum Provisioning Agent fehlgeschlagen");
    }
  }

  async function handleCancel(deploymentId: string) {
    if (!project) return;
    try {
      const res = await fetch(`/api/deployments/${deploymentId}/cancel`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Abbruch fehlgeschlagen");
        return;
      }
      toast.success(data.status === "cancel_requested" ? "Abbruch angefordert." : "Deployment abgebrochen.");
      loadDeployments(project.id);
    } catch {
      toast.error("Verbindung zum Provisioning Agent fehlgeschlagen");
    }
  }

  if (!project) return <div className="empty-state">{error || projectError || "Lade…"}</div>;

  return (
    <div>
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Deployments</h2>
        <button className="btn btn-primary" onClick={handleDeploy} disabled={deploying}>
          {deploying ? "Löse aus…" : "Deploy"}
        </button>
      </div>

      {error && <div className="error-box" style={{ marginBottom: 12 }}>{error}</div>}
      {deployments.length === 0 && <div className="empty-state">Noch kein Deployment.</div>}
      {deployments.map((d) => {
        const logsOpen = openLogs.has(d.id);
        const commitUrl = githubCommitUrl(project.repo_url, d.commit_sha);
        // P2-4: nicht mehr "letztes in der Liste", sondern das tatsaechlich live
        // geschaltete Deployment - bei einem fehlgeschlagenen letzten Deploy war
        // der Rollback-Button vorher genau dann weg, wenn man ihn brauchte.
        const canRollback = d.status === "deployed" && d.id !== project.active_deployment_id;
        const canCancel = CANCELLABLE_STATES.includes(d.status);
        return (
          <div
            key={d.id}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: 12,
              marginBottom: 8,
              background: "var(--panel)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span
                  style={{
                    display: "inline-block",
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: STATUS_COLOR[d.status] || "var(--text-dim)",
                  }}
                />
                <span className="pk-badge">{d.status}</span>
                {d.id === project.active_deployment_id && (
                  <span className="pk-badge" style={{ borderColor: "#2da44e", color: "#2da44e" }}>
                    aktiv
                  </span>
                )}
                <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
                  {commitUrl ? (
                    <a href={commitUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                      {d.commit_sha?.slice(0, 7)}
                    </a>
                  ) : (
                    d.commit_sha?.slice(0, 7) || "—"
                  )}
                  {d.commit_message && <> — {d.commit_message}</>} · {d.triggered_by} ·{" "}
                  {new Date(d.created_at).toLocaleString("de-DE")} ·{" "}
                  {duration(d.created_at, d.finished_at)}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn" onClick={() => toggleLogs(d.id)}>
                  {logsOpen ? "Logs verbergen" : "Logs anzeigen"}
                </button>
                <button className="btn" onClick={() => downloadLog(d)}>
                  Herunterladen
                </button>
                {canCancel && (
                  <button className="btn btn-danger" onClick={() => setCancelTarget(d.id)}>
                    Abbrechen
                  </button>
                )}
                {canRollback && (
                  <button className="btn" onClick={() => setRollbackTarget(d.id)}>
                    Rollback hierauf
                  </button>
                )}
              </div>
            </div>
            {logsOpen && <LogViewer slug={slug} deployment={d} />}
          </div>
        );
      })}

      <ConfirmDialog
        open={!!rollbackTarget}
        onClose={() => setRollbackTarget(null)}
        onConfirm={() => rollbackTarget && handleRollback(rollbackTarget)}
        title="Zurückrollen"
        description="Der zuletzt aktive Container wird gegen dieses Deployment getauscht."
        confirmLabel="Zurückrollen"
      />

      <ConfirmDialog
        open={!!cancelTarget}
        onClose={() => setCancelTarget(null)}
        onConfirm={() => cancelTarget && handleCancel(cancelTarget)}
        title="Deployment abbrechen"
        description="Der laufende Build/Healthcheck wird gestoppt, ein evtl. gestarteter Kandidat-Container entfernt. Bereits live geschaltete Deployments lassen sich nicht mehr abbrechen."
        confirmLabel="Abbrechen"
      />
    </div>
  );
}
DEPLOYPAGE_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/app/dashboard/projects/page.tsx")"
cat > "$DASHBOARD_SRC/app/dashboard/projects/page.tsx" << 'PROJECTSPAGE_EOF'
"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState, StatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/components/Toast";

interface Tenant {
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

interface Project {
  slug: string;
  tenant_slug: string;
  repo_url: string | null;
  active_container: string | null;
}

export default function ProjectsPage() {
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [tariff, setTariff] = useState("starter");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<Tenant | null>(null);
  const [statusTarget, setStatusTarget] = useState<{ tenant: Tenant; next: string } | null>(null);
  const [statusBusy, setStatusBusy] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const toast = useToast();

  function load() {
    setTenants(null);
    fetch("/api/tenants")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setTenants(d.tenants)))
      .catch(() => setError("Verbindung zum Dashboard fehlgeschlagen"));
    fetch("/api/projects")
      .then((r) => r.json())
      // P2-7: 401/403 kam vorher als leere Liste an (Repo/Live-Badges fehlten
      // dann kommentarlos) statt als sichtbarer Fehler.
      .then((d) => (Array.isArray(d) ? setProjects(d) : setProjectsError(d?.error || "Projektdaten konnten nicht geladen werden")))
      .catch(() => setProjectsError("Verbindung zum Provisioning Agent fehlgeschlagen"));
  }

  useEffect(() => {
    load();
  }, []);

  const filteredTenants = useMemo(() => {
    if (!tenants) return null;
    const q = search.trim().toLowerCase();
    if (!q) return tenants;
    // P2-6: Suche ueber Name UND Slug - bei fuenfzig Kunden ist der Slug allein
    // nicht mehr die zuverlaessigste Art, jemanden wiederzufinden.
    return tenants.filter(
      (t) => t.slug.toLowerCase().includes(q) || (t.display_name || "").toLowerCase().includes(q)
    );
  }, [tenants, search]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!/^[a-z0-9-]+$/.test(slug)) {
      setFormError("Slug: nur a-z, 0-9, - erlaubt");
      return;
    }
    setCreating(true);
    setFormError(null);
    try {
      const res = await fetch("/api/provision-tenant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantSlug: slug,
          tariff,
          displayName: displayName.trim() || undefined,
          contactEmail: contactEmail.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data.error || "Provisioning fehlgeschlagen");
        return;
      }
      setSlug("");
      setDisplayName("");
      setContactEmail("");
      setShowForm(false);
      load();
    } catch {
      setFormError("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(s: string) {
    setDeletingSlug(s);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/tenants/${s}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setDeleteError(data.error || "Löschen fehlgeschlagen");
        toast.error(data.error || "Löschen fehlgeschlagen");
        return;
      }
      toast.success(`"${s}" wurde entfernt.`);
      load();
    } catch {
      setDeleteError("Verbindung zum Provisioning Agent fehlgeschlagen");
      toast.error("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setDeletingSlug(null);
    }
  }

  async function handleStatusChange(t: Tenant, next: string) {
    setStatusBusy(t.slug);
    try {
      const res = await fetch(`/api/tenants/${t.slug}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Status-Änderung fehlgeschlagen");
        return;
      }
      if (data.warnings?.length) {
        toast.error(`Mit Warnungen: ${data.warnings.join("; ")}`);
      } else {
        toast.success(next === "suspended" ? `"${t.slug}" gesperrt.` : `"${t.slug}" reaktiviert.`);
      }
      load();
    } catch {
      toast.error("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setStatusBusy(null);
    }
  }

  return (
    <div className="content">
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Projekte</h2>
        <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Abbrechen" : "+ Neues Projekt"}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={handleCreate}
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            marginBottom: 18,
            padding: 14,
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--panel)",
            flexWrap: "wrap",
          }}
        >
          <input
            placeholder="slug (z.B. gutshof)"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            required
          />
          <input
            placeholder="Anzeigename (optional, sonst Slug)"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <input
            type="email"
            placeholder="Kontakt-E-Mail (optional)"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
          />
          <select value={tariff} onChange={(e) => setTariff(e.target.value)}>
            <option value="starter">Starter</option>
            <option value="business">Business</option>
            <option value="premium">Premium</option>
          </select>
          <button className="btn btn-primary" type="submit" disabled={creating}>
            {creating ? "Provisioniere… (~10-15s)" : "Anlegen"}
          </button>
          {formError && <span style={{ color: "var(--danger)" }}>{formError}</span>}
        </form>
      )}

      {tenants && tenants.length > 0 && (
        <input
          placeholder="Suche nach Name oder Slug…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ marginBottom: 14, maxWidth: 320 }}
        />
      )}

      {error && <div className="error-box">{error}</div>}
      {deleteError && <div className="error-box" style={{ marginBottom: 12 }}>{deleteError}</div>}
      {!tenants && !error && <div className="empty-state">Lade Projekte…</div>}
      {tenants && tenants.length === 0 && (
        <EmptyState
          title="Noch keine Projekte angelegt."
          hint="Ein Projekt legt eine eigene Datenbank, Auth-Instanz und einen MinIO-Bucket an."
          action={
            <button className="btn btn-primary" onClick={() => setShowForm(true)}>
              + Neues Projekt
            </button>
          }
        />
      )}
      {filteredTenants && tenants && tenants.length > 0 && filteredTenants.length === 0 && (
        <div className="empty-state">Keine Treffer für &quot;{search}&quot;.</div>
      )}

      <div className="card-grid">
        {filteredTenants?.map((t) => {
          const project = projects.find((p) => p.tenant_slug === t.slug);
          const suspended = t.status === "suspended";
          return (
            <div key={t.id} className="card" style={{ position: "relative", opacity: suspended ? 0.7 : 1 }}>
              <Link href={`/dashboard/projects/${t.slug}`}>
                <div className="card-title">{t.display_name || t.slug}</div>
                {t.display_name && t.display_name !== t.slug && (
                  <div style={{ fontSize: 11, color: "var(--text-faint)" }}>{t.slug}</div>
                )}
                <div className="card-sub">
                  {project ? project.repo_url || "Repo nicht gesetzt" : "Kein Projekt verbunden"}
                </div>
                {t.contact_email && (
                  <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 2 }}>{t.contact_email}</div>
                )}
                <div style={{ marginTop: 10, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <span className="pk-badge">{t.tariff}</span>
                  <StatusBadge
                    label={suspended ? "gesperrt" : "aktiv"}
                    color={suspended ? "warn" : "success"}
                  />
                  {project?.active_container && !suspended && (
                    <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span
                        style={{
                          display: "inline-block",
                          width: 7,
                          height: 7,
                          borderRadius: "50%",
                          background: "#2da44e",
                        }}
                      />
                      <span className="pk-badge">live</span>
                    </span>
                  )}
                </div>
              </Link>
              <div style={{ position: "absolute", top: 10, right: 10, display: "flex", gap: 6 }}>
                <button
                  className="btn"
                  style={{ fontSize: 12 }}
                  onClick={(e) => {
                    e.preventDefault();
                    setStatusTarget({ tenant: t, next: suspended ? "active" : "suspended" });
                  }}
                  disabled={statusBusy === t.slug}
                >
                  {statusBusy === t.slug ? "…" : suspended ? "Reaktivieren" : "Sperren"}
                </button>
                <button
                  className="btn"
                  style={{ color: "var(--danger)" }}
                  onClick={(e) => {
                    e.preventDefault();
                    setConfirmTarget(t);
                  }}
                  disabled={deletingSlug === t.slug}
                >
                  {deletingSlug === t.slug ? "…" : "Löschen"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={!!confirmTarget}
        onClose={() => setConfirmTarget(null)}
        onConfirm={() => confirmTarget && handleDelete(confirmTarget.slug)}
        title={`Projekt "${confirmTarget?.slug ?? ""}" löschen`}
        description="Dieser Vorgang ist nicht rückgängig zu machen."
        level="destructive"
        confirmText={confirmTarget?.slug}
        confirmLabel="Endgültig löschen"
        resources={[
          `Datenbank kunde_${confirmTarget?.slug ?? ""}`,
          "Alle Docker-Container (App, Auth, API)",
          "MinIO-Bucket und IAM-Policy",
          "Traefik-Router aller verbundenen Domains",
          "Projekt- und Deployment-Einträge",
        ]}
      />

      <ConfirmDialog
        open={!!statusTarget}
        onClose={() => setStatusTarget(null)}
        onConfirm={() => statusTarget && handleStatusChange(statusTarget.tenant, statusTarget.next)}
        title={statusTarget?.next === "suspended" ? "Kunde sperren" : "Kunde reaktivieren"}
        description={
          statusTarget?.next === "suspended"
            ? "Container werden gestoppt und die Traefik-Router entfernt. Datenbank, Secrets und alle Einstellungen bleiben erhalten — jederzeit reaktivierbar."
            : "Container werden wieder gestartet und die Domains erneut geroutet."
        }
        confirmLabel={statusTarget?.next === "suspended" ? "Sperren" : "Reaktivieren"}
      />
    </div>
  );
}
PROJECTSPAGE_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/app/api/audit-logs/route.ts")"
cat > "$DASHBOARD_SRC/app/api/audit-logs/route.ts" << 'AUDITAPI_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function GET(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const { status, body } = await agentFetch(`/audit-logs${url.search}`);
  return NextResponse.json(body, { status });
}
AUDITAPI_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/app/dashboard/audit/page.tsx")"
cat > "$DASHBOARD_SRC/app/dashboard/audit/page.tsx" << 'AUDITPAGE_EOF'
"use client";

import { useCallback, useEffect, useState } from "react";

interface AuditLog {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

const PAGE_SIZE = 50;

function toCsv(logs: AuditLog[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ["created_at,actor,action,target,meta"];
  for (const l of logs) {
    lines.push([l.created_at, l.actor, l.action, l.target ?? "", JSON.stringify(l.meta ?? {})].map(esc).join(","));
  }
  return lines.join("\n");
}

export default function AuditLogPage() {
  const [logs, setLogs] = useState<AuditLog[] | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [actions, setActions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [actionFilter, setActionFilter] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [exporting, setExporting] = useState(false);

  const load = useCallback(() => {
    setLogs(null);
    const q = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
    if (actionFilter) q.set("action", actionFilter);
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    fetch(`/api/audit-logs?${q.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) {
          setError(d.error);
          return;
        }
        setLogs(d.logs || []);
        setTotalCount(d.totalCount ?? 0);
        setActions(d.actions || []);
        setError(null);
      })
      .catch(() => setError("Verbindung zum Provisioning Agent fehlgeschlagen"));
  }, [page, actionFilter, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleExport() {
    setExporting(true);
    try {
      const q = new URLSearchParams({ limit: "500", offset: "0" });
      if (actionFilter) q.set("action", actionFilter);
      if (from) q.set("from", from);
      if (to) q.set("to", to);
      const res = await fetch(`/api/audit-logs?${q.toString()}`);
      const data = await res.json();
      const csv = toCsv(data.logs || []);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "audit-log.csv";
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <div className="content">
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Audit-Log</h2>
        <button className="btn" onClick={handleExport} disabled={exporting}>
          {exporting ? "…" : "CSV-Export (max. 500)"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <select
          value={actionFilter}
          onChange={(e) => {
            setPage(0);
            setActionFilter(e.target.value);
          }}
        >
          <option value="">Alle Aktionen</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <label style={{ fontSize: 12, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 4 }}>
          von
          <input
            type="date"
            value={from}
            onChange={(e) => {
              setPage(0);
              setFrom(e.target.value);
            }}
          />
        </label>
        <label style={{ fontSize: 12, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 4 }}>
          bis
          <input
            type="date"
            value={to}
            onChange={(e) => {
              setPage(0);
              setTo(e.target.value);
            }}
          />
        </label>
        {(actionFilter || from || to) && (
          <button
            className="btn"
            onClick={() => {
              setActionFilter("");
              setFrom("");
              setTo("");
              setPage(0);
            }}
          >
            Filter zurücksetzen
          </button>
        )}
      </div>

      {error && <div className="error-box">{error}</div>}
      {!logs && !error && <div className="empty-state">Lade…</div>}
      {logs && logs.length === 0 && <div className="empty-state">Keine Einträge für diesen Filter.</div>}
      {logs?.map((l) => (
        <div
          key={l.id}
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 10,
            marginBottom: 6,
            background: "var(--panel)",
            fontSize: 13,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>
              <span className="pk-badge">{l.action}</span>{" "}
              {l.target && <span style={{ color: "var(--text-dim)" }}>{l.target}</span>}
            </span>
            <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
              {new Date(l.created_at).toLocaleString("de-DE")}
            </span>
          </div>
          {l.meta && Object.keys(l.meta).length > 0 && (
            <pre
              style={{
                marginTop: 6,
                fontSize: 11,
                color: "var(--text-dim)",
                fontFamily: "var(--font-mono)",
                whiteSpace: "pre-wrap",
              }}
            >
              {JSON.stringify(l.meta)}
            </pre>
          )}
        </div>
      ))}

      {logs && logs.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
          <button className="btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            ← Zurück
          </button>
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
            Seite {page + 1} von {totalPages} · {totalCount} Einträge
          </span>
          <button className="btn" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>
            Weiter →
          </button>
        </div>
      )}
    </div>
  );
}
AUDITPAGE_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/app/icon.tsx")"
cat > "$DASHBOARD_SRC/app/icon.tsx" << 'ICON_EOF'
import { ImageResponse } from "next/og";

// P2-7: Kein Favicon vorhanden - Next.js' Datei-Konvention generiert es hier
// zur Build-/Request-Zeit als SVG, kein Binaer-Asset noetig.
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#6c8eef",
          color: "#fff",
          fontSize: 20,
          fontWeight: 700,
          borderRadius: 6,
        }}
      >
        U
      </div>
    ),
    { ...size }
  );
}
ICON_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/app/error.tsx")"
cat > "$DASHBOARD_SRC/app/error.tsx" << 'ERRORPAGE_EOF'
"use client";

// P2-7: kein error.tsx vorhanden - ein Rendering-Fehler zeigte bisher die
// generische Next.js-Fehlerseite ohne jeden Bezug zur Plattform.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        gap: 12,
        padding: 24,
        textAlign: "center",
        fontFamily: "-apple-system, sans-serif",
        background: "#0a0c10",
        color: "#e4e7eb",
      }}
    >
      <h1 style={{ fontSize: 18, margin: 0 }}>Etwas ist schiefgelaufen</h1>
      <p style={{ fontSize: 13, color: "#8a93a0", maxWidth: 480, margin: 0 }}>
        {error.message || "Unbekannter Fehler."}
        {error.digest && ` (${error.digest})`}
      </p>
      <button
        onClick={reset}
        style={{
          marginTop: 8,
          padding: "8px 16px",
          borderRadius: 6,
          border: "1px solid #232830",
          background: "#171b21",
          color: "#e4e7eb",
          cursor: "pointer",
        }}
      >
        Erneut versuchen
      </button>
    </div>
  );
}
ERRORPAGE_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/app/not-found.tsx")"
cat > "$DASHBOARD_SRC/app/not-found.tsx" << 'NOTFOUND_EOF'
import Link from "next/link";

// P2-7: kein not-found.tsx vorhanden - eine falsche URL zeigte die generische
// Next.js-404-Seite statt einen Weg zurueck ins Dashboard.
export default function NotFound() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        gap: 12,
        padding: 24,
        textAlign: "center",
        fontFamily: "-apple-system, sans-serif",
        background: "#0a0c10",
        color: "#e4e7eb",
      }}
    >
      <h1 style={{ fontSize: 18, margin: 0 }}>Seite nicht gefunden</h1>
      <p style={{ fontSize: 13, color: "#8a93a0", margin: 0 }}>
        Diese Adresse existiert nicht oder wurde verschoben.
      </p>
      <Link
        href="/dashboard/projects"
        style={{
          marginTop: 8,
          padding: "8px 16px",
          borderRadius: 6,
          border: "1px solid #232830",
          background: "#171b21",
          color: "#e4e7eb",
          textDecoration: "none",
        }}
      >
        Zurück zu Projekte
      </Link>
    </div>
  );
}
NOTFOUND_EOF


echo "== Migration anwenden =="
if [[ -x "$PLATFORM_DIR/scripts/migrate.sh" ]]; then
  bash "$PLATFORM_DIR/scripts/migrate.sh"
else
  echo "scripts/migrate.sh nicht gefunden - wende 15_cleanup_orphaned_projects.sql direkt an"
  docker exec -i core-postgres psql -U postgres -v ON_ERROR_STOP=1 -q < "$PLATFORM_DIR/core-postgres/init-scripts/15_cleanup_orphaned_projects.sql"
fi

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
