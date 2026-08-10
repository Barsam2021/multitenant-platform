#!/usr/bin/env bash
# Sprint 20 — P3-6: Unbegrenztes Wachstum auf der Platte
# Auf der VPS ausführen: /opt/multitenant-platform
#
# Was passiert:
#   - Neu lib/cleanup.ts:
#       * pruneOldBuildSnapshots() - loescht deployments/builds/<slug>/<sha>/
#         ausser den letzten 3 Deployments je Projekt (repo-Checkout bleibt
#         immer erhalten)
#       * pruneOldDockerImages() - entfernt app-<slug>:<sha>-Images ausser den
#         letzten 5 Deployments je Projekt. docker rmi schlaegt fehl (und wird
#         ignoriert), wenn ein Image noch von einem laufenden Container
#         benutzt wird - das aktive Image ist damit automatisch geschuetzt
#       * truncateBuildLog() - Logs ueber 1MB werden gekuerzt (Anfang+Ende
#         behalten, Mitte ersetzt), automatisch fuer JEDEN
#         updateDeployment()-Aufruf in deploy.ts wirksam
#       * getDiskUsage() - df auf /opt
#       * runCleanup() - beides zusammen, Ergebnis geht ins Audit-Log
#   - Neu routes/cleanup.ts: POST /cleanup/run (manueller Trigger)
#   - routes/stats.ts: neu GET /stats/disk
#   - index.ts: taeglicher Timer (erster Lauf nach 5 Minuten, danach alle 24h)
#   - Dashboard: neue Routen /api/cleanup/run, /api/stats/disk
#   - Übersichtsseite (P1-8): Plattenbelegungs-Balken mit Warnung ab 80%,
#     "Jetzt aufräumen"-Button
#   - Rebuild + Neustart von Dashboard UND Provisioning-Agent
#
# Rollback: ./sprint20-p3-6-disk-cleanup.sh --rollback _backup-sprint20-<timestamp>

set -euo pipefail

PLATFORM_DIR="/opt/multitenant-platform"
DASHBOARD_SRC="$PLATFORM_DIR/dashboard/src"
AGENT_SRC="$PLATFORM_DIR/provisioning-agent/src"
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$PLATFORM_DIR/_backup-sprint20-$TS"

FILES=(
  "provisioning-agent/src/lib/git.ts"
  "provisioning-agent/src/lib/deploy.ts"
  "provisioning-agent/src/routes/stats.ts"
  "provisioning-agent/src/index.ts"
  "dashboard/src/app/dashboard/page.tsx"
)
NEW_FILES=(
  "provisioning-agent/src/lib/cleanup.ts"
  "provisioning-agent/src/routes/cleanup.ts"
  "dashboard/src/app/api/cleanup/run/route.ts"
  "dashboard/src/app/api/stats/disk/route.ts"
)

if [[ "${1:-}" == "--rollback" ]]; then
  RESTORE_FROM="${2:?Verzeichnis angeben: ./sprint20-p3-6-disk-cleanup.sh --rollback _backup-sprint20-XXXXXXXX-XXXXXX}"
  cd "$PLATFORM_DIR"
  echo "Rollback aus $RESTORE_FROM ..."
  for f in "${FILES[@]}"; do
    if [[ -f "$RESTORE_FROM/$f" ]]; then
      mkdir -p "$(dirname "$f")"
      cp "$RESTORE_FROM/$f" "$f"
      echo "  restored: $f"
    fi
  done
  for f in "${NEW_FILES[@]}"; do
    rm -f "$f"
    echo "  removed (war neu in Sprint 20): $f"
  done
  find "$PLATFORM_DIR/dashboard/src/app/api/cleanup" -type d -empty -delete 2>/dev/null || true
  find "$PLATFORM_DIR/dashboard/src/app/api/stats" -type d -empty -delete 2>/dev/null || true
  echo "Rebuild..."
  cd "$PLATFORM_DIR/provisioning-agent" && docker compose --env-file ../.env build && docker compose --env-file ../.env up -d
  cd "$PLATFORM_DIR/dashboard" && docker compose --env-file ../.env build && docker compose --env-file ../.env up -d
  echo "Rollback abgeschlossen."
  exit 0
fi

echo "== Sprint 20 (P3-6): Backup nach $BACKUP_DIR =="
cd "$PLATFORM_DIR"
mkdir -p "$BACKUP_DIR"
for f in "${FILES[@]}"; do
  if [[ -f "$f" ]]; then
    mkdir -p "$BACKUP_DIR/$(dirname "$f")"
    cp "$f" "$BACKUP_DIR/$f"
  fi
done
echo "Backup fertig."

echo "== Geaenderte/neue Dateien schreiben =="

mkdir -p "$(dirname "$AGENT_SRC/lib/cleanup.ts")"
cat > "$AGENT_SRC/lib/cleanup.ts" << 'CLEANUP_TS_EOF'
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
CLEANUP_TS_EOF

mkdir -p "$(dirname "$AGENT_SRC/routes/cleanup.ts")"
cat > "$AGENT_SRC/routes/cleanup.ts" << 'CLEANUPROUTE_TS_EOF'
import { Router } from 'express';
import { runCleanup } from '../lib/cleanup';

export const cleanupRouter = Router();

