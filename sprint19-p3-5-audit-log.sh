#!/usr/bin/env bash
# Sprint 19 — P3-5: Audit-Log vervollstaendigen
# Auf der VPS ausführen: /opt/multitenant-platform
#
# Was passiert:
#   - Neue Migration 16_audit_ip_useragent.sql: audit_logs.ip_address,
#     audit_logs.user_agent
#   - Agent: neues lib/actorContext.ts (AsyncLocalStorage) - actor/IP/UA kommen
#     jetzt aus den vom Dashboard gesetzten Headern (X-Actor/X-Actor-Ip/
#     X-Actor-Ua, siehe Sprint 16 X-Actor) statt hart 'admin'. Betrifft ALLE
#     ~20 bestehenden logAudit()-Aufrufstellen automatisch, ohne dass eine
#     davon angefasst werden musste.
#   - Agent routes/backups.ts: Backup-Läufe und Restore-Tests wurden bisher
#     GAR NICHT geloggt (Start + Ergebnis jetzt schon)
#   - Dashboard: neues lib/audit.ts (eigene Kopie, Dashboard und Agent sind
#     getrennte Docker-Images ohne gemeinsames node_modules) fuer Aktionen,
#     die nie ueber den Agent laufen:
#       * auth.ts: Login-Erfolg UND -Fehlschlag (mit Grund: falsches Passwort/
#         unbekannte E-Mail/fehlende Server-Config), vorher komplett ungeloggt
#       * SQL-Editor (query/route.ts): Query gekuerzt auf 300 Zeichen geloggt,
#         NIE der Ergebnisinhalt
#       * Tabellen-Editor (rows/route.ts, rows/edit/route.ts): Insert/Update/
#         Delete - Spaltennamen ja, Werte nein (koennen beliebige Kundendaten
#         sein)
#   - lib/agent.ts leitet echte Client-IP (cf-connecting-ip vom Cloudflare
#     Tunnel) und User-Agent an den Agent weiter, statt dass dort nur die
#     Dashboard-Container-IP ankommt
#   - audit/page.tsx zeigt jetzt actor + IP in der Liste an, CSV-Export um
#     ip_address/user_agent erweitert
#   - Rebuild + Neustart von Dashboard UND Provisioning-Agent
#
# Rollback: ./sprint19-p3-5-audit-log.sh --rollback _backup-sprint19-<timestamp>
# Hinweis: Migration ist additiv, die neuen Spalten bleiben beim Rollback in
# der DB bestehen (nur der Code faellt zurueck).

set -euo pipefail

PLATFORM_DIR="/opt/multitenant-platform"
DASHBOARD_SRC="$PLATFORM_DIR/dashboard/src"
AGENT_SRC="$PLATFORM_DIR/provisioning-agent/src"
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$PLATFORM_DIR/_backup-sprint19-$TS"

FILES=(
  "provisioning-agent/src/lib/audit.ts"
  "provisioning-agent/src/index.ts"
  "provisioning-agent/src/routes/backups.ts"
  "provisioning-agent/src/routes/audit.ts"
  "dashboard/src/lib/agent.ts"
  "dashboard/src/auth.ts"
  "dashboard/src/app/api/tenants/[slug]/query/route.ts"
  "dashboard/src/app/api/tenants/[slug]/tables/[table]/rows/route.ts"
  "dashboard/src/app/api/tenants/[slug]/tables/[table]/rows/edit/route.ts"
  "dashboard/src/app/dashboard/audit/page.tsx"
)
NEW_FILES=(
  "core-postgres/init-scripts/16_audit_ip_useragent.sql"
  "provisioning-agent/src/lib/actorContext.ts"
  "dashboard/src/lib/audit.ts"
)

