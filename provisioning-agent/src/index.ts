import express from 'express';
import { Client } from 'pg';
import format from 'pg-format';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, mkdir } from 'fs/promises';
import crypto from 'crypto';
import { projectsRouter } from './routes/projects';
import { deploymentsRouter } from './routes/deployments';
import { domainsRouter } from './routes/domains';
import { webhooksRouter } from './routes/webhooks';
import { encrypt } from './lib/crypto';

const execFileP = promisify(execFile);
const app = express();

const AGENT_SECRET = process.env.PROVISIONING_AGENT_SECRET!;
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;
const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';

app.use('/webhooks', express.raw({ type: 'application/json', limit: '5mb' }), webhooksRouter);

app.use(express.json());
app.use((req, res, next) => {
  if (req.headers['x-agent-secret'] !== AGENT_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

app.post('/tenants', async (req, res) => {
  const { tenantSlug, tariff } = req.body;
  const tenantTariff = ['starter','business','premium'].includes(tariff) ? tariff : 'starter';

  if (!tenantSlug || !/^[a-z0-9-]+$/.test(tenantSlug)) {
    return res.status(400).json({ error: 'invalid slug' });
  }

  const dbName = `kunde_${tenantSlug}`;
  const jwtSecret = crypto.randomBytes(32).toString('hex');
  const authenticatorPw = crypto.randomBytes(16).toString('hex');

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
    const rolesSql = await readFile('/opt/multitenant-platform/core-postgres/init-scripts/01_roles.sql', 'utf8');
    await tenant.query(rolesSql.replace(/CHANGE_ME/g, authenticatorPw));
    await tenant.query(`ALTER ROLE authenticator WITH PASSWORD '${authenticatorPw}';`);
    await tenant.query(`CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION authenticator;`);
    await tenant.query(`GRANT ALL ON SCHEMA auth TO authenticator;`);
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
      .replace(/\$\{PLATFORM_DOMAIN\}/g, process.env.PLATFORM_DOMAIN as string)
      .replace(/\$\{POSTGREST_MEM\}/g, postgrestMem)
      .replace(/\$\{POSTGREST_CPUS\}/g, postgrestCpus)
      .replace(/\$\{GOTRUE_MEM\}/g, gotrueMem)
      .replace(/\$\{GOTRUE_CPUS\}/g, gotrueCpus)
      .replace(/\$\{RESEND_API_KEY\}/g, '')
      .replace(/\$\{TENANT_NAME\}/g, tenantSlug);

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
      'INSERT INTO kunden (slug, db_name, tariff, gotrue_jwt_secret, authenticator_password, minio_access_key, minio_secret_key_encrypted) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [tenantSlug, dbName, tenantTariff, jwtSecret, authenticatorPw, minioAccessKey, encrypt(minioSecretKey)]
    );
    await admin.end();

    res.json({ status: 'ok', slug: tenantSlug, dbName });
  } catch (err: any) {
    console.error('Provisioning failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});


app.delete('/tenants/:slug', async (req, res) => {
  const { slug } = req.params;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'invalid slug' });
  }
  const dbName = `kunde_${slug}`;
  const tenantDir = `/opt/multitenant-platform/kunden-instances/${slug}`;

  try {
    try {
      await execFileP('docker', ['compose', '-f', `${tenantDir}/docker-compose.yml`, 'down']);
    } catch (e: any) {
      console.error('Container stop failed (continuing):', e.message);
    }

    const master = new Client({
      connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/postgres`,
    });
    await master.connect();
    await master.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [dbName]);
    await master.query(format('DROP DATABASE IF EXISTS %I;', dbName));
    await master.end();

    try {
      await execFileP('mc', ['rb', '--force', `localminio/kunde-${slug}-storage`]);
    } catch (e: any) {
      console.error('MinIO bucket removal failed (continuing):', e.message);
    }

    const admin2 = new Client({
      connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
    });
    await admin2.connect();
    const { rows } = await admin2.query('SELECT minio_access_key FROM kunden WHERE slug = $1', [slug]);
    if (rows[0]?.minio_access_key) {
      try {
        await execFileP('mc', ['admin', 'user', 'remove', 'localminio', rows[0].minio_access_key]);
      } catch (e: any) {
        console.error('MinIO user removal failed (continuing):', e.message);
      }
    }
    try {
      await execFileP('mc', ['admin', 'policy', 'remove', 'localminio', `kunde-${slug}-policy`]);
    } catch (e: any) {
      console.error('MinIO policy removal failed (continuing):', e.message);
    }

    await execFileP('rm', ['-rf', tenantDir]);

    await admin2.query('DELETE FROM kunden WHERE slug = $1', [slug]);
    await admin2.end();

    res.json({ status: 'ok', slug });
  } catch (err: any) {
    console.error('Tenant deletion failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use(projectsRouter);
app.use(deploymentsRouter);
app.use(domainsRouter);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(3001, () => console.log('Provisioning Agent (mit Deployment Engine) listening on :3001'));
