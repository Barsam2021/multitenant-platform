import { execFile } from 'child_process';
import { promisify } from 'util';
import { readdir, rm } from 'fs/promises';
import { Client as PGClient } from 'pg';
import { BUILDS_ROOT } from './git';
import { logAudit } from './audit';

const execFileP = promisify(execFile);
const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

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

// P3-6: build_log ist TEXT ohne Grenze, maxBuffer erlaubt bis zu 32MB pro Build.
// Bei taeglichen Deployments ueber mehrere Kunden waechst die Spalte unbegrenzt.
// Anfang und Ende sind fuer Debugging am wertvollsten (Build-Start-Kontext bzw.
// der eigentliche Fehler) - die Mitte wird ersetzt, nicht einfach abgeschnitten.
const BUILD_LOG_MAX_BYTES = 1_000_000;
const BUILD_LOG_KEEP_EACH_END = 400_000;

export function truncateBuildLog(log: string): string {
  const bytes = Buffer.byteLength(log, 'utf8');
  if (bytes <= BUILD_LOG_MAX_BYTES) return log;
  const head = log.slice(0, BUILD_LOG_KEEP_EACH_END);
  const tail = log.slice(-BUILD_LOG_KEEP_EACH_END);
  return `${head}\n\n[... gekürzt: ursprünglich ${bytes.toLocaleString('de-DE')} Bytes, Mitte entfernt ...]\n\n${tail}`;
}

/**
 * Loescht Build-Snapshots (deployments/builds/<slug>/<sha>/) ausser den letzten
 * drei Deployments je Projekt. Der 'repo'-Checkout-Ordner (Basis fuer den naechsten
 * 'git fetch') bleibt immer erhalten - nur die commit-spezifischen Kopien werden
 * geprueft.
 */
export async function pruneOldBuildSnapshots(): Promise<{ removed: string[]; freedBytes: number; errors: string[] }> {
  const removed: string[] = [];
  const errors: string[] = [];
  let freedBytes = 0;

  const db = adminClient();
  await db.connect();
  try {
    const { rows: projects } = await db.query('SELECT id, slug FROM projects');
    for (const project of projects) {
      const projectDir = `${BUILDS_ROOT}/${project.slug}`;
      let entries: string[];
      try {
        entries = await readdir(projectDir);
      } catch {
        continue; // Projekt hat noch nie gebaut - kein Ordner, nichts zu tun.
      }

      const { rows: recentDeploys } = await db.query(
        `SELECT commit_sha FROM deployments
         WHERE project_id = $1 AND commit_sha IS NOT NULL
         ORDER BY created_at DESC LIMIT 3`,
        [project.id]
      );
      const keepShas = new Set(recentDeploys.map((d) => String(d.commit_sha).slice(0, 12)));

      for (const entry of entries) {
        if (entry === 'repo' || keepShas.has(entry)) continue;
        const fullPath = `${projectDir}/${entry}`;
        try {
          const size = await dirSize(fullPath);
          await rm(fullPath, { recursive: true, force: true });
          removed.push(fullPath);
          freedBytes += size;
        } catch (e: any) {
          errors.push(`${fullPath}: ${e.message}`);
        }
      }
    }
  } finally {
    await db.end();
  }
  return { removed, freedBytes, errors };
}

async function dirSize(path: string): Promise<number> {
  try {
    const { stdout } = await execFileP('du', ['-sb', path]);
    return Number(stdout.split('\t')[0]) || 0;
  } catch {
    return 0;
  }
}

/**
 * Entfernt app-<slug>:<sha>-Images ausser den Tags der letzten fuenf Deployments
 * je Projekt. docker rmi schlaegt fehl (und wird ignoriert), wenn ein Image noch
 * von einem laufenden Container benutzt wird - das schuetzt automatisch das
 * aktuell aktive Image, ohne dass hier extra danach gefragt werden muss.
 */