if [[ "${1:-}" == "--rollback" ]]; then
  RESTORE_FROM="${2:?Verzeichnis angeben: ./sprint19-p3-5-audit-log.sh --rollback _backup-sprint19-XXXXXXXX-XXXXXX}"
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
    echo "  removed (war neu in Sprint 19): $f"
  done
  echo "Rebuild..."
  cd "$PLATFORM_DIR/provisioning-agent" && docker compose --env-file ../.env build && docker compose --env-file ../.env up -d
  cd "$PLATFORM_DIR/dashboard" && docker compose --env-file ../.env build && docker compose --env-file ../.env up -d
  echo "Rollback abgeschlossen. Hinweis: Spalten ip_address/user_agent bleiben in der DB bestehen."
  exit 0
fi

echo "== Sprint 19 (P3-5): Backup nach $BACKUP_DIR =="
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

mkdir -p "$(dirname "$PLATFORM_DIR/core-postgres/init-scripts/16_audit_ip_useragent.sql")"
cat > "$PLATFORM_DIR/core-postgres/init-scripts/16_audit_ip_useragent.sql" << 'MIGRATION16_EOF'
-- P3-5: Audit-Log war unvollstaendig - weder IP noch User-Agent wurden je
-- mitgeschrieben, actor stand hart auf 'admin'. Diese Migration ergaenzt nur
-- die Spalten; das Befuellen passiert im Code (lib/audit.ts auf beiden Seiten).
--
-- Idempotent.
\connect admin_dashboard

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip_address TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_agent TEXT;
MIGRATION16_EOF

mkdir -p "$(dirname "$AGENT_SRC/lib/actorContext.ts")"
cat > "$AGENT_SRC/lib/actorContext.ts" << 'ACTORCONTEXT_EOF'
import { AsyncLocalStorage } from 'async_hooks';

// P3-5: 'actor' stand im Audit-Log bisher hart auf 'admin', an jeder einzelnen
// der ~20 logAudit()-Aufrufstellen haette das Herumreichen des echten Actors
// durch jede Funktionssignatur bedeutet. AsyncLocalStorage macht das pro-Request
// implizit verfuegbar - eine Middleware setzt es einmal, logAudit() liest es,
// ohne dass ein bestehender Aufruf angefasst werden muss.
export interface ActorInfo {
  actor: string;
  ip: string | null;
  userAgent: string | null;
}

export const actorStorage = new AsyncLocalStorage<ActorInfo>();

export function currentActor(): ActorInfo {
  return actorStorage.getStore() || { actor: 'admin', ip: null, userAgent: null };
}
ACTORCONTEXT_EOF

mkdir -p "$(dirname "$AGENT_SRC/lib/audit.ts")"
cat > "$AGENT_SRC/lib/audit.ts" << 'AUDIT_TS_EOF'
import { Client as PGClient } from 'pg';
import { currentActor } from './actorContext';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

// Key-Namen, deren Werte nie im Audit-Log landen dürfen, egal wie tief verschachtelt.
// Namensbasiert statt Regex-auf-String, weil meta ein JSON-Objekt ist (kein "KEY=value"-
// Text wie Build-Logs, siehe lib/crypto.ts maskSecrets() — die ist für Freitext-Logs gebaut,
// nicht für strukturierte Objekte, deshalb hier ein eigener, einfacherer Redactor).
const SENSITIVE_KEY_RE = /(password|secret|token|jwt|apikey|api_key|value)/i;

function redact(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(redact);
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? '***' : redact(v);
    }
    return out;
  }
  return obj;
}

/**
 * Schreibt einen Audit-Log-Eintrag (Phase 6). actor/ip/userAgent kommen aus dem
 * AsyncLocalStorage-Kontext (siehe actorContext.ts, gesetzt in index.ts aus
 * X-Actor/X-Actor-Ip/X-Actor-Ua - vom Dashboard pro Request mitgeschickt, siehe
 * lib/agent.ts dort). Faellt auf 'admin'/null zurueck, falls der Kontext fehlt
 * (z.B. Hintergrundprozesse ausserhalb eines Requests).
 *
 * WICHTIG: darf niemals eine laufende Aktion (Tenant-Erstellung, Deploy, ...) zum
 * Scheitern bringen, nur weil das Logging fehlschlägt — Fehler werden daher nur
 * geloggt, nie geworfen.
 *
 * meta wird vor dem Schreiben namensbasiert redigiert (siehe redact() oben), damit
 * aus Versehen mitgegebene Secrets nicht im Klartext in audit_logs landen.
 */
