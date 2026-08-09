#!/usr/bin/env bash
# Sprint 16 — P3-2: Rate-Limiting trifft nicht mehr den eigenen Admin
# Auf der VPS ausführen: /opt/multitenant-platform
#
# Was passiert:
#   - lib/agent.ts: jeder Request an den Agent traegt jetzt einen X-Actor-Header
#     (aus der NextAuth-Session)
#   - index.ts: globalLimiter und sensitiveOpLimiter zaehlen jetzt nach X-Actor
#     statt nach IP (alle Requests kamen bisher vom selben Dashboard-Container -
#     eine IP, ein Zaehler fuer JEDE Admin-Aktivitaet gleichzeitig).
#     globalLimiter ueberspringt zusaetzlich GET-Requests komplett - Polling
#     (Backups/Domains/Deployments) ist ausschliesslich GET und war der
#     eigentliche Verbraucher: ein offener Backups-Tab allein hat vorher 180
#     der 300 Requests/15min verbraucht. Schreibende Requests bleiben limitiert.
#   - backups/page.tsx: pollt nur noch, solange ein Backup oder Restore-Test
#     tatsaechlich laeuft (vorher: immer alle 5s, unabhaengig vom Zustand)
#   - deployments/page.tsx (beide Poller: Liste + Log-Delta-Viewer) und
#     dashboard/page.tsx (Uebersicht, P1-8): pausieren jetzt bei
#     document.visibilityState !== "visible" - domains/page.tsx hatte das
#     schon aus einem frueheren Sprint
#   - Rebuild + Neustart von Dashboard UND Provisioning-Agent
#
# Rollback: ./sprint16-p3-2-rate-limiting.sh --rollback _backup-sprint16-<timestamp>

set -euo pipefail

PLATFORM_DIR="/opt/multitenant-platform"
DASHBOARD_SRC="$PLATFORM_DIR/dashboard/src"
AGENT_SRC="$PLATFORM_DIR/provisioning-agent/src"
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$PLATFORM_DIR/_backup-sprint16-$TS"

FILES=(
  "provisioning-agent/src/index.ts"
  "dashboard/src/lib/agent.ts"
  "dashboard/src/app/dashboard/backups/page.tsx"
  "dashboard/src/app/dashboard/projects/[slug]/deployments/page.tsx"
  "dashboard/src/app/dashboard/page.tsx"
)

if [[ "${1:-}" == "--rollback" ]]; then
  RESTORE_FROM="${2:?Verzeichnis angeben: ./sprint16-p3-2-rate-limiting.sh --rollback _backup-sprint16-XXXXXXXX-XXXXXX}"
  cd "$PLATFORM_DIR"
  echo "Rollback aus $RESTORE_FROM ..."
  for f in "${FILES[@]}"; do
    if [[ -f "$RESTORE_FROM/$f" ]]; then
      mkdir -p "$(dirname "$f")"
      cp "$RESTORE_FROM/$f" "$f"
      echo "  restored: $f"
    fi
  done
  echo "Rebuild..."
  cd "$PLATFORM_DIR/provisioning-agent" && docker compose --env-file ../.env build && docker compose --env-file ../.env up -d
  cd "$PLATFORM_DIR/dashboard" && docker compose --env-file ../.env build && docker compose --env-file ../.env up -d
  echo "Rollback abgeschlossen."
  exit 0
fi

echo "== Sprint 16 (P3-2): Backup nach $BACKUP_DIR =="
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

// Phase 6 + P3-2: Rate-Limiting. In-Memory reicht für Single-VPS-Setup (kein Redis
// nötig, ein Prozess = ein Zähler-Store). Drei Stufen: global grosszügig, Webhooks
// eigenes Limit (kommen von GitHub, nicht vom Admin), Tenant-/Secret-Operationen
// strenger, weil sie teuer sind (DB-Erstellung, Container-Start, Secret-Rotation).
//
// P3-2-Fixes:
// - keyGenerator nutzt X-Actor (vom Dashboard gesetzt, siehe lib/agent.ts) statt
//   der Request-IP. Alle Admin-Requests kamen bisher vom selben Container - eine
//   IP, ein Zaehler fuer JEDE Admin-Aktivitaet gleichzeitig.
// - globalLimiter ueberspringt GET-Requests komplett. Polling (Backups, Domains,
//   Deployments) ist ausschliesslich GET und war der eigentliche Verbraucher des
//   Budgets - ein offener Backups-Tab allein hat vorher 180 der 300 Requests pro
//   15-Minuten-Fenster verbraucht. Schreibende Requests bleiben limitiert.
function actorKey(req: express.Request): string {
  return (req.headers['x-actor'] as string) || req.ip || 'unknown';
}

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: actorKey,
  skip: (req) => req.method === 'GET',
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
  keyGenerator: actorKey,
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

