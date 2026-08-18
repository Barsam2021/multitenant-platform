import express from 'express';
import rateLimit from 'express-rate-limit';
import { Client } from 'pg';
import format from 'pg-format';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile } from 'fs/promises';
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
import { cleanupRouter } from './routes/cleanup';
import { analyticsRouter } from './routes/analytics';
import { cmsRouter } from './routes/cms';
import { runCleanup } from './lib/cleanup';
import { ingestAccessLog } from './lib/analytics';
import { provisionTenantDatabase } from './lib/tenantDatabase';
import { cleanupProjectResources } from './lib/projectCleanup';
import { encrypt } from './lib/crypto';
import { signTenantJwt } from './lib/jwt';
import { actorStorage } from './lib/actorContext';
import { logAudit } from './lib/audit';
import { wrapRouterAsync } from './lib/asyncRoutes';
import { alert } from './lib/alert';

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

// MUSS vor der Secret-Middleware stehen. Der Docker-Healthcheck kennt das
// Secret nicht (es steht in der .env des Compose-Stacks, nicht im Container-
// Kommando) — stand /health hinter der Pruefung, kam dort 401 zurueck und der
// Container galt dauerhaft als "unhealthy", obwohl er einwandfrei lief. Das
// verdeckt echte Ausfaelle und macht depends_on: service_healthy unbrauchbar.
// Preisgegeben wird nichts: die Antwort ist eine Konstante, und von aussen ist
// der Pfad nicht erreichbar — der Traefik-Router nimmt nur /webhooks.
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

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

  // Zuerst die Projekte des Tenants vollstaendig abraeumen: App-Container,
  // Traefik-Router, Projekt-Netz, Images, Build-Cache, GitHub-Webhook und
  // Monitor. Bis hierher passierte davon nur ein Teil (Monitor und Router) —
  // der Rest blieb liegen und wurde vom naechsten Projekt mit demselben Slug
  // geerbt. Besonders der Build-Cache: der enthaelt den Git-Klon, weshalb ein
  // gleichnamiges Nachfolgeprojekt kommentarlos den Code des Vorgaengers
  // ausgeliefert bekam.
  try {
    const projectDb = new Client({
      connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
    });
    projectDb.on('error', (e) => console.error('pg client error (projectDb):', e.message));
    await projectDb.connect();
    const { rows: projectRows } = await projectDb.query(
      'SELECT slug, repo_url, github_webhook_id, kuma_monitor_id FROM projects WHERE tenant_slug = $1',
      [slug]
    );
    await projectDb.end();
    for (const project of projectRows) {
      warnings.push(...(await cleanupProjectResources(project)));
    }
  } catch (e: any) {
    warnings.push(`Projekt-Cleanup fehlgeschlagen: ${e.message}`);
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
    master.on('error', (e) => console.error('pg client error (master):', e.message));
    await master.connect();
    await master.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [dbName]);
    await master.query(format('DROP DATABASE IF EXISTS %I;', dbName));
    await master.query(format('DROP ROLE IF EXISTS %I;', `authenticator_${slug}`));
    // Migration 21: die CMS-Rolle haengt an derselben Datenbank. Nach dem DROP
    // DATABASE besitzt sie nichts mehr, laesst sich also direkt entfernen —
    // ohne das bliebe pro geloeschtem Tenant eine Login-Rolle im Cluster zurueck.
    await master.query(format('DROP ROLE IF EXISTS %I;', `cms_${slug}`));
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
    admin2.on('error', (e) => console.error('pg client error (admin2):', e.message));
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
    admin3.on('error', (e) => console.error('pg client error (admin3):', e.message));
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
  const { tenantSlug, tariff, displayName, contactEmail, notes, withDatabase } = req.body;
  const tenantTariff = ['starter','business','premium'].includes(tariff) ? tariff : 'starter';
  // Datenbank ist optional (Migration 19), aber Default bleibt "ja": ein
  // Aufrufer, der das Feld nicht kennt (aeltere Dashboard-Version, Skript),
  // soll denselben Tenant bekommen wie bisher. Nur ein explizites false
  // ueberspringt DB, Rollen und die beiden Tenant-Container.
  const wantsDatabase = withDatabase !== false;

  if (!tenantSlug || !/^[a-z0-9-]+$/.test(tenantSlug)) {
    return res.status(400).json({ error: 'invalid slug' });
  }

  // P0-3 (Audit 0430f9c): Der Existenz-Check unten ist NICHT atomar zum
  // CREATE DATABASE. Zwischen beidem liegen >8 Sekunden Provisioning. Ein
  // Doppelklick auf "Tenant anlegen" liess Request 2 durch den Check laufen,
  // an CREATE DATABASE scheitern ("already exists") — und das automatische
  // Rollback von Request 2 hat den gerade fertig gebauten Tenant von Request 1
  // vollstaendig geloescht: DROP DATABASE, DROP ROLE, mc rb --force auf den
  // MinIO-Bucket, rm -rf auf das Tenant-Verzeichnis, DELETE FROM kunden.
  //
  // Session-Level Advisory Lock: haelt genau so lange wie diese pg-Session.
  // Bewusst pg_try_advisory_lock (nicht blockierend) — der zweite Request soll
  // sofort 409 bekommen, nicht 8 Sekunden auf einen Fehler warten.
  // Faellt der Agent mitten im Provisioning aus, gibt Postgres den Lock beim
  // Verbindungsabbruch automatisch frei — kein verwaister Lock.
  const lockKey = crypto.createHash('sha256').update(`tenant:${tenantSlug}`).digest().readInt32BE(0);
  const lockClient = new Client({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
  lockClient.on('error', (e) => console.error('lockClient error:', e.message));
  let lockHeld = false;
  const releaseLock = async () => {
    if (lockHeld) {
      lockHeld = false;
      await lockClient.query('SELECT pg_advisory_unlock($1)', [lockKey]).catch(() => {});
    }
    await lockClient.end().catch(() => {});
  };
  try {
    await lockClient.connect();
    const { rows: lockRows } = await lockClient.query('SELECT pg_try_advisory_lock($1) AS locked', [lockKey]);
    lockHeld = lockRows[0]?.locked === true;
  } catch (err: any) {
    await lockClient.end().catch(() => {});
    return res.status(500).json({ error: `Konnte Provisioning-Lock nicht setzen: ${err.message}` });
  }
  if (!lockHeld) {
    await lockClient.end().catch(() => {});
    return res.status(409).json({ error: `Provisioning fuer "${tenantSlug}" laeuft bereits — bitte warten, nicht erneut klicken.` });
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
    existsCheck.on('error', (e) => console.error('pg client error (existsCheck):', e.message));
    await existsCheck.connect();
    const { rows: existingRows } = await existsCheck.query('SELECT 1 FROM kunden WHERE slug = $1', [tenantSlug]);
    await existsCheck.end();
    if (existingRows.length > 0) {
      await releaseLock();
      return res.status(409).json({ error: `Tenant "${tenantSlug}" existiert bereits` });
    }
  } catch (err: any) {
    console.error('Slug-Existenzprüfung fehlgeschlagen:', err.message);
    await releaseLock();
    return res.status(500).json({ error: `Konnte nicht prüfen, ob Slug bereits existiert: ${err.message}` });
  }

  const dbName = `kunde_${tenantSlug}`;
  const jwtSecret = crypto.randomBytes(32).toString('hex');
  // P0-2b: role-Claim = tenant-eigene Rolle (anon_<slug>/service_role_<slug>).
  const anonJwt = signTenantJwt(jwtSecret, 'anon', tenantSlug);
  const serviceRoleJwt = signTenantJwt(jwtSecret, 'service_role', tenantSlug);
  const authenticatorPw = crypto.randomBytes(16).toString('hex');

  try {
    // Secrets werden IMMER erzeugt und gespeichert, auch ohne Datenbank: sie
    // kosten nichts, und wenn der Kunde spaeter doch eine DB bekommt, laeuft das
    // Nachprovisionieren mit exakt denselben Werten (die anon/service_role-JWTs
    // muessen zum gotrue_jwt_secret passen, sonst sind bereits ausgelieferte
    // Keys ungueltig).
    if (wantsDatabase) {
      await provisionTenantDatabase({
        slug: tenantSlug,
        tariff: tenantTariff,
        jwtSecret,
        authenticatorPassword: authenticatorPw,
      });
    }

    // MinIO haengt NICHT an der Datenbank-Entscheidung: ein Bucket kostet keinen
    // laufenden Container, und Datei-Uploads sind auch fuer eine reine
    // Landingpage (Bilder, PDFs) der Normalfall.
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
    // P2-17: lag vorher dauerhaft im Container-tmp, mit der MinIO-Policy im Klartext.
    await execFileP('rm', ['-f', policyPath]).catch(() => {});

    const admin = new Client({
      connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
    });
    admin.on('error', (e) => console.error('pg client error (admin):', e.message));
    await admin.connect();
    await admin.query(
      'INSERT INTO kunden (slug, db_name, tariff, gotrue_jwt_secret, authenticator_password, minio_access_key, minio_secret_key_encrypted, anon_jwt, service_role_jwt, db_enabled, db_provisioned, display_name, contact_email, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)',
      [
        tenantSlug, dbName, tenantTariff, jwtSecret, authenticatorPw, minioAccessKey, encrypt(minioSecretKey), anonJwt, serviceRoleJwt,
        wantsDatabase, wantsDatabase,
        // P2-6: display_name faellt auf den Slug zurueck statt leer zu bleiben -
        // die Projektliste braucht immer einen anzeigbaren Namen.
        (typeof displayName === 'string' && displayName.trim()) || tenantSlug,
        typeof contactEmail === 'string' ? contactEmail.trim() || null : null,
        typeof notes === 'string' ? notes.trim() || null : null,
      ]
    );
    await admin.end();

    await logAudit('tenant.create', tenantSlug, { tariff: tenantTariff, dbName, withDatabase: wantsDatabase });
    await releaseLock();
    res.json({ status: 'ok', slug: tenantSlug, dbName: wantsDatabase ? dbName : null, withDatabase: wantsDatabase });
  } catch (err: any) {
    console.error('Provisioning failed:', err.message);

    // P0-3, zweite Absicherung: NIEMALS aufraeumen, wenn der Fehler bedeutet,
    // dass die Ressource schon vorher existierte. Der Advisory Lock oben
    // schliesst das Rennen zwischen zwei gleichzeitigen Requests, dieser Guard
    // faengt den Rest ab: manuell angelegte DB, verwaiste Rolle aus einem
    // frueheren Abbruch, Bucket-Reste. In all diesen Faellen wuerde ein Cleanup
    // fremde Daten zerstoeren statt eigene aufzuraeumen.
    if (/already exists/i.test(err.message || '')) {
      console.error(`KEIN Rollback fuer "${tenantSlug}": Ressource existierte bereits.`);
      await logAudit('tenant.create.conflict_no_rollback', tenantSlug, { error: err.message }).catch(() => {});
      await releaseLock();
      return res.status(409).json({
        error: `${err.message} — es wurde NICHTS geloescht. Bestehende Ressourcen zu "${tenantSlug}" ` +
               `manuell pruefen (Datenbank kunde_${tenantSlug}, Rolle authenticator_${tenantSlug}, ` +
               `MinIO-Bucket kunde-${tenantSlug}-storage) und ggf. gezielt entfernen.`,
      });
    }

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
    await releaseLock();
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

// P1-4: Jeden Router einmal umbiegen, bevor er gemountet wird — danach landet
// eine Rejection aus einem async-Handler bei der Error-Middleware unten statt
// als unhandledRejection den Prozess zu beenden.
for (const r of [projectsRouter, tenantsRouter, deploymentsRouter, domainsRouter,
                 githubRouter, backupsRouter, secretsRouter, auditRouter,
                 statsRouter, cleanupRouter, analyticsRouter, cmsRouter, webhooksRouter]) {
  wrapRouterAsync(r);
}

app.use(projectsRouter);
app.use(tenantsRouter);
app.use(deploymentsRouter);
app.use(domainsRouter);
app.use(githubRouter);
app.use(backupsRouter);
app.use(secretsRouter); // rate-limitet sich selbst, siehe routes/secrets.ts
app.use(auditRouter);
app.use(statsRouter); // P1-8: /stats + /stats/overview, siehe routes/stats.ts
app.use(cleanupRouter); // P3-6: /cleanup/run
app.use(analyticsRouter); // Besucherstatistik, siehe lib/analytics.ts
app.use(cmsRouter); // CMS-Rolle + Tabellenrechte, siehe lib/cms.ts


// Die direkt auf `app` registrierten Handler (POST/DELETE /tenants) haengen im
// app-eigenen Stack, nicht in einem der Router oben.
wrapRouterAsync(app);

// Zentrale Error-Middleware. Muss NACH allen Routen stehen und vier Parameter
// haben, sonst behandelt Express sie als normale Middleware.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unbehandelter Fehler im Request-Handler:', err?.stack || err?.message || err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal error' });
});

// P1-4, letzte Verteidigungslinie: was trotz Wrapper durchkommt (Timer-
// Callbacks, fire-and-forget-Promises wie pollDomain oder runDeployment), soll
// den Prozess nicht mehr stillschweigend beenden.
process.on('unhandledRejection', (reason: any) => {
  console.error('unhandledRejection:', reason?.stack || reason);
  alert('unhandledRejection im Provisioning Agent',
        String(reason?.stack || reason), 'unhandledRejection').catch(() => {});
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err?.stack || err.message);
  alert('uncaughtException im Provisioning Agent', String(err?.stack || err.message),
        'uncaughtException').catch(() => {});
  // Bewusst KEIN process.exit(): ein halb fertiger Blue-Green-Swap ist der
  // schlechteste Moment fuer einen Neustart. Der Healthcheck im Compose
  // erkennt einen wirklich kaputten Prozess.
});