// POST /cleanup/run — manueller Trigger (die eigentliche Ausfuehrung laeuft
// sonst taeglich per Timer, siehe index.ts). Antwortet erst nach Abschluss,
// nicht fire-and-forget wie ein Deploy - ein Aufraeum-Lauf dauert typischerweise
// Sekunden, nicht Minuten (kein Grund fuer Polling-Infrastruktur dafuer).
cleanupRouter.post('/cleanup/run', async (_req, res) => {
  try {
    const result = await runCleanup();
    res.json({ status: 'ok', ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
CLEANUPROUTE_TS_EOF

mkdir -p "$(dirname "$AGENT_SRC/lib/git.ts")"
cat > "$AGENT_SRC/lib/git.ts" << 'GIT_TS_EOF'
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';

const execFileP = promisify(execFile);

export const BUILDS_ROOT = '/opt/multitenant-platform/deployments/builds';
const GITHUB_PAT = process.env.GITHUB_PAT;
const ASKPASS_SCRIPT = '/app/scripts/git-askpass.sh';

/**
 * Env für git-Aufrufe gegen private GitHub-Repos: PAT wird NIE in die Repo-URL oder
 * argv geschrieben (execFile hängt bei Fehlschlägen die vollen Argumente an
 * error.message — landet sonst im Klartext in der Dashboard-Fehleranzeige, siehe
 * routes/deployments.ts). Stattdessen über GIT_ASKPASS + Umgebungsvariable, die nur
 * dem Kindprozess sichtbar ist.
 */
function gitEnv(repoUrl: string): NodeJS.ProcessEnv {
  if (!GITHUB_PAT || !/^https:\/\/github\.com\//.test(repoUrl)) return process.env;
  return {
    ...process.env,
    GIT_ASKPASS: ASKPASS_SCRIPT,
    GIT_ASKPASS_TOKEN: GITHUB_PAT,
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * Klont (oder pullt, falls bereits vorhanden) ein Repo für ein Projekt und checkt
 * den angeforderten Commit/Branch aus. Gibt den lokalen Pfad + aufgelösten commit_sha zurück.
 *
 * Nutzt ausschließlich execFile mit Argument-Arrays — keine Shell-String-Konkatenation
 * (repo_url kommt aus der DB, ist aber trotzdem nie Teil eines Shell-Strings, siehe CLAUDE.md § 1.1).
 */
export async function checkoutRepo(
  projectSlug: string,
  repoUrl: string,
  ref: string, // Branch-Name oder Commit-SHA
  signal?: AbortSignal // P2-4: erlaubt Abbruch eines laufenden Deploys waehrend git-Operationen
): Promise<{ path: string; resolvedSha: string; commitMessage: string }> {
  if (!/^[a-z0-9-]+$/.test(projectSlug)) {
    throw new Error('invalid project slug for git checkout');
  }

  const repoDir = `${BUILDS_ROOT}/${projectSlug}/repo`;
  const env = gitEnv(repoUrl);

  // .git prüfen statt nur den Ordner — ein Leftover von einem fehlgeschlagenen
  // Clone-Versuch (z.B. Auth-Fehler vor diesem Fix) legt zwar den Ordner an,
  // aber ohne funktionierendes Repo drin. 'fetch' darauf schlägt dann mit
  // irreführenden Fehlern fehl statt mit "not a git repository".
  if (!existsSync(`${repoDir}/.git`)) {
    await execFileP('rm', ['-rf', repoDir]);
    await execFileP('mkdir', ['-p', repoDir]);
    await execFileP('git', ['clone', '--no-single-branch', repoUrl, repoDir], { env, signal });
  } else {
    await execFileP('git', ['-C', repoDir, 'fetch', '--all', '--prune'], { env, signal });
  }

  // ref kann Branch oder SHA sein — 'git checkout' handhabt beides.
  await execFileP('git', ['-C', repoDir, 'checkout', ref], { signal });
  // Falls ref ein Branch war: auf neuesten Remote-Stand ziehen.
  await execFileP('git', ['-C', repoDir, 'reset', '--hard', `origin/${ref}`], { signal }).catch(() => {
    // Kein Remote-Branch dieses Namens (z.B. weil ref bereits ein SHA war) — ignorieren.
  });

  const { stdout } = await execFileP('git', ['-C', repoDir, 'rev-parse', 'HEAD']);
  const resolvedSha = stdout.trim();

  // P2-4: Commit-Message fuer die Deployment-Historie - Betreffzeile reicht,
  // der volle Body wuerde die Liste unleserlich machen.
  const { stdout: msgOut } = await execFileP('git', ['-C', repoDir, 'log', '-1', '--format=%s', resolvedSha]).catch(
    () => ({ stdout: '' })
  );
  const commitMessage = msgOut.trim();

  // Isolierter Build-Snapshot pro Commit, damit parallele Deploys sich nicht in die Quere kommen.
  const commitDir = `${BUILDS_ROOT}/${projectSlug}/${resolvedSha.slice(0, 12)}`;
  await execFileP('rm', ['-rf', commitDir]);
  await execFileP('cp', ['-r', repoDir, commitDir]);

  return { path: commitDir, resolvedSha, commitMessage };
}

/**
 * Verifiziert eine GitHub-Webhook-Signatur (X-Hub-Signature-256, HMAC-SHA256).
 * Timing-safe Vergleich, verhindert Timing-Angriffe auf die Signaturpruefung.
 */
export function verifyGithubSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const crypto = require('crypto');
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
GIT_TS_EOF

mkdir -p "$(dirname "$AGENT_SRC/lib/deploy.ts")"
cat > "$AGENT_SRC/lib/deploy.ts" << 'DEPLOY_TS_EOF'
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Client as PGClient } from 'pg';
import { checkoutRepo } from './git';
import { nixpacksBuild } from './nixpacks';
import { buildEnvVars } from './secrets';
import { maskSecrets } from './crypto';
import { detectBuildErrorHint } from './buildErrorHints';
import { truncateBuildLog } from './cleanup';

const execFileP = promisify(execFile);

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

function adminClient(): PGClient {
  return new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
}

const TARIFF_LIMITS: Record<string, { mem: string; cpus: string }> = {
  starter: { mem: '256m', cpus: '0.5' },
  business: { mem: '512m', cpus: '1' },
  premium: { mem: '1g', cpus: '2' },
};

// P2-4: In-Process-Tracking laufender Deploys fuer Abbruch. Ueberlebt keinen
// Agent-Neustart (bewusst - siehe cancelDeployment() fuer den verwaisten Fall,
// den die Route separat behandelt). pastPointOfNoReturn schuetzt davor, dass ein
// Abbruch mitten im Traffic-Switch (altes Container schon umbenannt) live geht.
interface ActiveDeployState {
  abort: AbortController;
  containerName?: string;
  pastPointOfNoReturn: boolean;
}
const activeDeployments = new Map<string, ActiveDeployState>();

class DeploymentCancelledError extends Error {
  constructor() {
    super('deployment cancelled');
    this.name = 'DeploymentCancelledError';
  }
}

export function cancelDeployment(deploymentId: string): { ok: boolean; reason?: string; containerName?: string } {
  const state = activeDeployments.get(deploymentId);
  if (!state) return { ok: false, reason: 'kein aktiver Prozess fuer dieses Deployment im Agent gefunden' };
  if (state.pastPointOfNoReturn) {
    return { ok: false, reason: 'Deployment schaltet bereits Live-Traffic um - kann nicht mehr abgebrochen werden' };
  }
  state.abort.abort();
  return { ok: true, containerName: state.containerName };
}

export interface Project {
  id: string;
  tenant_slug: string;
  slug: string;
  repo_url: string;
  default_branch: string;
  build_command: string | null;
  active_container: string | null;
  preview_hostname: string;
  // P1-3: frueher ueberall hart 3000 — Apps auf 4173/8000/8080 konnten nie
  // deployen und der Healthcheck lief kommentarlos ins Leere.
  app_port: number | null;
  health_path: string | null;
}

async function updateDeployment(
  db: PGClient,
  deploymentId: string,
  fields: {
    status?: string;
    build_log?: string;
    container_name?: string;
    image_tag?: string;
    finished_at?: boolean;
    commit_message?: string;
  }
) {
  const sets: string[] = [];
  const vals: any[] = [];
  let i = 1;
  if (fields.status !== undefined) { sets.push(`status = $${i++}`); vals.push(fields.status); }
  if (fields.build_log !== undefined) { sets.push(`build_log = $${i++}`); vals.push(truncateBuildLog(fields.build_log)); }
  if (fields.container_name !== undefined) { sets.push(`container_name = $${i++}`); vals.push(fields.container_name); }
  if (fields.image_tag !== undefined) { sets.push(`image_tag = $${i++}`); vals.push(fields.image_tag); }
  if (fields.commit_message !== undefined) { sets.push(`commit_message = $${i++}`); vals.push(fields.commit_message); }
  if (fields.finished_at) { sets.push(`finished_at = now()`); }
  vals.push(deploymentId);
  await db.query(`UPDATE deployments SET ${sets.join(', ')} WHERE id = $${i}`, vals);
}

/**
 * Prüft Health eines internen Containers via HTTP-Request von innerhalb des
 * Provisioning-Agent-Containers (der selbst auf traefik-net hängt) — kein curl/wget
 * im Zielcontainer nötig, kein Shell-Exec, reines Node `fetch`.
 */
async function pollHealthcheck(
  containerName: string,
  port: number,
  timeoutMs = 60_000,
  path = '/',
  signal?: AbortSignal
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DeploymentCancelledError();
    try {
      const res = await fetch(`http://${containerName}:${port}${path}`, { signal: AbortSignal.timeout(3000) });
      if (res.status < 500) return true;
    } catch {
      // Container noch nicht bereit — weiter pollen.
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Voller Deploy-Flow für ein Projekt (Checkout → Build → Blue-Green-Swap, siehe Kommentare unten).
 * Läuft asynchron im Hintergrund; der aufrufende Endpoint gibt sofort die deploymentId zurück
 * und der Status wird über GET /deployments/:projectId pollbar aktualisiert.
 */
export async function runDeployment(
  project: Project,
  ref: string,
  triggeredBy: 'webhook' | 'manual' | 'api',
  tariff: string,
  deploymentId: string
): Promise<void> {
  const db = adminClient();
  await db.connect();
  let buildLog = '';
  const appPort = project.app_port || 3000;
  const healthPath = project.health_path || '/';

  const state: ActiveDeployState = { abort: new AbortController(), pastPointOfNoReturn: false };
  activeDeployments.set(deploymentId, state);
  const signal = state.abort.signal;
  const checkCancelled = () => {
    if (signal.aborted) throw new DeploymentCancelledError();
  };

  try {
    await updateDeployment(db, deploymentId, { status: 'building' });

    // 1. Repo auschecken
    const { path: buildPath, resolvedSha, commitMessage } = await checkoutRepo(
      project.slug,
      project.repo_url,
      ref,
      signal
    );
    buildLog += `Checked out ${resolvedSha} for ${project.slug}\n`;
    await db.query('UPDATE deployments SET commit_sha = $1, commit_message = $2 WHERE id = $3', [
      resolvedSha,
      commitMessage || null,
      deploymentId,
    ]);
    checkCancelled();

    // 2. Env-Vars sammeln (Tenant-Secrets + manuelle project_env_vars, Auto-Injection) —
    //    VOR dem Build, damit sie auch nixpacksBuild zur Verfügung stehen (siehe dort).
    const envVars = await buildEnvVars(project.tenant_slug, project.id);
    const envArgs = Object.entries(envVars).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

    // 3. Nixpacks-Build
    const imageTag = `app-${project.slug}:${resolvedSha.slice(0, 12)}`;
    const buildResult = await nixpacksBuild(buildPath, imageTag, project.build_command || undefined, envVars, signal);
    buildLog += buildResult.log;
    await updateDeployment(db, deploymentId, { build_log: buildLog, image_tag: imageTag });
    checkCancelled();

    // 4. Neuen Container starten (interner Name, noch ohne öffentliche Traefik-Labels)
    const limits = TARIFF_LIMITS[tariff] || TARIFF_LIMITS.starter;
    const newContainerName = `app-${project.slug}-${resolvedSha.slice(0, 8)}`;
    await execFileP('docker', ['rm', '-f', newContainerName]).catch(() => {});
    await execFileP('docker', [
      'run', '-d',
      '--name', newContainerName,
      '--network', 'traefik-net',
      `--memory=${limits.mem}`,
      `--cpus=${limits.cpus}`,
      ...envArgs,
      imageTag,
    ]);
    state.containerName = newContainerName;
    buildLog += `Started candidate container ${newContainerName}\n`;
    await updateDeployment(db, deploymentId, { status: 'healthchecking', build_log: maskSecrets(buildLog), container_name: newContainerName });

    // 5. Healthcheck gegen den neuen Container (intern, noch kein Traffic)
    const healthy = await pollHealthcheck(newContainerName, appPort, 60_000, healthPath, signal);
    if (!healthy) {
      buildLog += `Healthcheck FAILED for ${newContainerName} auf Port ${appPort}${healthPath} — rolling back, old container bleibt aktiv.\n`;
      buildLog += `Hinweis: Antwortet die App auf einem anderen Port? Port und Healthcheck-Pfad sind pro Projekt einstellbar.\n`;
      // Logs VOR dem Löschen sichern — sonst ist der Container weg, bevor man
      // nachschauen kann, warum er nicht healthy wurde (Crash beim Start, fehlende
      // Env-Vars etc.).
      const candidateLogs = await execFileP('docker', ['logs', '--tail', '100', newContainerName]).catch((e: any) => ({
        stdout: '', stderr: e.stderr || e.message,
      }));
      buildLog += `--- Container-Logs (letzte 100 Zeilen) ---\n${candidateLogs.stdout}\n${candidateLogs.stderr}\n`;
      await execFileP('docker', ['rm', '-f', newContainerName]).catch(() => {});
      await updateDeployment(db, deploymentId, { status: 'failed', build_log: maskSecrets(buildLog), finished_at: true });
      return;
    }
    buildLog += `Healthcheck OK\n`;

    // Letzter Cancel-Check vor dem Point of no Return: ab hier wird der oeffentliche
    // Container angefasst, ein Abbruch waere ab jetzt riskanter als ihn durchlaufen
    // zu lassen (haette sonst potenziell keinen laufenden Container mehr zur Folge).
    checkCancelled();
    state.pastPointOfNoReturn = true;

    // 6. Traffic umschalten: neuen Container mit öffentlichem Namen + Traefik-Labels final starten,
    //    alten Container beiseiteschieben (nicht sofort löschen — Rollback-Fallback).
    const publicName = `app-${project.slug}`;
    const oldBackupName = `${publicName}-old-${Date.now()}`;

    const { stdout: existing } = await execFileP('docker', ['ps', '-aq', '--filter', `name=^/${publicName}$`]);
    const hadPrevious = existing.trim().length > 0;
    if (hadPrevious) {
      await execFileP('docker', ['rename', publicName, oldBackupName]);
      await execFileP('docker', ['stop', oldBackupName]).catch(() => {});
    }

    // Candidate-Container droppen und mit finalem Namen + Labels neu starten
    // (Docker erlaubt kein nachträgliches Hinzufügen von Labels zu einem laufenden Container).
    await execFileP('docker', ['rm', '-f', newContainerName]).catch(() => {});
    await execFileP('docker', [
      'run', '-d',
      '--name', publicName,
      '--network', 'traefik-net',
      `--memory=${limits.mem}`,
      `--cpus=${limits.cpus}`,
      '--label', 'traefik.enable=true',
      '--label', `traefik.http.routers.${project.slug}-app.rule=Host(\`${project.preview_hostname}\`)`,
      '--label', `traefik.http.routers.${project.slug}-app.entrypoints=websecure`,
      '--label', `traefik.http.routers.${project.slug}-app.tls.certresolver=myresolver`,
      '--label', `traefik.http.services.${project.slug}-app.loadbalancer.server.port=${appPort}`,
      ...envArgs,
      imageTag,
    ]);

    const finalHealthy = await pollHealthcheck(publicName, appPort, 30_000, healthPath);
    if (!finalHealthy) {
      // Rollback: finalen Container entfernen, alten wiederherstellen
      buildLog += `Final container failed post-swap healthcheck — rolling back to previous container.\n`;
      const finalLogs = await execFileP('docker', ['logs', '--tail', '100', publicName]).catch((e: any) => ({
        stdout: '', stderr: e.stderr || e.message,
      }));
      buildLog += `--- Container-Logs (letzte 100 Zeilen) ---\n${finalLogs.stdout}\n${finalLogs.stderr}\n`;
      await execFileP('docker', ['rm', '-f', publicName]).catch(() => {});
      if (hadPrevious) {
        await execFileP('docker', ['rename', oldBackupName, publicName]);
        await execFileP('docker', ['start', publicName]);
      }
      await updateDeployment(db, deploymentId, { status: 'failed', build_log: maskSecrets(buildLog), finished_at: true });
      return;
    }

    // 7. Alten Container endgültig entfernen
    if (hadPrevious) {
      await execFileP('docker', ['rm', '-f', oldBackupName]).catch(() => {});
    }
    buildLog += `Deployed ${publicName} (${imageTag}) — live traffic switched.\n`;

    await db.query('UPDATE projects SET active_container = $1, active_deployment_id = $2 WHERE id = $3', [
      publicName, deploymentId, project.id,
    ]);
    await updateDeployment(db, deploymentId, { status: 'deployed', build_log: maskSecrets(buildLog), container_name: publicName, finished_at: true });
  } catch (err: any) {
    const cancelled = err instanceof DeploymentCancelledError || err?.name === 'AbortError';
    if (cancelled) {
      buildLog += `\n[cancel] Deployment abgebrochen.\n`;
      // Kandidat-Container war noch nicht live geschaltet (sonst haette
      // pastPointOfNoReturn den Abbruch verhindert) - gefahrlos entfernbar.
      if (state.containerName) {
        await execFileP('docker', ['rm', '-f', state.containerName]).catch(() => {});
        buildLog += `Kandidat-Container ${state.containerName} entfernt.\n`;
      }
      await updateDeployment(db, deploymentId, { status: 'cancelled', build_log: maskSecrets(buildLog), finished_at: true }).catch(() => {});
    } else {
      buildLog += `\nError: ${err.buildLog || err.message}`;
      const hint = detectBuildErrorHint(buildLog);
      if (hint) buildLog = `⚠️ ${hint}\n${'─'.repeat(60)}\n${buildLog}`;
      await updateDeployment(db, deploymentId, { status: 'failed', build_log: maskSecrets(buildLog), finished_at: true }).catch(() => {});
    }
  } finally {
    activeDeployments.delete(deploymentId);
    await db.end();
  }
}

/**
 * Rollback: letzten erfolgreichen Deployment-Eintrag (vor dem aktuellen) erneut ausrollen,
 * ohne neu zu bauen — Image ist lokal noch getaggt (siehe § 4, "Images bleiben lokal getaggt").
 */
export async function rollbackToDeployment(project: Project, targetDeploymentId: string, tariff: string): Promise<void> {
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query('SELECT * FROM deployments WHERE id = $1 AND project_id = $2', [targetDeploymentId, project.id]);
    if (rows.length === 0) throw new Error('deployment not found');
    const target = rows[0];
    if (!target.image_tag) throw new Error('target deployment has no image_tag — cannot roll back');

    const limits = TARIFF_LIMITS[tariff] || TARIFF_LIMITS.starter;
    const envVars = await buildEnvVars(project.tenant_slug, project.id);
    const envArgs = Object.entries(envVars).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const publicName = `app-${project.slug}`;
    const appPort = project.app_port || 3000;

    await execFileP('docker', ['rm', '-f', publicName]).catch(() => {});
    await execFileP('docker', [
      'run', '-d',
      '--name', publicName,
      '--network', 'traefik-net',
      `--memory=${limits.mem}`,
      `--cpus=${limits.cpus}`,
      '--label', 'traefik.enable=true',
      '--label', `traefik.http.routers.${project.slug}-app.rule=Host(\`${project.preview_hostname}\`)`,
      '--label', `traefik.http.routers.${project.slug}-app.entrypoints=websecure`,
      '--label', `traefik.http.routers.${project.slug}-app.tls.certresolver=myresolver`,
      '--label', `traefik.http.services.${project.slug}-app.loadbalancer.server.port=${appPort}`,
      ...envArgs,
      target.image_tag,
    ]);

    await db.query('UPDATE projects SET active_container = $1, active_deployment_id = $2 WHERE id = $3', [publicName, targetDeploymentId, project.id]);
    await db.query(
      `INSERT INTO deployments (project_id, commit_sha, commit_message, status, container_name, image_tag, triggered_by, finished_at)
       VALUES ($1, $2, $3, 'rolled_back', $4, $5, 'api', now())`,
      [project.id, target.commit_sha, target.commit_message, publicName, target.image_tag]
    );
  } finally {
    await db.end();
  }
}
DEPLOY_TS_EOF

mkdir -p "$(dirname "$AGENT_SRC/routes/stats.ts")"
cat > "$AGENT_SRC/routes/stats.ts" << 'STATS_TS_EOF'
import { Router } from 'express';
import { Client as PGClient } from 'pg';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getDiskUsage } from '../lib/cleanup';

const execFileP = promisify(execFile);
const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN || 'example.com';

function adminClient(): PGClient {
  return new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
}

interface DockerStatsLine {
  Name: string;
  CPUPerc: string;
  MemUsage: string;
  MemPerc: string;
}

async function readDockerStats(): Promise<Record<string, DockerStatsLine>> {
  const out: Record<string, DockerStatsLine> = {};
  try {
    const { stdout } = await execFileP('docker', ['stats', '--no-stream', '--format', '{{json .}}']);
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const c = JSON.parse(line) as DockerStatsLine;
      out[c.Name] = c;
    }
  } catch (e: any) {
    console.error('docker stats fehlgeschlagen:', e.message);
  }
  return out;
}

export const statsRouter = Router();

// GET /stats/disk — P3-6: Plattenbelegung fuer die Uebersichtsseite. Getrennt
// von /stats/overview, damit ein df-Aufruf nicht jeden Overview-Request
// mitbremst - die Uebersichtsseite ruft beide parallel ab.
statsRouter.get('/stats/disk', async (_req, res) => {
  const disk = await getDiskUsage();
  if (!disk) return res.status(500).json({ error: 'df fehlgeschlagen' });
  res.json(disk);
});

// GET /stats — rohe docker-stats + DB-Connections. Unveraendertes Verhalten,
// nur aus index.ts hierher verschoben (siehe /stats/overview fuer die
// aggregierte, tatsaechlich im Dashboard nutzbare Variante, P1-8).
statsRouter.get('/stats', async (_req, res) => {
  try {
    const { stdout } = await execFileP('docker', ['stats', '--no-stream', '--format', '{{json .}}']);
    const containers = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

    const master = new PGClient({
      connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/postgres`,
    });
    await master.connect();
    const { rows: dbConnections } = await master.query(
      "SELECT datname, count(*) AS connections FROM pg_stat_activity WHERE datname LIKE 'kunde_%' GROUP BY datname"
    );
    await master.end();

    res.json({ containers, dbConnections });
  } catch (err: any) {
    console.error('Stats fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /stats/overview — P1-8: die eigentliche Plattform-Uebersicht, die es bisher
// nicht gab — /stats existierte zwar, wurde aber nie vom Dashboard abgerufen und
// liefert ohnehin nur rohe, nicht auf Projekte gemappte Container-Daten. kuma_monitor_id
// wurde bisher geschrieben, nie gelesen — hier fliesst sie als Deep-Link in Uptime
// Kuma (oeffentlich erreichbar, siehe monitoring/uptime-kuma/docker-compose.yml) ein,
// statt selbst fragil den Kuma-Socket fuer Live-Status abzufragen.
statsRouter.get('/stats/overview', async (_req, res) => {
  const db = adminClient();
  await db.connect();
  try {
    const containerStats = await readDockerStats();

    const { rows: projects } = await db.query(
      `SELECT p.id, p.slug, p.tenant_slug, p.active_container, p.kuma_monitor_id, k.tariff
       FROM projects p JOIN kunden k ON k.slug = p.tenant_slug
       ORDER BY p.created_at DESC`
    );

    const { rows: lastDeployments } = await db.query(
      `SELECT DISTINCT ON (project_id) project_id, status, finished_at, created_at
       FROM deployments ORDER BY project_id, created_at DESC`
    );
    const lastDeployByProject = new Map(lastDeployments.map((d) => [d.project_id, d]));

    const { rows: domainCounts } = await db.query(
      `SELECT project_id, COALESCE(status, 'unknown') AS status, count(*) AS n FROM domains GROUP BY project_id, status`
    );
    const domainsByProject = new Map<string, Record<string, number>>();
    for (const row of domainCounts) {
      const m = domainsByProject.get(row.project_id) || {};
      m[row.status] = Number(row.n);
      domainsByProject.set(row.project_id, m);
    }

    // pg_stat_activity ist clusterweit sichtbar — kein zweiter Connect auf die
    // 'postgres'-DB noetig, anders als im alten /stats-Handler oben.
    const { rows: dbConnRows } = await db.query(
      "SELECT datname, count(*) AS connections FROM pg_stat_activity WHERE datname LIKE 'kunde_%' GROUP BY datname"
    );
    const dbConnByTenant = new Map(dbConnRows.map((r) => [String(r.datname).replace(/^kunde_/, ''), Number(r.connections)]));

    const kumaBaseUrl = `https://status-vps.${PLATFORM_DOMAIN}`;

    const projectStats = projects.map((p) => {
      const deploy = lastDeployByProject.get(p.id);
      const live = p.active_container ? containerStats[p.active_container] : undefined;
      return {
        id: p.id,
        slug: p.slug,
        tenantSlug: p.tenant_slug,
        tariff: p.tariff,
        activeContainer: p.active_container,
        cpuPerc: live?.CPUPerc ?? null,
        memUsage: live?.MemUsage ?? null,
        memPerc: live?.MemPerc ?? null,
        lastDeployment: deploy
          ? { status: deploy.status, finishedAt: deploy.finished_at, createdAt: deploy.created_at }
          : null,
        domains: domainsByProject.get(p.id) || {},
        dbConnections: dbConnByTenant.get(p.tenant_slug) ?? 0,
        kumaMonitorId: p.kuma_monitor_id,
        kumaUrl: p.kuma_monitor_id ? `${kumaBaseUrl}/dashboard/${p.kuma_monitor_id}` : null,
      };
    });

    const { rows: tenantCountRows } = await db.query('SELECT count(*) AS n FROM kunden');

    res.json({
      summary: {
        tenantCount: Number(tenantCountRows[0]?.n || 0),
        projectCount: projects.length,
        projectsRunning: projectStats.filter((p) => !!p.activeContainer).length,
        projectsFailedLastDeploy: projectStats.filter((p) => p.lastDeployment?.status === 'failed').length,
      },
      projects: projectStats,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});
STATS_TS_EOF

mkdir -p "$(dirname "$AGENT_SRC/index.ts")"
cat > "$AGENT_SRC/index.ts" << 'INDEX_TS_EOF'
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
import { cleanupRouter } from './routes/cleanup';
import { runCleanup } from './lib/cleanup';
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
app.use(cleanupRouter); // P3-6: /cleanup/run


app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(3001, () => {
  console.log('Provisioning Agent (mit Deployment Engine) listening on :3001');
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
});
INDEX_TS_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/app/api/cleanup/run/route.ts")"
cat > "$DASHBOARD_SRC/app/api/cleanup/run/route.ts" << 'CLEANUPAPI_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function POST() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { status, body } = await agentFetch("/cleanup/run", { method: "POST" });
  return NextResponse.json(body, { status });
}
CLEANUPAPI_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/app/api/stats/disk/route.ts")"
cat > "$DASHBOARD_SRC/app/api/stats/disk/route.ts" << 'DISKAPI_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { status, body } = await agentFetch("/stats/disk");
  return NextResponse.json(body, { status });
}
DISKAPI_EOF

mkdir -p "$(dirname "$DASHBOARD_SRC/app/dashboard/page.tsx")"
cat > "$DASHBOARD_SRC/app/dashboard/page.tsx" << 'OVERVIEWPAGE_EOF'
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Overview {
  summary: {
    tenantCount: number;
    projectCount: number;
    projectsRunning: number;
    projectsFailedLastDeploy: number;
  };
  projects: ProjectStat[];
}

interface ProjectStat {
  id: string;
  slug: string;
  tenantSlug: string;
  tariff: string;
  activeContainer: string | null;
  cpuPerc: string | null;
  memUsage: string | null;
  memPerc: string | null;
  lastDeployment: { status: string; finishedAt: string | null; createdAt: string } | null;
  domains: Record<string, number>;
  dbConnections: number;
  kumaMonitorId: number | null;
  kumaUrl: string | null;
}

interface DiskUsage {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${bytes} B`;
}

// Gleiche Konvention wie projects/[slug]/deployments/page.tsx.
const STATUS_COLOR: Record<string, string> = {
  queued: "var(--text-dim)",
  building: "var(--accent)",
  healthchecking: "var(--accent)",
  deployed: "#2da44e",
  failed: "var(--danger)",
  rolled_back: "var(--text-dim)",
  cancelled: "var(--text-dim)",
};

const DOMAIN_STATUS_LABEL: Record<string, string> = {
  live: "live",
  tls_pending: "TLS ausstehend",
  dns_ok: "DNS ok",
  pending_dns: "DNS ausstehend",
  failed: "fehlgeschlagen",
  unknown: "unbekannt",
};

function timeAgo(iso: string | null): string {
  if (!iso) return "–";
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

export default function PlatformOverviewPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [disk, setDisk] = useState<DiskUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupNote, setCleanupNote] = useState<string | null>(null);

  function load() {
    fetch("/api/stats/overview")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch(() => setError("Verbindung zum Provisioning Agent fehlgeschlagen"));
    // P3-6: eigener, leichtgewichtiger Request statt Teil von /stats/overview -
    // df blockiert diesen sonst mit.
    fetch("/api/stats/disk")
      .then((r) => r.json())
      .then((d) => !d.error && setDisk(d))
      .catch(() => {});
  }

  async function handleCleanupNow() {
    setCleaning(true);
    setCleanupNote(null);
    try {
      const res = await fetch("/api/cleanup/run", { method: "POST" });
      const d = await res.json();
      if (!res.ok) {
        setCleanupNote(d.error || "Aufräumen fehlgeschlagen");
        return;
      }
      setCleanupNote(
        `${d.snapshots?.removed?.length ?? 0} Build-Snapshots, ${d.images?.removed?.length ?? 0} Docker-Images entfernt (${formatBytes(d.snapshots?.freedBytes ?? 0)} freigegeben).`
      );
      load();
    } catch {
      setCleanupNote("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setCleaning(false);
    }
  }

  useEffect(() => {
    load();
    // P3-2: auch hier nur bei sichtbarem Tab weiterpollen.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  if (error) return <div className="content"><div className="error-box">{error}</div></div>;
  if (!data) return <div className="content"><div className="empty-state">Lade Übersicht…</div></div>;

  const { summary, projects } = data;

  return (
    <div className="content">
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Plattform-Übersicht</h2>
      </div>

      <div className="card-grid" style={{ marginBottom: 24 }}>
        <div className="card">
          <div className="card-sub">Kunden</div>
          <div style={{ fontSize: 26, fontWeight: 600 }}>{summary.tenantCount}</div>
        </div>
        <div className="card">
          <div className="card-sub">Projekte</div>
          <div style={{ fontSize: 26, fontWeight: 600 }}>{summary.projectCount}</div>
        </div>
        <div className="card">
          <div className="card-sub">Laufende Container</div>
          <div style={{ fontSize: 26, fontWeight: 600 }}>{summary.projectsRunning}</div>
        </div>
        <div className="card">
          <div className="card-sub">Letzter Deploy fehlgeschlagen</div>
          <div style={{ fontSize: 26, fontWeight: 600, color: summary.projectsFailedLastDeploy > 0 ? "var(--danger)" : undefined }}>
            {summary.projectsFailedLastDeploy}
          </div>
        </div>
      </div>

      {disk && (
        <div
          style={{
            border: `1px solid ${disk.usedPercent >= 80 ? "var(--danger)" : "var(--border)"}`,
            borderRadius: 8,
            padding: 14,
            marginBottom: 24,
            background: "var(--panel)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              Plattenbelegung (/opt)
              {disk.usedPercent >= 80 && (
                <span style={{ color: "var(--danger)", marginLeft: 8 }}>
                  ⚠ {disk.usedPercent}% belegt — Build-Snapshots/Docker-Images aufräumen
                </span>
              )}
            </span>
            <button className="btn" onClick={handleCleanupNow} disabled={cleaning}>
              {cleaning ? "Räume auf…" : "Jetzt aufräumen"}
            </button>
          </div>
          <div style={{ height: 8, borderRadius: 4, background: "var(--panel-raised)", overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${Math.min(100, disk.usedPercent)}%`,
                background: disk.usedPercent >= 80 ? "var(--danger)" : disk.usedPercent >= 60 ? "#e0a340" : "#2da44e",
              }}
            />
          </div>
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 6 }}>
            {formatBytes(disk.usedBytes)} von {formatBytes(disk.totalBytes)} belegt ({disk.usedPercent}%) ·{" "}
            {formatBytes(disk.availableBytes)} frei
          </div>
          {cleanupNote && <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 6 }}>{cleanupNote}</div>}
        </div>
      )}

      {projects.length === 0 && <div className="empty-state">Noch keine Projekte angelegt.</div>}

      {projects.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
                <th style={{ padding: "8px 10px" }}>Projekt</th>
                <th style={{ padding: "8px 10px" }}>Status</th>
                <th style={{ padding: "8px 10px" }}>CPU</th>
                <th style={{ padding: "8px 10px" }}>RAM</th>
                <th style={{ padding: "8px 10px" }}>Letzter Deploy</th>
                <th style={{ padding: "8px 10px" }}>Domains</th>
                <th style={{ padding: "8px 10px" }}>DB-Verbindungen</th>
                <th style={{ padding: "8px 10px" }}>Monitoring</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "8px 10px" }}>
                    <Link href={`/dashboard/projects/${p.tenantSlug}`} style={{ color: "var(--accent)" }}>
                      {p.slug}
                    </Link>
                    <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{p.tariff}</div>
                  </td>
                  <td style={{ padding: "8px 10px" }}>
                    {p.activeContainer ? (
                      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: "#2da44e" }} />
                        live
                      </span>
                    ) : (
                      <span style={{ color: "var(--text-dim)" }}>kein Container</span>
                    )}
                  </td>
                  <td style={{ padding: "8px 10px" }}>{p.cpuPerc ?? "–"}</td>
                  <td style={{ padding: "8px 10px" }}>{p.memPerc ?? p.memUsage ?? "–"}</td>
                  <td style={{ padding: "8px 10px" }}>
                    {p.lastDeployment ? (
                      <span>
                        <span style={{ color: STATUS_COLOR[p.lastDeployment.status] || "var(--text-dim)" }}>
                          {p.lastDeployment.status}
                        </span>
                        <span style={{ color: "var(--text-dim)" }}> · vor {timeAgo(p.lastDeployment.finishedAt || p.lastDeployment.createdAt)}</span>
                      </span>
                    ) : (
                      <span style={{ color: "var(--text-dim)" }}>noch nie</span>
                    )}
                  </td>
                  <td style={{ padding: "8px 10px" }}>
                    {Object.entries(p.domains).length === 0 && <span style={{ color: "var(--text-dim)" }}>–</span>}
                    {Object.entries(p.domains).map(([status, n]) => (
                      <span key={status} className="pk-badge" style={{ marginRight: 4 }}>
                        {n}× {DOMAIN_STATUS_LABEL[status] || status}
                      </span>
                    ))}
                  </td>
                  <td style={{ padding: "8px 10px" }}>{p.dbConnections}</td>
                  <td style={{ padding: "8px 10px" }}>
                    {p.kumaUrl ? (
                      <a href={p.kumaUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                        in Uptime Kuma öffnen
                      </a>
                    ) : (
                      <span style={{ color: "var(--text-dim)" }}>kein Monitor</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
OVERVIEWPAGE_EOF


echo "== Rebuild + Neustart Provisioning-Agent =="
cd "$PLATFORM_DIR/provisioning-agent"
docker compose --env-file ../.env build
docker compose --env-file ../.env up -d

echo "== Rebuild + Neustart Dashboard =="
cd "$PLATFORM_DIR/dashboard"
docker compose --env-file ../.env build
docker compose --env-file ../.env up -d

echo ""
echo "Fertig. Backup liegt in: $BACKUP_DIR"
echo "Rollback bei Bedarf: $0 --rollback $BACKUP_DIR"
