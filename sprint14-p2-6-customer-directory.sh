#!/usr/bin/env bash
# Sprint 14 — P2-6: Kundenstamm (Name/Kontakt/Status statt nur Slug)
# Auf der VPS ausführen: /opt/multitenant-platform
#
# Was passiert:
#   - Neue Migration 14_customer_directory.sql: kunden.display_name,
#     contact_email, notes, status ('active'/'suspended', Default 'active')
#   - index.ts POST /tenants nimmt jetzt displayName/contactEmail/notes an
#     (fiel bisher auf den Slug zurueck bzw. wurde nie gespeichert)
#   - routes/tenants.ts: neu GET/PATCH /tenants/:slug (reine Stammdaten,
#     keine Seiteneffekte) und POST /tenants/:slug/status - der eigentliche
#     Kern von P2-6: 'suspended' stoppt alle Container des Tenants + entfernt
#     die Traefik-Router, laesst DB/Secrets/Bucket unangetastet; 'active'
#     startet die Container neu und stellt die Router ueber
#     syncProjectRouters() wieder her. Vorher gab es nur "laufen lassen oder
#     endgueltig loeschen" - der Standardfall bei Zahlungsverzug fehlte.
#   - Dashboard: neue Routen /api/tenants/:slug (PATCH), /api/tenants/:slug/status
#   - projects/page.tsx: Suche ueber Name+Slug, Anzeigename+Kontakt-E-Mail im
#     Anlegen-Formular, Status-Badge, Sperren/Reaktivieren-Button
#   - [slug]/page.tsx: editierbare "Kundendaten"-Karte (Name, Kontakt, Notiz)
#   - Migration wird angewandt, Rebuild + Neustart von Agent UND Dashboard
#
# Rollback: ./sprint14-p2-6-customer-directory.sh --rollback _backup-sprint14-<timestamp>
# Hinweis: Migration ist additiv, die neuen kunden-Spalten bleiben beim
# Rollback bestehen (nur der Code faellt zurueck, nicht bereits gepflegte Daten).

set -euo pipefail

PLATFORM_DIR="/opt/multitenant-platform"
DASHBOARD_SRC="$PLATFORM_DIR/dashboard/src"
AGENT_SRC="$PLATFORM_DIR/provisioning-agent/src"
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$PLATFORM_DIR/_backup-sprint14-$TS"

FILES=(
  "provisioning-agent/src/index.ts"
  "provisioning-agent/src/routes/tenants.ts"
  "dashboard/src/lib/adminDb.ts"
  "dashboard/src/app/api/tenants/[slug]/route.ts"
  "dashboard/src/app/dashboard/projects/page.tsx"
  "dashboard/src/app/dashboard/projects/[slug]/page.tsx"
)
NEW_FILES=(
  "core-postgres/init-scripts/14_customer_directory.sql"
  "dashboard/src/app/api/tenants/[slug]/status/route.ts"
)

if [[ "${1:-}" == "--rollback" ]]; then
  RESTORE_FROM="${2:?Verzeichnis angeben: ./sprint14-p2-6-customer-directory.sh --rollback _backup-sprint14-XXXXXXXX-XXXXXX}"
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
    echo "  removed (war neu in Sprint 14): $f"
  done
  find "dashboard/src/app/api/tenants/[slug]/status" -type d -empty -delete 2>/dev/null || true
  echo "Rebuild..."
  cd "$PLATFORM_DIR/provisioning-agent" && docker compose --env-file ../.env build && docker compose --env-file ../.env up -d
  cd "$PLATFORM_DIR/dashboard" && docker compose --env-file ../.env build && docker compose --env-file ../.env up -d
  echo "Rollback abgeschlossen. Hinweis: neue kunden-Spalten bleiben in der DB bestehen."
  exit 0
fi

echo "== Sprint 14 (P2-6): Backup nach $BACKUP_DIR =="
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

mkdir -p "$(dirname "$PLATFORM_DIR/core-postgres/init-scripts/14_customer_directory.sql")"
cat > "$PLATFORM_DIR/core-postgres/init-scripts/14_customer_directory.sql" << 'MIGRATION14_EOF'
-- P2-6: Kundenstamm - bisher kannte die Plattform von einem Kunden nur Slug
-- und Tarif. Bei zehn Kunden ist "gutshof" noch selbsterklaerend, bei fuenfzig
-- nicht mehr.
--
-- status='suspended' ist der Standardfall bei Zahlungsverzug: Container
-- stoppen, Traefik-Router entfernen, DB behalten - vorher gab es nur
-- "loeschen oder laufen lassen" (siehe routes/tenants.ts POST .../status).
--
-- Idempotent.
\connect admin_dashboard

ALTER TABLE kunden ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE kunden ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE kunden ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE kunden ADD COLUMN IF NOT EXISTS status TEXT;

