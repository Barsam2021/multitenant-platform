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
