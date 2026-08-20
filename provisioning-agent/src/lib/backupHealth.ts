/**
 * Backup-Gesundheit: Totmannschalter, Restore-Test-Planer, Blick in den
 * Object Storage.
 *
 * Hintergrund (BACKUP-PLAN.md, B-4): das naechtliche Backup alarmiert nur aus
 * dem laufenden Skript heraus. Faellt der Cron ganz aus — Server aus, `cron`
 * nach bootstrap.sh nie neu geladen, Skript nicht mehr ausfuehrbar —, dann
 * passiert exakt nichts. Und Stille sieht genauso aus wie Erfolg.
 *
 * Dieses Modul dreht die Blickrichtung um: statt zu melden, wenn etwas
 * schiefging, fragt es taeglich nach, ob ueberhaupt etwas passiert ist.
 */
import { Client as PGClient } from 'pg';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { alert } from './alert';
import { logAudit } from './audit';

const execFileP = promisify(execFile);

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;
const ROOT = '/opt/multitenant-platform';

/**
 * Siehe routes/backups.ts: die Backup-Skripte arbeiten mit `docker exec`, der
 * Socket-Proxy des Agents laesst das nicht durch (EXEC: 0). Fuer diese
 * Kindprozesse deshalb auf den rohen Socket umbiegen, wie lib/nixpacks.ts es
 * fuer BuildKit tut.
 */
const SCRIPT_ENV = { ...process.env, DOCKER_HOST: 'unix:///var/run/docker.sock' };

/** Ab wann ein Backup als ueberfaellig gilt. 36h laesst einen ausgefallenen
 *  Lauf plus die naechste regulaere Nacht zu, bevor es laut wird. */
const MAX_AGE_HOURS = Number(process.env.BACKUP_MAX_AGE_HOURS || 36);

/** Wie alt die Bestaetigung des Off-Site-DR-Bundles sein darf (B-1). */
const DR_BUNDLE_MAX_AGE_DAYS = Number(process.env.BACKUP_DR_BUNDLE_MAX_AGE_DAYS || 180);

/** Abstand zwischen zwei automatischen Restore-Tests. */
const RESTORE_TEST_INTERVAL_DAYS = Number(process.env.BACKUP_RESTORE_TEST_INTERVAL_DAYS || 7);

function adminClient(): PGClient {
  // P1-4: ohne 'error'-Listener ist ein Verbindungsabbruch eine uncaught
  // exception und damit das Prozessende — hier besonders unschoen, weil dieser
  // Client aus einem Hintergrund-Timer kommt und niemand danebensteht.
  const client = new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
  client.on('error', (err) => console.error('pg client error (backupHealth):', err.message));
  return client;
}

// ---------------------------------------------------------------------------
// Gemeinsame Sperre fuer Restore-Tests
// ---------------------------------------------------------------------------
// Der geplante Lauf (Sonntagfrueh) und der Knopf im Dashboard rufen dasselbe
// Skript. Zwei gleichzeitige Laeufe wuerden dieselbe Wegwerf-DB anlegen und
// loeschen — und nebenbei die Produktiv-Postgres doppelt belasten. Die Sperre
// liegt deshalb hier und nicht in der Route: sonst haette jeder Aufrufer seine
// eigene, und genau das war der Zustand vorher.
let restoreTestRunning = false;

export function isRestoreTestRunning(): boolean {
  return restoreTestRunning;
}

export function tryAcquireRestoreTestLock(): boolean {
  if (restoreTestRunning) return false;
  restoreTestRunning = true;
  return true;
}

export function releaseRestoreTestLock(): void {
  restoreTestRunning = false;
}

// ---------------------------------------------------------------------------
// Totmannschalter
// ---------------------------------------------------------------------------

export interface BackupFreshness {
  lastOkAt: Date | null;
  ageHours: number | null;
  stale: boolean;
  /** Datenbanken, die es gibt, zu denen aber kein frisches Backup existiert. */
  missing: string[];
}