export async function pruneOldDockerImages(): Promise<{ removed: string[]; errors: string[] }> {
  const removed: string[] = [];
  const errors: string[] = [];

  const db = adminClient();
  await db.connect();
  try {
    const { rows: projects } = await db.query('SELECT id, slug FROM projects');

    let allImages: string[] = [];
    try {
      const { stdout } = await execFileP('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}']);
      allImages = stdout.trim().split('\n').filter(Boolean);
    } catch (e: any) {
      errors.push(`docker images: ${e.message}`);
      return { removed, errors };
    }

    for (const project of projects) {
      const prefix = `app-${project.slug}:`;
      const projectImages = allImages.filter((img) => img.startsWith(prefix));
      if (projectImages.length === 0) continue;

      // P1-8 (Audit 0430f9c): vorher wurden schlicht die letzten 5 Deployments
      // nach created_at behalten — unabhaengig davon, welches aktiv ist und
      // welche fuer einen Rollback gebraucht werden. Nach fuenf fehlgeschlagenen
      // Deploys war das letzte funktionierende Image weg, die UI bot es
      // weiterhin als Rollback-Ziel an, und der Rollback scheiterte mit
      // "no such image" NACH dem docker rm -f. Kunde offline, kein Weg zurueck
      // ausser neu bauen.
      //
      // Jetzt drei Schutzklassen: das aktive Image des Projekts, die letzten
      // fuenf ERFOLGREICHEN Deployments (= die realistischen Rollback-Ziele) und
      // zusaetzlich die letzten drei Images ueberhaupt fuer die Fehlerdiagnose.
      const { rows: protectedDeploys } = await db.query(
        `SELECT DISTINCT image_tag FROM deployments d
         WHERE d.project_id = $1 AND d.image_tag IS NOT NULL
           AND (
             d.id = (SELECT active_deployment_id FROM projects WHERE id = $1)
             OR d.id IN (
               SELECT id FROM deployments
               WHERE project_id = $1 AND image_tag IS NOT NULL
                 AND status IN ('deployed', 'rolled_back')
               ORDER BY created_at DESC LIMIT 5
             )
             OR d.id IN (
               SELECT id FROM deployments
               WHERE project_id = $1 AND image_tag IS NOT NULL
               ORDER BY created_at DESC LIMIT 3
             )
           )`,
        [project.id]
      );
      const keepTags = new Set(protectedDeploys.map((d) => d.image_tag));

      // Zusaetzliche Absicherung unabhaengig von der DB: was gerade laeuft,
      // wird nie entfernt, auch wenn die deployments-Tabelle es nicht kennt.
      try {
        const { stdout: inUse } = await execFileP('docker', ['ps', '-a', '--format', '{{.Image}}']);
        for (const img of inUse.trim().split('\n')) if (img) keepTags.add(img);
      } catch { /* docker nicht erreichbar - dann lieber gar nicht loeschen */ }

      for (const img of projectImages) {
        if (keepTags.has(img)) continue;
        try {
          await execFileP('docker', ['rmi', img]);
          removed.push(img);
        } catch (e: any) {
          // Meist "image is being used by running container" - erwartet und ok,
          // nicht als Fehler protokollieren, nur wenn's ein anderer Grund ist.
          if (!/being used by/.test(e.message)) errors.push(`${img}: ${e.message}`);
        }
      }
    }
  } finally {
    await db.end();
  }
  return { removed, errors };
}

/**
 * Build-Cache von BuildKit. R-05 der Ressourcen-Analyse (2026-08-27): der Cache
 * lag bei zwei Projekten nach drei Wochen Betrieb bei 57,7 GB — mehr als
 * Images, Snapshots und Volumes zusammen — und war damit der bindende
 * Skalierungsfaktor der Maschine: die Platte laeuft vor dem RAM voll.
 * runCleanup() hat ihn bis hier nie angefasst, er wuchs also mit jedem Deploy
 * monoton weiter. Die Groesse haengt an der Deploy-Haeufigkeit, nicht an der
 * Projektzahl — ein einzelnes aktives Projekt genuegt.
 *
 * `until=` statt `--all`: der Cache der letzten Tage ist genau der, der die
 * naechsten Builds schnell macht. Ihn mitzuloeschen liesse jeden Deploy nach
 * einem Cleanup einmal voll durchbauen — bei 10 Minuten hartem Build-Timeout
 * (nixpacks.ts) ist das ein realer Fehlschlagsgrund, nicht nur eine
 * Verzoegerung.
 *
 * Erfasst wird der Default-Builder, der laut Messung den Cache haelt. Nutzt
 * nixpacks eine eigene buildx-Instanz mit eigenem State-Volume, braeuchte die
 * ein separates `docker buildx prune --builder <name>`; nach derselben Messung
 * haelt sie aber nur einen Bruchteil (7,7 MiB gegen 796 MiB).
 */
const BUILD_CACHE_KEEP_HOURS = Number(process.env.BUILD_CACHE_KEEP_HOURS || 168);
const BUILD_CACHE_PRUNE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * "Total reclaimed space: 55.76GB" -> Bytes. Docker rechnet dezimal
 * (go-units HumanSize), kB/MB/GB sind also 10^3/10^6/10^9 und nicht 2^10 ff.
 * Exportiert, weil das Parsen fremder Ausgabe die einzige echte Logik hier ist
 * und ohne laufenden Docker-Daemon pruefbar sein soll.
 */
export function parseReclaimedBytes(stdout: string): number {
  const m = /Total reclaimed space:\s*([\d.]+)\s*([a-zA-Z]*)/.exec(stdout);
  if (!m) return 0;
  const factors: Record<string, number> = {
    b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15,
  };
  return Math.round(Number(m[1]) * (factors[m[2].toLowerCase()] ?? 1));
}

export async function pruneBuildCache(): Promise<{ freedBytes: number; errors: string[] }> {
  const errors: string[] = [];
  try {
    const { stdout } = await execFileP(
      'docker',
      ['builder', 'prune', '--force', '--filter', `until=${BUILD_CACHE_KEEP_HOURS}h`],
      { maxBuffer: 8 * 1024 * 1024, timeout: BUILD_CACHE_PRUNE_TIMEOUT_MS }
    );
    return { freedBytes: parseReclaimedBytes(stdout), errors };
  } catch (e: any) {
    // Wie ueberall in diesem Modul: ein fehlgeschlagener Teilschritt darf den
    // restlichen Cleanup nicht abbrechen. Erwartbarer Sonderfall ist ein
    // docker-socket-proxy ohne BUILD=1 — dann kommt hier ein 403 an, und der
    // Fehler gehoert sichtbar ins Audit-Log statt in eine stille Ausnahme.
    errors.push(`docker builder prune: ${e.message}`);
    return { freedBytes: 0, errors };
  }
}

