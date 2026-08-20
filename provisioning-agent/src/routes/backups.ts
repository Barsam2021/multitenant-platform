import { Router } from 'express';
import { Client as PGClient } from 'pg';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logAudit } from '../lib/audit';
import {
  isRestoreTestRunning,
  tryAcquireRestoreTestLock,
  releaseRestoreTestLock,
  listRemoteBackups,
} from '../lib/backupHealth';

const execFileP = promisify(execFile);
const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;
const ROOT = '/opt/multitenant-platform';

/**
 * Umgebung fuer die Backup-Skripte.
 *
 * backup-script.sh und restore-test-script.sh arbeiten ueber `docker exec
 * core-postgres pg_dump ...`. Der Agent hat aber DOCKER_HOST=tcp://
 * docker-socket-proxy:2375 gesetzt, und am Proxy steht EXEC: 0
 * (docker-compose.yml) — jeder `docker exec` aus dem Agent heraus bekommt
 * dort ein 403. Aus dem Cron heraus fiel das nie auf: der laeuft auf dem
 * Host, ganz ohne DOCKER_HOST. Ueber das Dashboard gestartet scheiterten
 * "Backup jetzt starten" und "Restore-Test" dagegen zuverlaessig.
 *
 * Loesung wie in lib/nixpacks.ts: fuer diese Kindprozesse auf den rohen
 * Socket umbiegen, der ohnehin gemountet ist. Kein zusaetzliches Risiko —
 * CONTAINERS+POST am Proxy sind bereits root-aequivalent, der Agent hat
 * also so oder so vollen Zugriff (siehe Kommentarkopf der compose-Datei).
 */
const SCRIPT_ENV = { ...process.env, DOCKER_HOST: 'unix:///var/run/docker.sock' };

/**
 * Dateinamen, die das Backup erzeugt. Datenbanken werden als custom-format
 * Dump gesichert (pg_dump -Fc -> *.dump.age), nur die Globals sind ein
 * gzip-tes SQL-Skript (*.sql.gz.age).
 *
 * Die Pruefung hier liess vorher ausschliesslich *.sql.gz.age durch. Damit
 * lehnte der Restore-Test JEDE Datenbank mit 400 ab — also genau den Fall,
 * fuer den er da ist. Dieselbe Bedingung steht (korrekt) in
 * restore-test-script.sh.
 */
const BACKUP_FILENAME_RE = /^[a-zA-Z0-9_.-]+\.(dump|sql\.gz)\.age$/;

function adminClient(): PGClient {
  // P1-4 (Audit 0430f9c): ein pg.Client emittiert bei Verbindungsverlust ein
  // 'error'-Event. OHNE Listener ist das in Node eine uncaught exception, also
  // Prozessende — im schlimmsten Fall mitten im Deploy zwischen `docker rename`
  // und `docker run`: Kundenseite offline, und nichts raeumt auf. deploy.ts
  // haelt einen solchen Client ueber die gesamte Deploy-Dauer offen (Build-
  // Timeout allein 10 Minuten).
  const client = new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
  client.on('error', (err) => console.error('pg client error (adminClient):', err.message));
  return client;
}

export const backupsRouter = Router();

let backupRunning = false;
// restoreTestRunning liegt bewusst NICHT mehr hier: der geplante Lauf aus
// lib/backupHealth.ts benutzt dasselbe Skript und dieselbe Wegwerf-Datenbank.
// Zwei Flags in zwei Modulen haetten sich gegenseitig nicht gesehen.

backupsRouter.get('/backups', async (_req, res) => {
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT id, db_name, filename, size_bytes, status, created_at
       FROM backups ORDER BY created_at DESC LIMIT 100`
    );
    // size_bytes ist BIGINT und kommt aus node-postgres als String. Hier an
    // der API-Grenze in eine Zahl wandeln, nicht erst im Frontend: sonst muss
    // jede Stelle, die den Wert anfasst, denselben Sonderfall kennen.
    const backups = rows.map((row) => ({ ...row, size_bytes: Number(row.size_bytes) }));
    res.json({ backups, backupRunning, restoreTestRunning: isRestoreTestRunning() });
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
    env: SCRIPT_ENV,
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
  if (!filename || !BACKUP_FILENAME_RE.test(filename)) {
    return res.status(400).json({ error: 'invalid filename' });
  }
  if (!tryAcquireRestoreTestLock()) {
    return res.status(409).json({ error: 'restore test already running' });
  }
  await logAudit('backup.restore_test.started', filename, {});

  try {
    const { stdout } = await execFileP('bash', [`${ROOT}/backups/restore-test-script.sh`, filename], {
      maxBuffer: 1024 * 1024 * 16,
      timeout: 15 * 60 * 1000,
      env: SCRIPT_ENV,
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
    releaseRestoreTestLock();
  }
});

/**
 * Was liegt tatsaechlich im Object Storage?
 *
 * GET /backups liest die `backups`-Tabelle — also das, was der Server glaubt,
 * gesichert zu haben. Nach einem Serververlust ist diese Tabelle selbst weg,
 * und im Ernstfall zaehlt allein der Bestand beim Anbieter. Bisher kam man an
 * ihn nur ueber `restore-script.sh list` per SSH.
 */
backupsRouter.get('/backups/remote', async (_req, res) => {
  try {
    const files = await listRemoteBackups();
    res.json({
      files,
      totalBytes: files.reduce((sum, f) => sum + f.size, 0),
    });
  } catch (err: any) {
    // Bewusst 502 und nicht 500: der Agent ist gesund, der Object Storage
    // (oder dessen Konfiguration) nicht. Das Dashboard blendet die Spalte
    // daraufhin aus, statt die ganze Seite als kaputt zu melden.
    res.status(502).json({ error: err.message });
  }
});
