import { execFile } from 'child_process';
import { promisify } from 'util';
import { Client as PGClient } from 'pg';
import { checkoutRepo } from './git';
import { nixpacksBuild } from './nixpacks';
import { buildEnvVars } from './secrets';
import { maskSecrets } from './crypto';
import { detectBuildErrorHint } from './buildErrorHints';

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
  if (fields.build_log !== undefined) { sets.push(`build_log = $${i++}`); vals.push(fields.build_log); }
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
