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
  return new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
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

      const { rows: recentDeploys } = await db.query(
        `SELECT image_tag FROM deployments
         WHERE project_id = $1 AND image_tag IS NOT NULL
         ORDER BY created_at DESC LIMIT 5`,
        [project.id]
      );
      const keepTags = new Set(recentDeploys.map((d) => d.image_tag));

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

export interface CleanupResult {
  snapshots: { removed: string[]; freedBytes: number; errors: string[] };
  images: { removed: string[]; errors: string[] };
}

/**
 * Kompletter Aufraeum-Durchlauf, taeglich per Timer aus index.ts sowie manuell
 * ueber POST /cleanup/run. Ergebnis geht immer ins Audit-Log, auch bei
 * Teilfehlern (die einzelnen errors-Arrays landen mit).
 */
export async function runCleanup(): Promise<CleanupResult> {
  const snapshots = await pruneOldBuildSnapshots();
  const images = await pruneOldDockerImages();
  await logAudit('cleanup.run', null, {
    snapshotsRemoved: snapshots.removed.length,
    freedBytes: snapshots.freedBytes,
    imagesRemoved: images.removed.length,
    errors: [...snapshots.errors, ...images.errors],
  });
  return { snapshots, images };
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