app.listen(3001, () => {
  console.log('Provisioning Agent (mit Deployment Engine) listening on :3001');
  // Audit §15: ein Agent-Start im laufenden Betrieb bedeutet, dass er vorher
  // gestorben ist. Genau das war bisher nirgends sichtbar.
  alert('Provisioning Agent gestartet',
        `Der Agent hat um ${new Date().toISOString()} gestartet.\n\n` +
        `Wenn das kein geplantes Deployment war, ist er vorher abgestuerzt — ` +
        `laufende Deployments und der In-Memory-State sind dann verloren.\n` +
        `Logs: docker logs --since 30m provisioning-agent`,
        'agent-start').catch(() => {});
  // P1-1c: offene Domain-Verifikationen nach einem Neustart wieder aufnehmen.
  // Erst fehlende Router reparieren, dann offene Verifikationen fortsetzen.
  healMissingRouters()
    .catch((err) => console.error('healMissingRouters fehlgeschlagen:', err.message))
    .then(() => resumePendingDomainChecks())
    .catch((err) => console.error('resumePendingDomainChecks fehlgeschlagen:', err.message));

  // P3-6: taeglicher Aufraeum-Lauf (Build-Snapshots, Docker-Images) - ohne das
  // laeuft die VPS-Platte bei taeglichen Deployments innerhalb von Wochen voll.
  // Kein node-cron noetig fuer ein einzelnes taegliches Intervall. Erster Lauf
  // schon 5 Minuten nach Start (nicht erst nach 24h) - ein frisch
  // durchgestarteter Agent soll nicht erst einen vollen Tag warten, falls
  // vorher schon Platz knapp war.
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  setTimeout(() => {
    runCleanup().catch((err) => console.error('Initialer Cleanup-Lauf fehlgeschlagen:', err.message));
  }, 5 * 60 * 1000);
  setInterval(() => {
    runCleanup().catch((err) => console.error('Taeglicher Cleanup-Lauf fehlgeschlagen:', err.message));
  }, ONE_DAY_MS);

  // Analytics: Traefik-Accesslog einlesen. Jede Minute, weil die Auswertung
  // "wie viele waren heute da" sonst spuerbar hinterherhinkt — der Lauf selbst
  // ist billig (er liest nur das, was seit dem letzten Mal dazugekommen ist,
  // und macht bei leerem Zuwachs genau eine Query).
  //
  // Kein setInterval mit ueberlappenden Laeufen: bei einem langen Lauf (grosser
  // Rueckstand nach Agent-Ausfall) wuerde sich sonst ein zweiter daraufsetzen
  // und dieselben Zeilen ein zweites Mal zaehlen.
  const ANALYTICS_INTERVAL_MS = Number(process.env.ANALYTICS_INTERVAL_MS || 60_000);
  let analyticsRunning = false;
  const runIngest = () => {
    if (analyticsRunning) return;
    analyticsRunning = true;
    ingestAccessLog()
      .catch((err) => console.error('Analytics-Ingest fehlgeschlagen:', err.message))
      .finally(() => { analyticsRunning = false; });
  };
  setTimeout(runIngest, 30_000);
  setInterval(runIngest, ANALYTICS_INTERVAL_MS);
});