mkdir -p "$(dirname "$DASHBOARD_SRC/lib/agent.ts")"
cat > "$DASHBOARD_SRC/lib/agent.ts" << 'AGENT_LIB_TS_EOF'
import { auth } from "@/auth";

const AGENT_URL = process.env.PROVISIONING_AGENT_URL!;
const AGENT_SECRET = process.env.PROVISIONING_AGENT_SECRET!;

export async function agentFetch(path: string, init?: RequestInit) {
  // P3-2: Rate-Limiting im Agent zaehlte bisher rein nach IP - da alle Requests
  // vom Dashboard-Container kommen, war das faktisch ein einziges globales
  // Budget fuer jegliche Admin-Aktivitaet. X-Actor gibt dem Limiter einen
  // session-bezogenen Schluessel statt der immer gleichen Container-IP.
  const session = await auth().catch(() => null);
  const actor = session?.user?.email || "unknown";

  const res = await fetch(`${AGENT_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Secret": AGENT_SECRET,
      "X-Actor": actor,
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
AGENT_LIB_TS_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/app/dashboard/backups/page.tsx")"
cat > "$DASHBOARD_SRC/app/dashboard/backups/page.tsx" << 'BACKUPSPAGE_EOF'
"use client";

import { useEffect, useState, useCallback } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";

interface Backup {
  id: string;
  db_name: string;
  filename: string;
  size_bytes: number;
  status: "ok" | "dump_failed" | "upload_failed";
  created_at: string;
}

interface RestoreResultEntry {
  status: string;
  tableCount?: number | null;
  error?: string;
}

const STATUS_COLOR: Record<string, string> = {
  ok: "#2da44e",
  dump_failed: "var(--danger)",
  upload_failed: "var(--danger)",
};

function formatBytes(bytes: number): string {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}

export default function BackupsPage() {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [backupRunning, setBackupRunning] = useState(false);
  const [restoreTestRunning, setRestoreTestRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [restoreResult, setRestoreResult] = useState<Record<string, RestoreResultEntry>>({});
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(() => {
    fetch("/api/backups")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) {
          setError(d.error);
          return;
        }
        setBackups(d.backups || []);
        setBackupRunning(!!d.backupRunning);
        setRestoreTestRunning(!!d.restoreTestRunning);
      })
      .catch(() => setError("Verbindung zum Provisioning Agent fehlgeschlagen"));
  }, []);

  useEffect(() => {
    load();
    // P3-2: vorher pollte diese Seite alle 5s IMMER, unabhaengig davon, ob
    // ueberhaupt etwas lief - allein ein offen gelassener Backups-Tab hat so
    // 180 der 300 Requests/15min des globalen Agent-Limits verbraucht. Jetzt
    // nur solange ein Backup oder Restore-Test tatsaechlich laeuft, und auch
    // dann nur bei sichtbarem Tab.
    if (!backupRunning && !restoreTestRunning) return;
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 5000);
    return () => clearInterval(interval);
  }, [load, backupRunning, restoreTestRunning]);

  async function handleRunBackup() {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/backups/run", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Backup konnte nicht gestartet werden");
        return;
      }
      load();
    } catch {
      setError("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setStarting(false);
    }
  }

  async function handleRestoreTest(filename: string) {
    setRestoreResult((prev) => ({ ...prev, [filename]: { status: "running" } }));
    try {
      const res = await fetch("/api/backups/restore-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRestoreResult((prev) => ({
          ...prev,
          [filename]: { status: "failed", error: data.error || "Restore-Test fehlgeschlagen" },
        }));
        toast.error(data.error || "Restore-Test fehlgeschlagen");
        return;
      }
      setRestoreResult((prev) => ({
        ...prev,
        [filename]: { status: "ok", tableCount: data.tableCount },
      }));
      toast.success(`Restore-Test ok (${data.tableCount ?? "?"} Tabellen).`);
    } catch {
      setRestoreResult((prev) => ({
        ...prev,
        [filename]: { status: "failed", error: "Verbindung zum Provisioning Agent fehlgeschlagen" },
      }));
      toast.error("Verbindung zum Provisioning Agent fehlgeschlagen");
    }
  }

  return (
    <div>
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Backups</h2>
        <button
          className="btn btn-primary"
          onClick={handleRunBackup}
          disabled={starting || backupRunning}
        >
          {backupRunning ? "Backup läuft…" : starting ? "Starte…" : "Backup jetzt starten"}
        </button>
      </div>

      {error && (
        <div className="error-box" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      {restoreTestRunning && (
        <div style={{ marginBottom: 12, color: "var(--text-dim)", fontSize: 13 }}>
          Ein Restore-Test läuft gerade im Hintergrund…
        </div>
      )}

      {backups.length === 0 && !error && (
        <div className="empty-state">Noch kein Backup gelaufen.</div>
      )}

      {backups.map((b) => {
        const result = restoreResult[b.filename];
        return (
          <div
            key={b.id}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: 12,
              marginBottom: 8,
              background: "var(--panel)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    display: "inline-block",
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: STATUS_COLOR[b.status] || "var(--text-dim)",
                  }}
                />
                <span className="pk-badge">{b.db_name}</span>
                <span style={{ color: "var(--text-dim)", fontSize: 12, fontFamily: "var(--font-mono)" }}>
                  {b.filename}
                </span>
                <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
                  {formatBytes(b.size_bytes)} · {new Date(b.created_at).toLocaleString("de-DE")}
                </span>
              </div>
              {b.status === "ok" && (
                <button
                  className="btn"
                  onClick={() => setRestoreTarget(b.filename)}
                  disabled={result?.status === "running" || restoreTestRunning}
                >
                  {result?.status === "running" ? "Läuft…" : "Restore-Test"}
                </button>
              )}
            </div>
            {result && result.status === "ok" && (
              <div style={{ marginTop: 8, fontSize: 12, color: "#2da44e" }}>
                ✓ Restore-Test erfolgreich — {result.tableCount} Tabellen wiederhergestellt und geprüft, Test-DB wieder entfernt.
              </div>
            )}
            {result && result.status === "failed" && (
              <div style={{ marginTop: 8, fontSize: 12, color: "var(--danger)" }}>
                ✗ Restore-Test fehlgeschlagen: {result.error}
              </div>
            )}
          </div>
        );
      })}

      <ConfirmDialog
        open={!!restoreTarget}
        onClose={() => setRestoreTarget(null)}
        onConfirm={() => restoreTarget && handleRestoreTest(restoreTarget)}
        title="Restore-Test starten"
        description={`Legt eine temporäre Test-DB aus "${restoreTarget ?? ""}" an und räumt sie danach wieder ab.`}
        confirmLabel="Test starten"
      />
    </div>
  );
}
BACKUPSPAGE_EOF

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
    // P3-2: Tab im Hintergrund pollt nicht mehr mit.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") fetchDelta();
    }, 2000);
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
    // P3-2: Tab im Hintergrund pollt nicht mehr mit.
    const interval = setInterval(() => {
      if (document.visibilityState !== "visible") return;
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

mkdir -p "$(dirname "$DASHBOARD_SRC/app/dashboard/page.tsx")"
cat > "$DASHBOARD_SRC/app/dashboard/page.tsx" << 'OVERVIEWPAGE_EOF'
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Overview {
  summary: {
    tenantCount: number;
    projectCount: number;
    projectsRunning: number;
    projectsFailedLastDeploy: number;
  };
  projects: ProjectStat[];
}

interface ProjectStat {
  id: string;
  slug: string;
  tenantSlug: string;
  tariff: string;
  activeContainer: string | null;
  cpuPerc: string | null;
  memUsage: string | null;
  memPerc: string | null;
  lastDeployment: { status: string; finishedAt: string | null; createdAt: string } | null;
  domains: Record<string, number>;
  dbConnections: number;
  kumaMonitorId: number | null;
  kumaUrl: string | null;
}

// Gleiche Konvention wie projects/[slug]/deployments/page.tsx.
const STATUS_COLOR: Record<string, string> = {
  queued: "var(--text-dim)",
  building: "var(--accent)",
  healthchecking: "var(--accent)",
  deployed: "#2da44e",
  failed: "var(--danger)",
  rolled_back: "var(--text-dim)",
  cancelled: "var(--text-dim)",
};

const DOMAIN_STATUS_LABEL: Record<string, string> = {
  live: "live",
  tls_pending: "TLS ausstehend",
  dns_ok: "DNS ok",
  pending_dns: "DNS ausstehend",
  failed: "fehlgeschlagen",
  unknown: "unbekannt",
};

function timeAgo(iso: string | null): string {
  if (!iso) return "–";
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

export default function PlatformOverviewPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    fetch("/api/stats/overview")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch(() => setError("Verbindung zum Provisioning Agent fehlgeschlagen"));
  }

  useEffect(() => {
    load();
    // P3-2: auch hier nur bei sichtbarem Tab weiterpollen.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  if (error) return <div className="content"><div className="error-box">{error}</div></div>;
  if (!data) return <div className="content"><div className="empty-state">Lade Übersicht…</div></div>;

  const { summary, projects } = data;

  return (
    <div className="content">
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Plattform-Übersicht</h2>
      </div>

      <div className="card-grid" style={{ marginBottom: 24 }}>
        <div className="card">
          <div className="card-sub">Kunden</div>
          <div style={{ fontSize: 26, fontWeight: 600 }}>{summary.tenantCount}</div>
        </div>
        <div className="card">
          <div className="card-sub">Projekte</div>
          <div style={{ fontSize: 26, fontWeight: 600 }}>{summary.projectCount}</div>
        </div>
        <div className="card">
          <div className="card-sub">Laufende Container</div>
          <div style={{ fontSize: 26, fontWeight: 600 }}>{summary.projectsRunning}</div>
        </div>
        <div className="card">
          <div className="card-sub">Letzter Deploy fehlgeschlagen</div>
          <div style={{ fontSize: 26, fontWeight: 600, color: summary.projectsFailedLastDeploy > 0 ? "var(--danger)" : undefined }}>
            {summary.projectsFailedLastDeploy}
          </div>
        </div>
      </div>

      {projects.length === 0 && <div className="empty-state">Noch keine Projekte angelegt.</div>}

      {projects.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
                <th style={{ padding: "8px 10px" }}>Projekt</th>
                <th style={{ padding: "8px 10px" }}>Status</th>
                <th style={{ padding: "8px 10px" }}>CPU</th>
                <th style={{ padding: "8px 10px" }}>RAM</th>
                <th style={{ padding: "8px 10px" }}>Letzter Deploy</th>
                <th style={{ padding: "8px 10px" }}>Domains</th>
                <th style={{ padding: "8px 10px" }}>DB-Verbindungen</th>
                <th style={{ padding: "8px 10px" }}>Monitoring</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "8px 10px" }}>
                    <Link href={`/dashboard/projects/${p.tenantSlug}`} style={{ color: "var(--accent)" }}>
                      {p.slug}
                    </Link>
                    <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{p.tariff}</div>
                  </td>
                  <td style={{ padding: "8px 10px" }}>
                    {p.activeContainer ? (
                      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: "#2da44e" }} />
                        live
                      </span>
                    ) : (
                      <span style={{ color: "var(--text-dim)" }}>kein Container</span>
                    )}
                  </td>
                  <td style={{ padding: "8px 10px" }}>{p.cpuPerc ?? "–"}</td>
                  <td style={{ padding: "8px 10px" }}>{p.memPerc ?? p.memUsage ?? "–"}</td>
                  <td style={{ padding: "8px 10px" }}>
                    {p.lastDeployment ? (
                      <span>
                        <span style={{ color: STATUS_COLOR[p.lastDeployment.status] || "var(--text-dim)" }}>
                          {p.lastDeployment.status}
                        </span>
                        <span style={{ color: "var(--text-dim)" }}> · vor {timeAgo(p.lastDeployment.finishedAt || p.lastDeployment.createdAt)}</span>
                      </span>
                    ) : (
                      <span style={{ color: "var(--text-dim)" }}>noch nie</span>
                    )}
                  </td>
                  <td style={{ padding: "8px 10px" }}>
                    {Object.entries(p.domains).length === 0 && <span style={{ color: "var(--text-dim)" }}>–</span>}
                    {Object.entries(p.domains).map(([status, n]) => (
                      <span key={status} className="pk-badge" style={{ marginRight: 4 }}>
                        {n}× {DOMAIN_STATUS_LABEL[status] || status}
                      </span>
                    ))}
                  </td>
                  <td style={{ padding: "8px 10px" }}>{p.dbConnections}</td>
                  <td style={{ padding: "8px 10px" }}>
                    {p.kumaUrl ? (
                      <a href={p.kumaUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                        in Uptime Kuma öffnen
                      </a>
                    ) : (
                      <span style={{ color: "var(--text-dim)" }}>kein Monitor</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
OVERVIEWPAGE_EOF


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