/**
 * Taeglicher Nachfass: Gibt es ein aktuelles, erfolgreiches Backup?
 *
 * Zwei Fragen, nicht eine:
 *
 *  1. Ist ueberhaupt in den letzten MAX_AGE_HOURS etwas erfolgreich gelaufen?
 *     Das faengt den ausgefallenen Cron.
 *  2. Fehlt einer *einzelnen* Datenbank ein frisches Backup? Das faengt den
 *     unangenehmeren Fall: ein Tenant scheitert jede Nacht, alle anderen
 *     laufen durch — die juengste Zeile in `backups` ist dann taufrisch und
 *     die Luecke faellt niemandem auf.
 */
export async function checkBackupFreshness(): Promise<BackupFreshness> {
  const db = adminClient();
  await db.connect();
  try {
    const { rows: lastRows } = await db.query<{ last_ok: Date | null }>(
      `SELECT max(created_at) AS last_ok FROM backups WHERE status = 'ok'`
    );
    const lastOkAt = lastRows[0]?.last_ok ?? null;
    const ageHours = lastOkAt ? (Date.now() - lastOkAt.getTime()) / 3_600_000 : null;
    const stale = ageHours === null || ageHours > MAX_AGE_HOURS;

    // Welche Datenbanken muessten gesichert sein? Dieselbe Auswahl, die
    // backup-script.sh trifft — bewusst gegen pg_database und nicht gegen die
    // `kunden`-Tabelle: gesichert wird, was existiert, nicht was verwaltet ist.
    const { rows: dbRows } = await db.query<{ datname: string }>(
      `SELECT datname FROM pg_database
        WHERE datname = 'admin_dashboard' OR datname LIKE 'kunde\\_%'`
    );
    const { rows: freshRows } = await db.query<{ db_name: string }>(
      `SELECT DISTINCT db_name FROM backups
        WHERE status = 'ok' AND created_at > now() - ($1 || ' hours')::interval`,
      [String(MAX_AGE_HOURS)]
    );
    const fresh = new Set(freshRows.map((r) => r.db_name));
    const missing = dbRows.map((r) => r.datname).filter((name) => !fresh.has(name));

    if (stale) {
      const wann = lastOkAt
        ? `Das letzte erfolgreiche Backup ist vom ${lastOkAt.toISOString()} und damit ${Math.floor(ageHours!)} Stunden alt.`
        : 'Es gibt ueberhaupt kein erfolgreiches Backup in der Datenbank.';
      await alert(
        'Backup ueberfaellig',
        `${wann}

Erwartet wird ein Lauf alle 24 Stunden (cron, 03:00). Schwelle: ${MAX_AGE_HOURS}h.

Pruefen:
  systemctl status cron
  cat /etc/cron.d/multitenant-backup
  tail -100 /var/log/mt-backup.log
  docker exec core-postgres psql -U postgres -d admin_dashboard \\
    -c "SELECT * FROM backups ORDER BY created_at DESC LIMIT 20;"

Von Hand ausloesen: /opt/multitenant-platform/backups/backup-script.sh`,
        'backup-stale'
      );
      await logAudit('backup.freshness.stale', null, { lastOkAt, ageHours });
    } else if (missing.length > 0) {
      // Eigener Alarm, eigener Dedupe-Key: "Cron laeuft, aber ein Tenant
      // faellt durch" ist ein anderes Problem als "gar nichts laeuft" und
      // darf nicht vom anderen verdeckt werden.
      await alert(
        'Backup unvollstaendig',
        `Der Backup-Lauf ist aktuell, aber fuer diese Datenbanken gibt es kein
erfolgreiches Backup der letzten ${MAX_AGE_HOURS} Stunden:

${missing.map((m) => `  - ${m}`).join('\n')}

Das deutet auf einen Fehler bei genau diesen Datenbanken hin, nicht auf einen
ausgefallenen Scheduler. Sichtbar im Log des letzten Laufs:
  tail -200 /var/log/mt-backup.log`,
        'backup-incomplete'
      );
      await logAudit('backup.freshness.incomplete', null, { missing });
    }

    return { lastOkAt, ageHours, stale, missing };
  } finally {
    await db.end();
  }
}

// ---------------------------------------------------------------------------
// DR-Bundle und Entschluesselbarkeit
// ---------------------------------------------------------------------------

