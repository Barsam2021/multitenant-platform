import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { Client as PGClient } from 'pg';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile } from 'fs/promises';
import crypto from 'crypto';
import { encrypt } from '../lib/crypto';
import { logAudit } from '../lib/audit';

const execFileP = promisify(execFile);
const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

// Secret-Rotation ist eine seltene, teure Operation (Container-Neustart) — eng begrenzen.
const rotateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

function adminClient(): PGClient {
  return new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
}

export const secretsRouter = Router();

// POST /tenants/:slug/rotate-secret  { secret: 'jwt' | 'minio' }
// Deckt die ersten beiden Zeilen der Secret-Rotation-Matrix aus dem README ab.
// 'resend_api_key' ist global (nicht pro Tenant) und wird daher nicht hier, sondern
// über .env + GoTrue-Neustart aller Tenants rotiert (siehe smoke-test.sh Hinweis).
// 'project_env_vars' läuft bereits über PUT /projects/:id/env (bestehender Code).
// 'PROVISIONING_AGENT_SECRET' MUSS manuell rotiert werden (Dashboard + Agent zeitgleich,
// sonst sperrt sich das Dashboard selbst aus) — bewusst nicht automatisiert.
secretsRouter.post('/tenants/:slug/rotate-secret', rotateLimiter, async (req, res) => {
  const { slug } = req.params;
  const { secret } = req.body;

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'invalid slug' });
  if (!['jwt', 'minio'].includes(secret)) {
    return res.status(400).json({ error: "secret must be 'jwt' or 'minio'" });
  }

  const tenantDir = `/opt/multitenant-platform/kunden-instances/${slug}`;
  const db = adminClient();
  await db.connect();

  try {
    const { rows } = await db.query('SELECT * FROM kunden WHERE slug = $1', [slug]);
    if (rows.length === 0) return res.status(404).json({ error: 'tenant not found' });
    const tenant = rows[0];

    if (secret === 'jwt') {
      const newJwtSecret = crypto.randomBytes(32).toString('hex');
      const composePath = `${tenantDir}/docker-compose.yml`;
      const compose = await readFile(composePath, 'utf8');

      if (!compose.includes(tenant.gotrue_jwt_secret)) {
        return res.status(409).json({
          error: 'altes JWT-Secret nicht in der Compose-Datei gefunden — Datei manuell prüfen, keine Änderung vorgenommen',
        });
      }
      const newCompose = compose.split(tenant.gotrue_jwt_secret).join(newJwtSecret);
      await writeFile(composePath, newCompose);

      await db.query('UPDATE kunden SET gotrue_jwt_secret = $1 WHERE slug = $2', [newJwtSecret, slug]);

      // auth (GoTrue) + api (PostgREST) neu starten, damit beide das neue Secret laden.
      // Alle bereits ausgestellten Tokens dieses Tenants werden damit ungültig (erwartet, siehe Matrix).
      await execFileP('docker', ['compose', '-f', composePath, 'up', '-d', '--force-recreate', 'auth', 'api']);

      await logAudit('rotate-secret', slug, { secret: 'jwt' });
      return res.json({
        status: 'ok',
        slug,
        secret: 'jwt',
        note: 'auth + api neu gestartet. Alle bestehenden Sessions/Tokens dieses Tenants sind jetzt ungültig.',
      });
    }

    // secret === 'minio'
    if (!tenant.minio_access_key) {
      return res.status(409).json({ error: 'Tenant hat keinen minio_access_key — nichts zu rotieren' });
    }
    // mc-Alias lebt nur im Container-Speicher (kein Volume-Mount für ~/.mc) und wird sonst
    // nur bei POST /tenants gesetzt — nach einem Agent-Neustart ohne zwischenzeitliches
    // Tenant-Provisioning wäre er hier sonst nicht vorhanden. Idempotent, harmlos wenn schon gesetzt.
    await execFileP('mc', [
      'alias', 'set', 'localminio', 'http://core-minio:9000',
      process.env.MINIO_ROOT_USER!, process.env.MINIO_ROOT_PASSWORD!,
    ]);
    const newMinioSecret = crypto.randomBytes(24).toString('hex');
    // MinIO: 'mc admin user add' auf einen bereits existierenden Access-Key setzt dessen
    // Secret neu (kein separater "change password"-Befehl nötig/vorhanden).
    await execFileP('mc', ['admin', 'user', 'add', 'localminio', tenant.minio_access_key, newMinioSecret]);
    await db.query('UPDATE kunden SET minio_secret_key_encrypted = $1 WHERE slug = $2', [
      encrypt(newMinioSecret),
      slug,
    ]);

    await logAudit('rotate-secret', slug, { secret: 'minio' });
    return res.json({
      status: 'ok',
      slug,
      secret: 'minio',
      note: 'Neuer MinIO-Secret-Key gesetzt. App-Container dieses Tenants laufen noch mit dem alten Key im Speicher — POST /deployments für betroffene Projekte auslösen, um ihn per Auto-Env-Injection zu erneuern.',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});