export async function logAudit(
  action: string,
  target: string | null,
  meta: Record<string, unknown> = {}
): Promise<void> {
  const { actor, ip, userAgent } = currentActor();
  const db = new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
  try {
    await db.connect();
    await db.query(
      'INSERT INTO audit_logs (actor, action, target, meta, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5, $6)',
      [actor, action, target, JSON.stringify(redact(meta)), ip, userAgent]
    );
  } catch (err: any) {
    console.error(`Audit log write failed (action=${action}, target=${target}):`, err.message);
  } finally {
    await db.end().catch(() => {});
  }
}
AUDIT_TS_EOF

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
import { actorStorage } from './lib/actorContext';
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
// P3-5: actor/IP/User-Agent fuer's Audit-Log aus den vom Dashboard gesetzten
// Headern (siehe dashboard/src/lib/agent.ts) fuer die Dauer dieses Requests
// verfuegbar machen - logAudit() liest das ueber actorContext.ts, ohne dass
// jede der ~20 bestehenden Aufrufstellen angefasst werden musste.
app.use((req, res, next) => {
  actorStorage.run(
    {
      actor: (req.headers['x-actor'] as string) || 'admin',
      ip: (req.headers['x-actor-ip'] as string) || null,
      userAgent: (req.headers['x-actor-ua'] as string) || null,
    },
    next
  );
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

mkdir -p "$(dirname "$AGENT_SRC/routes/backups.ts")"
cat > "$AGENT_SRC/routes/backups.ts" << 'BACKUPS_TS_EOF'
import { Router } from 'express';
import { Client as PGClient } from 'pg';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logAudit } from '../lib/audit';

const execFileP = promisify(execFile);
const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;
const ROOT = '/opt/multitenant-platform';

function adminClient(): PGClient {
  return new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
}

export const backupsRouter = Router();

let backupRunning = false;
let restoreTestRunning = false;

backupsRouter.get('/backups', async (_req, res) => {
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT id, db_name, filename, size_bytes, status, created_at
       FROM backups ORDER BY created_at DESC LIMIT 100`
    );
    res.json({ backups: rows, backupRunning, restoreTestRunning });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

backupsRouter.post('/backups/run', async (_req, res) => {
  if (backupRunning) return res.status(409).json({ error: 'backup already running' });
  backupRunning = true;
  res.json({ status: 'started' });
  await logAudit('backup.run.started', null, {});

  execFileP('bash', [`${ROOT}/backups/backup-script.sh`], {
    maxBuffer: 1024 * 1024 * 16,
    timeout: 30 * 60 * 1000,
  })
    .then(({ stdout }) => {
      console.log('Backup run finished:\n' + stdout);
      logAudit('backup.run.finished', null, { status: 'ok' });
    })
    .catch((err: any) => {
      console.error('Backup run failed:', err.stdout || err.message);
      logAudit('backup.run.finished', null, { status: 'failed', error: err.message });
    })
    .finally(() => {
      backupRunning = false;
    });
});

backupsRouter.post('/backups/restore-test', async (req, res) => {
  const { filename } = req.body;
  if (!filename || !/^[a-zA-Z0-9_.-]+\.sql\.gz\.age$/.test(filename)) {
    return res.status(400).json({ error: 'invalid filename' });
  }
  if (restoreTestRunning) return res.status(409).json({ error: 'restore test already running' });
  restoreTestRunning = true;
  await logAudit('backup.restore_test.started', filename, {});

  try {
    const { stdout } = await execFileP('bash', [`${ROOT}/backups/restore-test-script.sh`, filename], {
      maxBuffer: 1024 * 1024 * 16,
      timeout: 15 * 60 * 1000,
    });
    const match = stdout.match(/RESTORE_TEST_RESULT:OK:(\d+)/);
    const tableCount = match ? Number(match[1]) : null;
    await logAudit('backup.restore_test.finished', filename, { status: 'ok', tableCount });
    res.json({ status: 'ok', tableCount, log: stdout.slice(-4000) });
  } catch (err: any) {
    await logAudit('backup.restore_test.finished', filename, { status: 'failed', error: err.message });
    res.status(500).json({
      status: 'failed',
      error: err.message,
      log: ((err.stdout || '') + '\n' + (err.stderr || '')).slice(-4000),
    });
  } finally {
    restoreTestRunning = false;
  }
});
BACKUPS_TS_EOF

mkdir -p "$(dirname "$AGENT_SRC/routes/audit.ts")"
cat > "$AGENT_SRC/routes/audit.ts" << 'AUDITROUTE_TS_EOF'
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
      `SELECT id, actor, action, target, meta, created_at, ip_address, user_agent
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
AUDITROUTE_TS_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/lib/agent.ts")"
cat > "$DASHBOARD_SRC/lib/agent.ts" << 'AGENTLIB_EOF'
import { auth } from "@/auth";
import { headers } from "next/headers";

const AGENT_URL = process.env.PROVISIONING_AGENT_URL!;
const AGENT_SECRET = process.env.PROVISIONING_AGENT_SECRET!;

export async function agentFetch(path: string, init?: RequestInit) {
  // P3-2: Rate-Limiting im Agent zaehlte bisher rein nach IP - da alle Requests
  // vom Dashboard-Container kommen, war das faktisch ein einziges globales
  // Budget fuer jegliche Admin-Aktivitaet. X-Actor gibt dem Limiter einen
  // session-bezogenen Schluessel statt der immer gleichen Container-IP.
  const session = await auth().catch(() => null);
  const actor = session?.user?.email || "unknown";

  // P3-5: echte Client-IP/User-Agent gibt es nur hier, auf Höhe des
  // eingehenden Dashboard-Requests - der Agent sieht sonst nur die IP des
  // Dashboard-Containers. cf-connecting-ip kommt vom Cloudflare Tunnel.
  let ip = "";
  let userAgent = "";
  try {
    const h = await headers();
    ip = h.get("cf-connecting-ip") || h.get("x-forwarded-for") || "";
    userAgent = h.get("user-agent") || "";
  } catch {
    // headers() ist nur innerhalb eines Request-Kontexts verfuegbar - bei
    // Aufrufen ausserhalb (sollte nicht vorkommen) einfach leer lassen.
  }

  const res = await fetch(`${AGENT_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Secret": AGENT_SECRET,
      "X-Actor": actor,
      "X-Actor-Ip": ip,
      "X-Actor-Ua": userAgent,
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
AGENTLIB_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/lib/audit.ts")"
cat > "$DASHBOARD_SRC/lib/audit.ts" << 'DASHAUDIT_EOF'
import { Pool } from "pg";

// P3-5: Audit-Log-Eintraege, die direkt aus dem Dashboard-Prozess entstehen
// (Login, SQL-Editor, Tabellen-Editor) - diese Aktionen laufen nie ueber den
// Agent (tenantDb.ts verbindet direkt gegen die Tenant-DB), es gab bisher
// keinen logAudit()-Aufruf, der sie erreichen konnte. Eigene, schlanke Kopie
// statt Import aus dem Agent-Package (getrenntes Docker-Image, kein
// gemeinsames node_modules).
let auditPool: Pool | null = null;

function getAuditPool(): Pool {
  if (!auditPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL fehlt (siehe .env.example)");
    auditPool = new Pool({ connectionString, max: 3 });
  }
  return auditPool;
}

const SENSITIVE_KEY_RE = /(password|secret|token|jwt|apikey|api_key|value)/i;

function redact(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(redact);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? "***" : redact(v);
    }
    return out;
  }
  return obj;
}

/**
 * Wie lib/audit.ts im Provisioning-Agent, nur fuer Aktionen, die direkt im
 * Dashboard-Prozess passieren. actor/ip/userAgent werden explizit uebergeben,
 * statt sie implizit aus einem Kontext zu ziehen - der Dashboard-Code hat sie
 * an jeder Aufrufstelle ohnehin schon zur Hand (session, headers()).
 *
 * Darf niemals eine laufende Aktion zum Scheitern bringen, nur weil das
 * Logging fehlschlaegt - Fehler werden nur geloggt, nie geworfen.
 */
export async function logAudit(
  actor: string,
  action: string,
  target: string | null,
  meta: Record<string, unknown> = {},
  opts: { ip?: string | null; userAgent?: string | null } = {}
): Promise<void> {
  try {
    const pool = getAuditPool();
    await pool.query(
      "INSERT INTO audit_logs (actor, action, target, meta, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5, $6)",
      [actor, action, target, JSON.stringify(redact(meta)), opts.ip ?? null, opts.userAgent ?? null]
    );
  } catch (err) {
    console.error(`Audit log write failed (action=${action}, target=${target}):`, (err as Error).message);
  }
}
DASHAUDIT_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/auth.ts")"
cat > "$DASHBOARD_SRC/auth.ts" << 'AUTHTS_EOF'
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { authConfig } from "@/auth.config";
import { logAudit } from "@/lib/audit";

// P3-5: weder erfolgreiche noch fehlgeschlagene Logins wurden bisher geloggt -
// ausgerechnet der Zugriffspunkt mit dem direktesten Bezug zu "wer war das".
function requestMeta(request: Request | undefined): { ip: string | null; userAgent: string | null } {
  if (!request) return { ip: null, userAgent: null };
  const h = request.headers;
  return {
    ip: h.get("cf-connecting-ip") || h.get("x-forwarded-for"),
    userAgent: h.get("user-agent"),
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  session: { strategy: "jwt" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "E-Mail", type: "email" },
        password: { label: "Passwort", type: "password" },
      },
      authorize: async (credentials, request) => {
        const email = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;
        const meta = requestMeta(request as Request | undefined);
        const actor = email || "unknown";

        if (!email || !password) {
          await logAudit(actor, "auth.login_failure", null, { reason: "missing_credentials" }, meta);
          return null;
        }

        const adminEmail = process.env.ADMIN_EMAIL;
        const adminHash = process.env.ADMIN_PASSWORD_HASH;
        if (!adminEmail || !adminHash) {
          await logAudit(actor, "auth.login_failure", null, { reason: "server_misconfigured" }, meta);
          return null;
        }

        if (email.toLowerCase() !== adminEmail.toLowerCase()) {
          await logAudit(actor, "auth.login_failure", null, { reason: "unknown_email" }, meta);
          return null;
        }
        const valid = await bcrypt.compare(password, adminHash);
        if (!valid) {
          await logAudit(actor, "auth.login_failure", null, { reason: "wrong_password" }, meta);
          return null;
        }

        await logAudit(adminEmail, "auth.login_success", null, {}, meta);
        return { id: "admin", email: adminEmail, name: "Admin" };
      },
    }),
  ],
});
AUTHTS_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/app/api/tenants/[slug]/query/route.ts")"
cat > "$DASHBOARD_SRC/app/api/tenants/[slug]/query/route.ts" << 'QUERYROUTE_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantBySlug } from "@/lib/adminDb";
import { runSql } from "@/lib/tenantDb";
import { logAudit } from "@/lib/audit";

const SQL_LOG_PREVIEW_LEN = 300;

function requestMeta(req: Request) {
  return {
    ip: req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  };
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  // KRITISCH: dieser Endpunkt fuehrt beliebiges SQL als postgres-Superuser aus.
  // Er darf sich niemals allein auf middleware.ts verlassen.
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug } = await params;
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return NextResponse.json({ error: "tenant not found" }, { status: 404 });
  }

  const { sql, readOnly } = await req.json();
  if (!sql || typeof sql !== "string") {
    return NextResponse.json({ error: "sql required" }, { status: 400 });
  }

  const actor = session.user?.email || "unknown";
  const meta = requestMeta(req);
  // P3-5: Query gekuerzt geloggt (nie der Ergebnisinhalt) - reicht, um im
  // Nachhinein nachzuvollziehen was gelaufen ist, ohne potenziell sensible
  // Zeilendaten ins Audit-Log zu kopieren.
  const sqlPreview = sql.length > SQL_LOG_PREVIEW_LEN ? sql.slice(0, SQL_LOG_PREVIEW_LEN) + "…" : sql;

  try {
    const result = await runSql(tenant.db_name, sql, { readOnly: readOnly !== false });
    await logAudit(actor, "sql.execute", slug, {
      sqlPreview,
      readOnly: readOnly !== false,
      rowCount: result.rowCount,
      durationMs: result.durationMs,
      truncated: result.truncated,
    }, meta);
    return NextResponse.json(result);
  } catch (err) {
    await logAudit(actor, "sql.execute", slug, {
      sqlPreview,
      readOnly: readOnly !== false,
      error: (err as Error).message,
    }, meta);
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
QUERYROUTE_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/app/api/tenants/[slug]/tables/[table]/rows/route.ts")"
cat > "$DASHBOARD_SRC/app/api/tenants/[slug]/tables/[table]/rows/route.ts" << 'ROWSROUTE_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantBySlug } from "@/lib/adminDb";
import { getRows, insertRow } from "@/lib/tenantDb";
import { logAudit } from "@/lib/audit";

const TABLE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function requestMeta(req: Request) {
  return {
    ip: req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string; table: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug, table } = await params;
  if (!TABLE_NAME_RE.test(table)) {
    return NextResponse.json({ error: "invalid table name" }, { status: 400 });
  }
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return NextResponse.json({ error: "tenant not found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 500);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
  const orderBy = url.searchParams.get("orderBy") || undefined;
  const orderDirRaw = url.searchParams.get("orderDir");
  const orderDir = orderDirRaw === "desc" ? "desc" : orderDirRaw === "asc" ? "asc" : undefined;

  let filters: Record<string, string> | undefined;
  const filtersRaw = url.searchParams.get("filters");
  if (filtersRaw) {
    try {
      const parsed = JSON.parse(filtersRaw);
      if (parsed && typeof parsed === "object") {
        filters = Object.fromEntries(
          Object.entries(parsed).filter(([, v]) => typeof v === "string" && v.length > 0)
        ) as Record<string, string>;
      }
    } catch {
      // ungueltiges JSON im Filter-Parameter -> einfach ignorieren, kein 400
      // fuer einen reinen Anzeige-Parameter
    }
  }

  try {
    const { rows, columns, totalCount, hasPrimaryKey } = await getRows(tenant.db_name, table, {
      limit,
      offset,
      orderBy,
      orderDir,
      filters,
    });
    return NextResponse.json({ rows, columns, totalCount, hasPrimaryKey });
  } catch (err) {
    console.error("Failed to fetch rows:", (err as Error).message);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string; table: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug, table } = await params;
  if (!TABLE_NAME_RE.test(table)) {
    return NextResponse.json({ error: "invalid table name" }, { status: 400 });
  }
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return NextResponse.json({ error: "tenant not found" }, { status: 404 });
  }

  const values = await req.json();
  const actor = session.user?.email || "unknown";
  const meta = requestMeta(req);
  try {
    const row = await insertRow(tenant.db_name, table, values);
    // P3-5: Spaltennamen ja, Werte nein - values koennen beliebige Kundendaten
    // enthalten, die nicht routinemaessig ins Audit-Log sollen.
    await logAudit(actor, "table.row_insert", `${slug}/${table}`, { columns: Object.keys(values) }, meta);
    return NextResponse.json({ row }, { status: 201 });
  } catch (err) {
    console.error("Failed to insert row:", (err as Error).message);
    await logAudit(actor, "table.row_insert", `${slug}/${table}`, { error: (err as Error).message }, meta);
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
ROWSROUTE_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/app/api/tenants/[slug]/tables/[table]/rows/edit/route.ts")"
cat > "$DASHBOARD_SRC/app/api/tenants/[slug]/tables/[table]/rows/edit/route.ts" << 'ROWSEDITROUTE_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantBySlug } from "@/lib/adminDb";
import { updateRow, deleteRow } from "@/lib/tenantDb";
import { logAudit } from "@/lib/audit";

const TABLE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function requestMeta(req: Request) {
  return {
    ip: req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  };
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ slug: string; table: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug, table } = await params;
  if (!TABLE_NAME_RE.test(table)) {
    return NextResponse.json({ error: "invalid table name" }, { status: 400 });
  }
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return NextResponse.json({ error: "tenant not found" }, { status: 404 });
  }

  const { pkColumn, pkValue, values } = await req.json();
  if (!pkColumn || pkValue === undefined || !values) {
    return NextResponse.json({ error: "pkColumn, pkValue, values required" }, { status: 400 });
  }

  const actor = session.user?.email || "unknown";
  const meta = requestMeta(req);
  try {
    const row = await updateRow(tenant.db_name, table, pkColumn, pkValue, values);
    await logAudit(
      actor,
      "table.row_update",
      `${slug}/${table}`,
      { pkColumn, pkValue, columns: Object.keys(values) },
      meta
    );
    return NextResponse.json({ row });
  } catch (err) {
    console.error("Failed to update row:", (err as Error).message);
    await logAudit(actor, "table.row_update", `${slug}/${table}`, { pkColumn, pkValue, error: (err as Error).message }, meta);
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ slug: string; table: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug, table } = await params;
  if (!TABLE_NAME_RE.test(table)) {
    return NextResponse.json({ error: "invalid table name" }, { status: 400 });
  }
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return NextResponse.json({ error: "tenant not found" }, { status: 404 });
  }

  const { pkColumn, pkValue } = await req.json();
  if (!pkColumn || pkValue === undefined) {
    return NextResponse.json({ error: "pkColumn, pkValue required" }, { status: 400 });
  }

  const actor = session.user?.email || "unknown";
  const meta = requestMeta(req);
  try {
    await deleteRow(tenant.db_name, table, pkColumn, pkValue);
    await logAudit(actor, "table.row_delete", `${slug}/${table}`, { pkColumn, pkValue }, meta);
    return NextResponse.json({ status: "ok" });
  } catch (err) {
    console.error("Failed to delete row:", (err as Error).message);
    await logAudit(actor, "table.row_delete", `${slug}/${table}`, { pkColumn, pkValue, error: (err as Error).message }, meta);
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
ROWSEDITROUTE_EOF

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
  ip_address: string | null;
  user_agent: string | null;
}

const PAGE_SIZE = 50;

function toCsv(logs: AuditLog[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ["created_at,actor,action,target,ip_address,user_agent,meta"];
  for (const l of logs) {
    lines.push(
      [l.created_at, l.actor, l.action, l.target ?? "", l.ip_address ?? "", l.user_agent ?? "", JSON.stringify(l.meta ?? {})]
        .map(esc)
        .join(",")
    );
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
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
            <span>
              <span className="pk-badge">{l.action}</span>{" "}
              <span style={{ color: "var(--text-dim)" }}>{l.actor}</span>{" "}
              {l.target && <span style={{ color: "var(--text-dim)" }}>· {l.target}</span>}
            </span>
            <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
              {l.ip_address && <span style={{ marginRight: 8 }}>{l.ip_address}</span>}
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


echo "== Migration anwenden =="
if [[ -x "$PLATFORM_DIR/scripts/migrate.sh" ]]; then
  bash "$PLATFORM_DIR/scripts/migrate.sh"
else
  echo "scripts/migrate.sh nicht gefunden - wende 16_audit_ip_useragent.sql direkt an"
  docker exec -i core-postgres psql -U postgres -v ON_ERROR_STOP=1 -q < "$PLATFORM_DIR/core-postgres/init-scripts/16_audit_ip_useragent.sql"
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