/**
 * B-1, das teuerste Problem im ganzen Backup-Aufbau: die Sicherungen sind mit
 * `age` verschluesselt, und der private Schluessel liegt per Default unter
 * /opt/multitenant-platform/backups/age-identity.txt — also auf genau dem
 * Server, gegen dessen Verlust gesichert wird. Ohne Off-Site-Kopie sind die
 * Dateien im Object Storage nach einem Totalverlust unlesbare Bytes.
 *
 * Erzwingen laesst sich das von hier aus nicht. Sichtbar machen schon:
 *
 *  - Fehlt die Identity-Datei, ist ein Restore heute schon unmoeglich.
 *  - Fehlt oder veraltet BACKUP_DR_BUNDLE_CONFIRMED_AT, hat seit ueber einem
 *    halben Jahr niemand bestaetigt, dass es die Off-Site-Kopie gibt.
 */
export async function checkDisasterRecoveryReadiness(): Promise<void> {
  const identityFile = process.env.BACKUP_AGE_IDENTITY_FILE;
  if (!identityFile || !existsSync(identityFile)) {
    await alert(
      'Restore nicht moeglich: age-Identity fehlt',
      `BACKUP_AGE_IDENTITY_FILE zeigt auf "${identityFile ?? '(nicht gesetzt)'}" —
diese Datei existiert nicht. Ohne den privaten age-Schluessel laesst sich KEIN
Backup entschluesseln. Die naechtlichen Laeufe funktionieren weiter (die
brauchen nur den oeffentlichen Schluessel), der Ernstfall aber nicht.

Schluessel aus dem Off-Site-DR-Bundle zurueckspielen oder, falls es keines
gibt, neu erzeugen und ALLE bestehenden Backups als verloren betrachten:
  age-keygen -o /opt/multitenant-platform/backups/age-identity.txt`,
      'dr-identity-missing'
    );
    return;
  }

  const confirmed = process.env.BACKUP_DR_BUNDLE_CONFIRMED_AT;
  const confirmedAt = confirmed ? new Date(confirmed) : null;
  const valid = confirmedAt && !Number.isNaN(confirmedAt.getTime());
  const ageDays = valid ? (Date.now() - confirmedAt!.getTime()) / 86_400_000 : null;

  if (!valid || ageDays! > DR_BUNDLE_MAX_AGE_DAYS) {
    await alert(
      'Off-Site-DR-Bundle unbestaetigt',
      `${
        valid
          ? `Die letzte Bestaetigung des DR-Bundles ist vom ${confirmedAt!.toISOString().slice(0, 10)} und damit ${Math.floor(ageDays!)} Tage alt.`
          : 'BACKUP_DR_BUNDLE_CONFIRMED_AT ist nicht gesetzt oder kein gueltiges Datum.'
      }

Das DR-Bundle gehoert NICHT auf diesen Server. Es besteht aus drei Dateien:
  - backups/age-identity.txt   (ohne die ist jedes Backup unlesbar)
  - backups/rclone.conf        (Zugang zum Object Storage)
  - .env                       (ENCRYPTION_MASTER_KEY, sonst bleiben alle
                                verschluesselten Env-Vars und MinIO-Keys tot)

Ablegen in einem Passwortmanager oder einem zweiten, getrennten Konto. Danach
in der .env eintragen und den Agent neu starten:
  BACKUP_DR_BUNDLE_CONFIRMED_AT=${new Date().toISOString().slice(0, 10)}

Pruefintervall: ${DR_BUNDLE_MAX_AGE_DAYS} Tage (BACKUP_DR_BUNDLE_MAX_AGE_DAYS).`,
      'dr-bundle-unconfirmed'
    );
  }
}

// ---------------------------------------------------------------------------
// Blick in den Object Storage
// ---------------------------------------------------------------------------

export interface RemoteBackupFile {
  name: string;
  path: string;
  /** daily | weekly | monthly | '' — der Generationen-Ordner aus Phase 4. */
  generation: string;
  size: number;
  modTime: string;
}

