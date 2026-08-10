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