UPDATE kunden SET status = 'active' WHERE status IS NULL;

ALTER TABLE kunden ALTER COLUMN status SET DEFAULT 'active';
ALTER TABLE kunden DROP CONSTRAINT IF EXISTS kunden_status_check;
ALTER TABLE kunden ADD CONSTRAINT kunden_status_check CHECK (status IN ('active', 'suspended'));

CREATE INDEX IF NOT EXISTS idx_kunden_status ON kunden (status);
MIGRATION14_EOF

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

mkdir -p "$(dirname "$AGENT_SRC/routes/tenants.ts")"
cat > "$AGENT_SRC/routes/tenants.ts" << 'TENANTS_ROUTE_TS_EOF'
import { Router } from 'express';
import { Client as PGClient } from 'pg';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logAudit } from '../lib/audit';
import { writeTenantServiceRouter, removeTenantServiceRouter, removeAllRoutersForProject } from '../lib/traefikDynamic';
import { syncProjectRouters } from './domains';

const execFileP = promisify(execFile);
const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN || 'example.com';

function adminClient(): PGClient {
  return new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
}

export const tenantsRouter = Router();

// GET /tenants/:slug/api-keys — liefert die Supabase-kompatiblen JWTs für den Tenant
// (siehe lib/jwt.ts + Migration 09_tenant_api_keys.sql). Kein logAudit() mit den
// Werten selbst — nur die Tatsache des Zugriffs, analog zu project.env.set in
// routes/projects.ts, das den Wert bewusst nicht loggt.
tenantsRouter.get('/tenants/:slug/api-keys', async (req, res) => {
  const { slug } = req.params;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'invalid slug' });

  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT anon_jwt, service_role_jwt, postgrest_public_enabled, auth_public_enabled FROM kunden WHERE slug = $1`,
      [slug]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'tenant not found' });

    await logAudit('tenant.api-keys.viewed', slug, {});

    // P1-6: postgrestUrl/authUrl sind Docker-interne Hostnamen — die funktionieren
    // NUR fuer Server-zu-Server-Aufrufe innerhalb desselben traefik-net (z.B. aus dem
    // Kunden-App-Container heraus, siehe lib/secrets.ts buildEnvVars). Von ausserhalb
    // (Browser, Postman, externe Systeme des Kunden) sind sie nicht erreichbar — vorher
    // zeigte das Dashboard genau diese URL mit Copy-Button, ohne das kenntlich zu machen.
    // *PublicUrl ist nur gesetzt, wenn der jeweilige *_public_enabled-Schalter aktiv ist
    // (siehe POST /tenants/:slug/public-access) — bewusst opt-in, ein SQL-REST-Endpoint
    // ist standardmaessig nicht oeffentlich erreichbar.
    res.json({
      postgrestUrl: `http://api-${slug}:3000`,
      postgrestPublicUrl: rows[0].postgrest_public_enabled ? `https://${slug}-api.${PLATFORM_DOMAIN}` : null,
      postgrestPublicEnabled: !!rows[0].postgrest_public_enabled,
      authUrl: `http://auth-${slug}:9999`,
      authPublicUrl: rows[0].auth_public_enabled ? `https://${slug}-auth.${PLATFORM_DOMAIN}` : null,
      authPublicEnabled: !!rows[0].auth_public_enabled,
      anonKey: rows[0].anon_jwt,
      serviceRoleKey: rows[0].service_role_jwt,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// POST /tenants/:slug/public-access  { service: 'postgrest' | 'auth', enabled: boolean }
// P1-6: schaltet die oeffentliche Erreichbarkeit von PostgREST bzw. GoTrue frei/zu.
// Schreibt/entfernt einen eigenen Traefik-Router (siehe lib/traefikDynamic.ts) und
// persistiert den Schalter in kunden.postgrest_public_enabled / auth_public_enabled
// (Spalten existierten schon seit Migration 02, wurden bis jetzt nie gelesen).
tenantsRouter.post('/tenants/:slug/public-access', async (req, res) => {
  const { slug } = req.params;
  const { service, enabled } = req.body;

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'invalid slug' });
  if (!['postgrest', 'auth'].includes(service)) return res.status(400).json({ error: "service must be 'postgrest' or 'auth'" });
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });

  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query('SELECT slug FROM kunden WHERE slug = $1', [slug]);
    if (rows.length === 0) return res.status(404).json({ error: 'tenant not found' });

    const hostname = `${slug}-${service === 'postgrest' ? 'api' : 'auth'}.${PLATFORM_DOMAIN}`;
    let url: string | null = null;

    if (enabled) {
      await writeTenantServiceRouter(service, slug, hostname);
      url = `https://${hostname}`;
    } else {
      await removeTenantServiceRouter(service, slug);
    }

    const column = service === 'postgrest' ? 'postgrest_public_enabled' : 'auth_public_enabled';
    await db.query(`UPDATE kunden SET ${column} = $1 WHERE slug = $2`, [enabled, slug]);
    await logAudit('tenant.public-access.set', slug, { service, enabled });

    res.json({ status: 'ok', service, enabled, url });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// GET /tenants/:slug — Stammdaten fuer die Bearbeiten-Ansicht (P2-6).