/**
 * Analytics-Retention. Drei unterschiedliche Fristen, weil die drei Tabellen
 * unterschiedlich schnell wachsen und unterschiedlich lange interessant sind:
 *
 *  - analytics_visitors: eine Zeile pro Besucher UND Tag UND Domain, mit
 *    Abstand die groesste Tabelle. Die Tages-Uniques stehen nach dem Ingest
 *    ohnehin als Zahl in analytics_daily — die Hashes selbst braucht danach
 *    niemand mehr. Kurze Frist, auch aus Datenschutzgruenden.
 *  - analytics_page_views / _referrers: pro Pfad bzw. Herkunft und Tag.
 *  - analytics_daily: eine Zeile pro Domain und Tag. Bleibt lange, das ist der
 *    Jahresvergleich und kostet fast nichts.
 */
const ANALYTICS_VISITOR_RETENTION_DAYS = Number(process.env.ANALYTICS_VISITOR_RETENTION_DAYS || 90);
const ANALYTICS_DETAIL_RETENTION_DAYS = Number(process.env.ANALYTICS_DETAIL_RETENTION_DAYS || 180);
const ANALYTICS_DAILY_RETENTION_DAYS = Number(process.env.ANALYTICS_DAILY_RETENTION_DAYS || 730);

export async function pruneAnalytics(): Promise<{ deleted: Record<string, number>; errors: string[] }> {
  const deleted: Record<string, number> = {};
  const errors: string[] = [];
  const db = adminClient();
  await db.connect();
  try {
    const targets: [string, string, number][] = [
      ['analytics_visitors', 'visitors', ANALYTICS_VISITOR_RETENTION_DAYS],
      ['analytics_page_views', 'pageViews', ANALYTICS_DETAIL_RETENTION_DAYS],
      ['analytics_referrers', 'referrers', ANALYTICS_DETAIL_RETENTION_DAYS],
      ['analytics_daily', 'daily', ANALYTICS_DAILY_RETENTION_DAYS],
    ];
    for (const [table, key, days] of targets) {
      try {
        // Tabellenname kommt aus dieser Konstante, nie aus einem Request —
        // trotzdem keine Interpolation von Nutzereingaben (CLAUDE.md § 2.3).
        const { rowCount } = await db.query(
          `DELETE FROM ${table} WHERE day < (CURRENT_DATE - $1::int)`,
          [days]
        );
        deleted[key] = rowCount || 0;
      } catch (e: any) {
        // Migration 20 noch nicht gelaufen: kein Grund, den ganzen Cleanup
        // abzubrechen.
        errors.push(`${table}: ${e.message}`);
      }
    }
  } finally {
    await db.end();
  }
  return { deleted, errors };
}

export interface CleanupResult {
  snapshots: { removed: string[]; freedBytes: number; errors: string[] };
  images: { removed: string[]; errors: string[] };
  buildCache: { freedBytes: number; errors: string[] };
  analytics: { deleted: Record<string, number>; errors: string[] };
}

/**
 * Kompletter Aufraeum-Durchlauf, taeglich per Timer aus index.ts sowie manuell
 * ueber POST /cleanup/run. Ergebnis geht immer ins Audit-Log, auch bei
 * Teilfehlern (die einzelnen errors-Arrays landen mit).
 */
export async function runCleanup(): Promise<CleanupResult> {
  const snapshots = await pruneOldBuildSnapshots();
  const images = await pruneOldDockerImages();
  const buildCache = await pruneBuildCache();
  const analytics = await pruneAnalytics();
  await logAudit('cleanup.run', null, {
    snapshotsRemoved: snapshots.removed.length,
    freedBytes: snapshots.freedBytes,
    imagesRemoved: images.removed.length,
    buildCacheFreedBytes: buildCache.freedBytes,
    analyticsDeleted: analytics.deleted,
    errors: [...snapshots.errors, ...images.errors, ...buildCache.errors, ...analytics.errors],
  });
  return { snapshots, images, buildCache, analytics };
}

export async function getDiskUsage(): Promise<{ totalBytes: number; usedBytes: number; availableBytes: number; usedPercent: number } | null> {
  try {
    const { stdout } = await execFileP('df', ['-B1', '/opt']);
    const line = stdout.trim().split('\n')[1];
    const parts = line.split(/\s+/);
    const totalBytes = Number(parts[1]);
    const usedBytes = Number(parts[2]);
    const availableBytes = Number(parts[3]);
    const usedPercent = Math.round((usedBytes / totalBytes) * 1000) / 10;
    return { totalBytes, usedBytes, availableBytes, usedPercent };
  } catch (e: any) {
    console.error('df fehlgeschlagen:', e.message);
    return null;
  }
}
