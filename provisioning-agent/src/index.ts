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
  const { tenantSlug } = req.body;

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

    const template = await readFile('/app/templates/tenant-compose.yml', 'utf8');
    const compose = template
      .replace(/\$\{SLUG\}/g, tenantSlug)
      .replace(/\$\{JWT_SECRET\}/g, jwtSecret)
      .replace(/\$\{AUTH_PW\}/g, authenticatorPw);

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

    await execFileP('docker', ['compose', '-f', `${tenantDir}/docker-compose.yml`, 'up', '-d', 'api']);

    const admin = new Client({
      connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
    });
    await admin.connect();
    await admin.query(
      'INSERT INTO kunden (slug, db_name, gotrue_jwt_secret, authenticator_password) VALUES ($1, $2, $3, $4)',
      [tenantSlug, dbName, jwtSecret, authenticatorPw]
    );
    await admin.end();

    res.json({ status: 'ok', slug: tenantSlug, dbName });
  } catch (err: any) {
    console.error('Provisioning failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use(projectsRouter);
app.use(deploymentsRouter);
app.use(domainsRouter);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(3001, () => console.log('Provisioning Agent (mit Deployment Engine) listening on :3001'));