tenantsRouter.get('/tenants/:slug', async (req, res) => {
  const { slug } = req.params;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'invalid slug' });

  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT id, slug, db_name, tariff, display_name, contact_email, notes, status, created_at
       FROM kunden WHERE slug = $1`,
      [slug]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'tenant not found' });
    res.json(rows[0]);
  } finally {
    await db.end();
  }
});

// PATCH /tenants/:slug  { displayName?, contactEmail?, notes?, tariff? } — reine
// Stammdaten-Aenderung ohne Seiteneffekte auf Container/Traefik (P2-6). Fuer den
// Status-Wechsel (aktiv/gesperrt) siehe POST /tenants/:slug/status, der hat welche.
tenantsRouter.patch('/tenants/:slug', async (req, res) => {
  const { slug } = req.params;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'invalid slug' });

  const { displayName, contactEmail, notes, tariff } = req.body;
  const sets: string[] = [];
  const vals: any[] = [];
  let i = 1;
  if (displayName !== undefined) { sets.push(`display_name = $${i++}`); vals.push(String(displayName).trim() || slug); }
  if (contactEmail !== undefined) { sets.push(`contact_email = $${i++}`); vals.push(contactEmail ? String(contactEmail).trim() : null); }
  if (notes !== undefined) { sets.push(`notes = $${i++}`); vals.push(notes ? String(notes).trim() : null); }
  if (tariff !== undefined) {
    if (!['starter', 'business', 'premium'].includes(tariff)) {
      return res.status(400).json({ error: 'invalid tariff' });
    }
    sets.push(`tariff = $${i++}`);
    vals.push(tariff);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'nothing to update' });
  vals.push(slug);

  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `UPDATE kunden SET ${sets.join(', ')} WHERE slug = $${i} RETURNING id, slug, display_name, contact_email, notes, tariff, status`,
      vals
    );
    if (rows.length === 0) return res.status(404).json({ error: 'tenant not found' });
    await logAudit('tenant.update', slug, { fields: Object.keys(req.body) });
    res.json(rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// POST /tenants/:slug/status  { status: 'active' | 'suspended' }
// P2-6: der Standardfall bei Zahlungsverzug - Container stoppen, Traefik-Router
// entfernen, DB UND alle Secrets bleiben unangetastet. Vorher gab es nur
// "laufen lassen oder komplett loeschen" (DELETE /tenants/:slug, unwiderruflich).
tenantsRouter.post('/tenants/:slug/status', async (req, res) => {
  const { slug } = req.params;
  const { status } = req.body;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'invalid slug' });
  if (!['active', 'suspended'].includes(status)) {
    return res.status(400).json({ error: "status must be 'active' or 'suspended'" });
  }

  const tenantDir = `/opt/multitenant-platform/kunden-instances/${slug}`;
  const db = adminClient();
  await db.connect();
  const warnings: string[] = [];
  try {
    const { rows: tenantRows } = await db.query('SELECT slug, status FROM kunden WHERE slug = $1', [slug]);
    if (tenantRows.length === 0) return res.status(404).json({ error: 'tenant not found' });
    if (tenantRows[0].status === status) {
      return res.json({ status, unchanged: true });
    }

    const { rows: projects } = await db.query(
      'SELECT id, slug AS project_slug, active_container FROM projects WHERE tenant_slug = $1',
      [slug]
    );

    if (status === 'suspended') {
      // Tenant-Instanz (auth/api) stoppen - 'stop' statt 'down', damit 'start'
      // beim Reaktivieren reicht und keine Container-IDs/Volumes neu entstehen.
      await execFileP('docker', ['compose', '-f', `${tenantDir}/docker-compose.yml`, 'stop']).catch((e: any) =>
        warnings.push(`Tenant-Container stoppen fehlgeschlagen: ${e.message}`)
      );
      for (const p of projects) {
        if (p.active_container) {
          await execFileP('docker', ['stop', p.active_container]).catch((e: any) =>
            warnings.push(`Container ${p.active_container} stoppen fehlgeschlagen: ${e.message}`)
          );
        }
        await removeAllRoutersForProject(p.project_slug).catch((e: any) =>
          warnings.push(`Router fuer ${p.project_slug} entfernen fehlgeschlagen: ${e.message}`)
        );
      }
    } else {
      // Reaktivieren: erst Container wieder hochfahren, dann Router neu schreiben -
      // syncProjectRouters braucht den aktuellen Domain-Stand aus der DB, nicht
      // den Container-Status, daher Reihenfolge hier unkritisch, aber Container
      // zuerst ist die intuitivere Lesart im Log.
      await execFileP('docker', ['compose', '-f', `${tenantDir}/docker-compose.yml`, 'start']).catch((e: any) =>
        warnings.push(`Tenant-Container starten fehlgeschlagen: ${e.message}`)
      );
      for (const p of projects) {
        if (p.active_container) {
          await execFileP('docker', ['start', p.active_container]).catch((e: any) =>
            warnings.push(`Container ${p.active_container} starten fehlgeschlagen: ${e.message}`)
          );
        }
        await syncProjectRouters(db, p.id).catch((e: any) =>
          warnings.push(`Router fuer ${p.project_slug} wiederherstellen fehlgeschlagen: ${e.message}`)
        );
      }
    }

    await db.query('UPDATE kunden SET status = $1 WHERE slug = $2', [status, slug]);
    await logAudit('tenant.status.set', slug, { status, warnings: warnings.length > 0 ? warnings : undefined });
    res.json({ status, warnings: warnings.length > 0 ? warnings : undefined });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});
TENANTS_ROUTE_TS_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/lib/adminDb.ts")"
cat > "$DASHBOARD_SRC/lib/adminDb.ts" << 'ADMINDB_EOF'
import { Pool } from "pg";

// Verbindung zur admin_dashboard-DB. Läuft über pgbouncer, wie in
// 10_env_reference.md § 2 (DATABASE_URL) vorgesehen.
let adminPool: Pool | null = null;

function getAdminPool(): Pool {
  if (!adminPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL fehlt (siehe 10_env_reference.md § 2)");
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

mkdir -p "$(dirname "$DASHBOARD_SRC/app/api/tenants/[slug]/route.ts")"
cat > "$DASHBOARD_SRC/app/api/tenants/[slug]/route.ts" << 'TENANTS_SLUG_API_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug } = await params;
  const { status, body } = await agentFetch(`/tenants/${slug}`, { method: "DELETE" });
  return NextResponse.json(body, { status });
}

// P2-6: Stammdaten (Name/Kontakt/Notiz/Tarif) - keine Container-/Traefik-
// Seiteneffekte, dafuer siehe /api/tenants/:slug/status.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug } = await params;
  const payload = await req.json();
  const { status, body } = await agentFetch(`/tenants/${slug}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  return NextResponse.json(body, { status });
}
TENANTS_SLUG_API_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/app/api/tenants/[slug]/status/route.ts")"
cat > "$DASHBOARD_SRC/app/api/tenants/[slug]/status/route.ts" << 'TENANTS_STATUS_API_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug } = await params;
  const payload = await req.json();
  const { status, body } = await agentFetch(`/tenants/${slug}/status`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return NextResponse.json(body, { status });
}
TENANTS_STATUS_API_EOF

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
  const toast = useToast();

  function load() {
    setTenants(null);
    fetch("/api/tenants")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setTenants(d.tenants)))
      .catch(() => setError("Verbindung zum Dashboard fehlgeschlagen"));
    fetch("/api/projects")
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setProjects(d))
      .catch(() => {});
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