/**
 * Was tatsaechlich im Object Storage liegt.
 *
 * Die `backups`-Tabelle sagt nur, was der Server glaubt, hochgeladen zu haben —
 * und sie ist nach einem Totalverlust selbst weg. Im Ernstfall zaehlt allein
 * diese Liste. Bisher kam man an sie nur ueber `restore-script.sh list` auf
 * der Kommandozeile.
 */
export async function listRemoteBackups(): Promise<RemoteBackupFile[]> {
  const configPath = process.env.RCLONE_CONFIG || `${ROOT}/backups/rclone.conf`;
  const remote = process.env.RCLONE_REMOTE_PATH;
  if (!remote) throw new Error('RCLONE_REMOTE_PATH ist nicht gesetzt');

  // -R: seit Phase 4 liegen die Dateien in daily/ weekly/ monthly/.
  // --files-only: Ordner selbst interessieren nicht.
  const { stdout } = await execFileP(
    'rclone',
    ['--config', configPath, 'lsjson', '-R', '--files-only', `${remote}/`],
    { maxBuffer: 1024 * 1024 * 8, timeout: 60_000, env: SCRIPT_ENV }
  );

  const parsed = JSON.parse(stdout) as { Name: string; Path: string; Size: number; ModTime: string }[];
  return parsed
    .filter((f) => f.Name.endsWith('.age'))
    .map((f) => ({
      name: f.Name,
      path: f.Path,
      generation: f.Path.includes('/') ? f.Path.split('/')[0] : '',
      size: Number(f.Size),
      modTime: f.ModTime,
    }))
    .sort((a, b) => (a.modTime < b.modTime ? 1 : -1));
}

// ---------------------------------------------------------------------------
// Geplanter Restore-Test
// ---------------------------------------------------------------------------

export interface RestoreTestOutcome {
  filename: string;
  dbName: string;
  ok: boolean;
  tableCount: number | null;
  rowTotal: number | null;
  error?: string;
}

/**
 * Waehlt die Datenbank, deren Restore am laengsten nicht geprueft wurde, und
 * spielt ihr juengstes Backup in eine Wegwerf-DB zurueck.
 *
 * Nur *.dump.age kommt in Frage: restore-test-script.sh leitet den DB-Namen aus
 * dem Dateinamen ab und legt eine Test-Datenbank an. Fuer globals_*.sql.gz.age
 * ergaebe das eine Datenbank "globals", in die CREATE-ROLE-Statements liefen —
 * die Rollen sind aber clusterweit, der Test waere sinnlos und nebenbei
 * riskant.
 *
 * Das Ergebnis wird als eigene Zeile in `backups` protokolliert. Damit steht in
 * der Backups-Ansicht chronologisch, wann zuletzt bewiesen wurde, dass die
 * Sicherungen etwas taugen — der Satz aus OPERATIONS.md ("Ein Backup, das nie
 * zurueckgespielt wurde, ist kein Backup") bekommt so ein Datum.
 */