mkdir -p "$(dirname "$DASHBOARD_SRC/app/dashboard/projects/[slug]/page.tsx")"
cat > "$DASHBOARD_SRC/app/dashboard/projects/[slug]/page.tsx" << 'SLUGPAGE_EOF'
"use client";

import { useEffect, useState, use } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";

interface Tenant {
  slug: string;
  db_name: string;
  tariff: string;
  display_name: string | null;
  contact_email: string | null;
  notes: string | null;
  status: string;
}

interface Project {
  id: string;
  slug: string;
  tenant_slug: string;
  repo_url: string | null;
  default_branch: string;
  active_container: string | null;
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
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [previewHostname, setPreviewHostname] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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
    fetch("/api/projects")
      .then((r) => r.json())
      .then((list) => {
        const p = Array.isArray(list) ? list.find((x: Project) => x.tenant_slug === slug) : null;
        setProject(p || null);
        setPreviewHostname(p?.preview_hostname || null);
        setLoading(false);
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
      setProject(data.project);
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


echo "== Migration anwenden =="
if [[ -x "$PLATFORM_DIR/scripts/migrate.sh" ]]; then
  bash "$PLATFORM_DIR/scripts/migrate.sh"
else
  echo "scripts/migrate.sh nicht gefunden - wende 14_customer_directory.sql direkt an"
  docker exec -i core-postgres psql -U postgres -v ON_ERROR_STOP=1 -q < "$PLATFORM_DIR/core-postgres/init-scripts/14_customer_directory.sql"
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