export async function runScheduledRestoreTest(): Promise<RestoreTestOutcome | null> {
  if (!tryAcquireRestoreTestLock()) {
    console.log('Restore-Test laeuft bereits — geplanter Lauf uebersprungen.');
    return null;
  }

  const db = adminClient();
  await db.connect();
  try {
    // Kandidat: pro Datenbank das juengste erfolgreiche Dump-Backup, sortiert
    // danach, wann diese Datenbank zuletzt getestet wurde (nie getestet zuerst).
    const { rows } = await db.query<{ db_name: string; filename: string }>(
      `WITH neueste AS (
         SELECT DISTINCT ON (db_name) db_name, filename, created_at
           FROM backups
          WHERE status = 'ok' AND filename LIKE '%.dump.age'
          ORDER BY db_name, created_at DESC
       ),
       getestet AS (
         SELECT db_name, max(created_at) AS zuletzt
           FROM backups
          WHERE status IN ('restore_test_ok', 'restore_test_failed')
          GROUP BY db_name
       )
       SELECT n.db_name, n.filename
         FROM neueste n
         LEFT JOIN getestet g ON g.db_name = n.db_name
        ORDER BY g.zuletzt ASC NULLS FIRST
        LIMIT 1`
    );

    if (rows.length === 0) {
      console.log('Kein Dump-Backup vorhanden — geplanter Restore-Test uebersprungen.');
      return null;
    }

    const { db_name: dbName, filename } = rows[0];
    console.log(`Geplanter Restore-Test: ${filename} (${dbName})`);
    await logAudit('backup.restore_test.started', filename, { scheduled: true });

    try {
      const { stdout } = await execFileP(
        'bash',
        [`${ROOT}/backups/restore-test-script.sh`, filename],
        { maxBuffer: 1024 * 1024 * 16, timeout: 15 * 60 * 1000, env: SCRIPT_ENV }
      );
      const match = stdout.match(/RESTORE_TEST_RESULT:OK:(\d+):(\d+)/);
      const tableCount = match ? Number(match[1]) : null;
      const rowTotal = match ? Number(match[2]) : null;

      await recordResult(db, dbName, filename, 'restore_test_ok');
      await logAudit('backup.restore_test.finished', filename, {
        scheduled: true,
        status: 'ok',
        tableCount,
        rowTotal,
      });
      console.log(`Restore-Test ok: ${dbName} — ${tableCount} Tabellen, ${rowTotal} Zeilen.`);
      return { filename, dbName, ok: true, tableCount, rowTotal };
    } catch (err: any) {
      const log = ((err.stdout || '') + '\n' + (err.stderr || '')).slice(-2000);
      await recordResult(db, dbName, filename, 'restore_test_failed');
      await logAudit('backup.restore_test.finished', filename, {
        scheduled: true,
        status: 'failed',
        error: err.message,
      });
      await alert(
        'Restore-Test fehlgeschlagen',
        `Das Backup "${filename}" liess sich nicht in eine Test-Datenbank
zurueckspielen. Solange das so bleibt, ist die Sicherung dieser Datenbank
unbewiesen — im Ernstfall womoeglich wertlos.

Fehler: ${err.message}

Letzte Ausgabe:
${log}

Von Hand nachstellen:
  /opt/multitenant-platform/backups/restore-test-script.sh ${filename}`,
        `restore-test-failed-${dbName}`
      );
      return { filename, dbName, ok: false, tableCount: null, rowTotal: null, error: err.message };
    }
  } finally {
    await db.end();
    releaseRestoreTestLock();
  }
}

async function recordResult(
  db: PGClient,
  dbName: string,
  filename: string,
  status: 'restore_test_ok' | 'restore_test_failed'
): Promise<void> {
  // size_bytes bleibt 0: die Zeile beschreibt ein Ereignis, keine Datei.
  await db
    .query(
      `INSERT INTO backups (db_name, filename, size_bytes, status, created_at)
       VALUES ($1, $2, 0, $3, now())`,
      [dbName, filename, status]
    )
    .catch((err) =>
      console.error('Restore-Test-Ergebnis konnte nicht protokolliert werden:', err.message)
    );
}

/**
 * Faellig? Dann testen.
 *
 * Der Takt kommt bewusst aus der Datenbank und nicht aus einem Zaehler im
 * Speicher: ein Agent-Neustart — bei Deployments Alltag — wuerde einen
 * In-Memory-Takt jedes Mal zuruecksetzen. Je nach Richtung liefe der Test
 * dann entweder staendig oder nie. Die letzte Testzeile in `backups` weiss
 * dagegen immer, wann zuletzt geprueft wurde.
 */
export async function runScheduledRestoreTestIfDue(): Promise<RestoreTestOutcome | null> {
  const db = adminClient();
  await db.connect();
  let due: boolean;
  try {
    const { rows } = await db.query<{ last: Date | null }>(
      `SELECT max(created_at) AS last FROM backups
        WHERE status IN ('restore_test_ok', 'restore_test_failed')`
    );
    const last = rows[0]?.last ?? null;
    due = !last || (Date.now() - last.getTime()) / 86_400_000 >= RESTORE_TEST_INTERVAL_DAYS;
  } finally {
    await db.end();
  }

  if (!due) return null;
  return runScheduledRestoreTest();
}
