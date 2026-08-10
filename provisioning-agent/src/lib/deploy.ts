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

/**
 * P1-7 (Audit 0430f9c): Es gab keinen Lock pro Projekt. POST /deployments und
 * der GitHub-Webhook starten runDeployment() fire-and-forget.
 *
 * Zwei belegte Kollisionen:
 *  (a) Gleicher Commit, zwei Trigger (GitHub-Retry, Doppelklick, Push waehrend
 *      laufendem Deploy): newContainerName = app-<slug>-<sha8> ist identisch,
 *      Deploy B macht `docker rm -f` und loescht damit den bereits laufenden,
 *      gerade gesund gemeldeten Kandidaten von Deploy A.
 *  (b) Beide passieren den Swap: A benennt app-<slug> um, B findet den Namen
 *      nicht mehr und setzt hadPrevious=false — im schlechtesten Fall laeuft
 *      danach kein Container mit dem oeffentlichen Namen und der Rollback-Pfad
 *      greift nicht. Kundenseite dauerhaft 404, ohne Alarm.
 *
 * In-Memory reicht, weil ein Agent-Neustart ohnehin alle laufenden Deployments
 * verliert (dann existiert auch kein konkurrierender Prozess mehr). Robuster
 * waere ein Advisory Lock auf hashtext(project.id) — dieselbe Mechanik wie in
 * POST /tenants, siehe P0-3.
 */
const deployLocks = new Set<string>();

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
 * P0-1 (Audit 0430f9c): Kundencontainer duerfen NICHT mehr in traefik-net laufen.
 *
 * Vorher hing der Kundencode im selben flachen Netz wie core-postgres, pgbouncer,
 * core-minio, admin-dashboard und der docker-socket-proxy. Ein einziges
 * kompromittiertes npm-Paket im Repo eines Kunden (nixpacks fuehrt postinstall aus)
 * reichte fuer Root auf dem Host.
 *
 * Jetzt: ein Bridge-Netz pro Projekt. Dazu verbunden werden gezielt nur:
 *   - global-traefik      (sonst kein Routing zum Container)
 *   - provisioning-agent  (sonst schlaegt pollHealthcheck() fehl — der Agent macht
 *                          den Healthcheck per fetch() auf den Containernamen)
 *   - api-<slug>, auth-<slug>, core-minio  (die Tenant-Dienste, die die App laut
 *                          buildEnvVars() als Ziel gesetzt bekommt)
 *
 * BEWUSSTE ABWEICHUNG vom Audit-Vorschlag `--internal`: ein internal-Netz hat kein
 * Gateway, damit hat die Kunden-App keinen Internet-Egress mehr (Stripe, Resend,
 * externe APIs, Fonts). Das waere ein Funktionsbruch fuer nahezu jede Kunden-App.
 * Die Plattform-Container sind trotzdem unerreichbar, weil sie in einem anderen
 * Bridge-Netz liegen und keine Host-Ports publizieren (Ausnahme: pgbouncer auf
 * 127.0.0.1:6432 — nur Loopback des Hosts, aus dem Container nicht erreichbar).
 */
async function ensureProjectNetwork(slug: string, tenantSlug: string): Promise<string> {
  const netName = `app-${slug}-net`;

  try {
    await execFileP('docker', ['network', 'create', netName]);
  } catch (e: any) {
    // "already exists" ist der Normalfall bei jedem Deploy ausser dem ersten.
    if (!/already exists/i.test(e.stderr || e.message || '')) throw e;
  }

  // Reihenfolge: erst Agent (Healthcheck), dann Traefik (Routing), dann Tenant-Dienste.
  const toConnect = [
    'provisioning-agent',
    'global-traefik',
    `api-${tenantSlug}`,
    `auth-${tenantSlug}`,
    'core-minio',
  ];
  for (const container of toConnect) {
    try {
      await execFileP('docker', ['network', 'connect', netName, container]);
    } catch (e: any) {
      const msg = e.stderr || e.message || '';
      // Bereits verbunden = ok. Nicht existent (z.B. core-minio bei einem
      // Setup ohne Storage) = Warnung, kein Abbruch.
      if (/already exists in network|is already attached/i.test(msg)) continue;
      if (/No such container/i.test(msg)) {
        console.warn(`ensureProjectNetwork: ${container} existiert nicht, uebersprungen`);
        continue;
      }
      throw e;
    }
  }
  return netName;
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
  if (deployLocks.has(project.id)) {
    const db0 = adminClient();
    try {
      await db0.connect();
      await updateDeployment(db0, deploymentId, {
        status: 'failed',
        build_log: 'Fuer dieses Projekt laeuft bereits ein Deployment. ' +
                   'Bitte warten, bis es abgeschlossen ist — zwei gleichzeitige Deploys ' +
                   'wuerden sich gegenseitig den Container wegloeschen (P1-7).',
        finished_at: true,
      });
    } catch (e: any) {
      console.error('Konnte Lock-Konflikt nicht protokollieren:', e.message);
    } finally {
      await db0.end().catch(() => {});
    }
    return;
  }
  deployLocks.add(project.id);

  const db = adminClient();
  await db.connect();
  let buildLog = '';
  // P0-4 (Audit 0430f9c): die KONKRETEN Secret-Werte fuer maskSecrets(). Muss
  // hier oben stehen, nicht im try — der catch-Block unten maskiert ebenfalls,
  // und dort ist eine im try deklarierte Variable nicht im Scope. Leer, bis
  // buildEnvVars() gelaufen ist; maskSecrets faellt dann auf die Namensmuster
  // zurueck, was fuer die Phase vor dem Env-Aufbau ausreicht.
  let secretValues: string[] = [];
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
    secretValues = Object.values(envVars);

    // 3. Nixpacks-Build
    const imageTag = `app-${project.slug}:${resolvedSha.slice(0, 12)}`;
    const buildResult = await nixpacksBuild(buildPath, imageTag, project.build_command || undefined, envVars, signal);
    buildLog += buildResult.log;
    await updateDeployment(db, deploymentId, { build_log: buildLog, image_tag: imageTag });
    checkCancelled();

    // 4. Neuen Container starten (interner Name, noch ohne öffentliche Traefik-Labels)
    const limits = TARIFF_LIMITS[tariff] || TARIFF_LIMITS.starter;
    const newContainerName = `app-${project.slug}-${resolvedSha.slice(0, 8)}`;
    const projectNet = await ensureProjectNetwork(project.slug, project.tenant_slug);
    await execFileP('docker', ['rm', '-f', newContainerName]).catch(() => {});
    await execFileP('docker', [
      'run', '-d',
      '--name', newContainerName,
      '--network', projectNet,
      `--memory=${limits.mem}`,
      `--cpus=${limits.cpus}`,
      '--pids-limit', '512',
      ...envArgs,
      imageTag,
    ]);
    state.containerName = newContainerName;
    buildLog += `Started candidate container ${newContainerName}\n`;
    await updateDeployment(db, deploymentId, { status: 'healthchecking', build_log: maskSecrets(buildLog, secretValues), container_name: newContainerName });

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
      await updateDeployment(db, deploymentId, { status: 'failed', build_log: maskSecrets(buildLog, secretValues), finished_at: true });
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
      '--network', projectNet,
      `--memory=${limits.mem}`,
      `--cpus=${limits.cpus}`,
      '--pids-limit', '512',
      // Red-Team-Befund: ohne Restart-Policy bleibt ein abgestuerzter
      // Kundencontainer tot, bis jemand manuell eingreift. Kuma alarmiert,
      // aber nichts holt ihn zurueck.
      '--restart', 'unless-stopped',
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
      await updateDeployment(db, deploymentId, { status: 'failed', build_log: maskSecrets(buildLog, secretValues), finished_at: true });
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
    await updateDeployment(db, deploymentId, { status: 'deployed', build_log: maskSecrets(buildLog, secretValues), container_name: publicName, finished_at: true });
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
      await updateDeployment(db, deploymentId, { status: 'cancelled', build_log: maskSecrets(buildLog, secretValues), finished_at: true }).catch(() => {});
    } else {
      buildLog += `\nError: ${err.buildLog || err.message}`;
      const hint = detectBuildErrorHint(buildLog);
      if (hint) buildLog = `⚠️ ${hint}\n${'─'.repeat(60)}\n${buildLog}`;
      await updateDeployment(db, deploymentId, { status: 'failed', build_log: maskSecrets(buildLog, secretValues), finished_at: true }).catch(() => {});
    }
  } finally {
    activeDeployments.delete(deploymentId);
    deployLocks.delete(project.id);
    await db.end().catch(() => {});
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
    const projectNet = await ensureProjectNetwork(project.slug, project.tenant_slug);

    // P1-8 (Audit 0430f9c): frueher stand hier direkt `docker rm -f publicName`,
    // danach `docker run` mit dem Ziel-Image. Zwei Wege in einen dauerhaften
    // Ausfall:
    //  1. pruneOldDockerImages() behaelt die letzten 5 Deployments nach
    //     created_at, unabhaengig davon, welches aktiv oder rollback-faehig ist.
    //     Nach fuenf fehlgeschlagenen Deploys ist das letzte funktionierende
    //     Image weg. Die UI bietet es weiterhin als Rollback-Ziel an, `docker
    //     run` scheitert mit "no such image" — nach dem `docker rm -f`.
    //  2. Kein Healthcheck nach dem Rollback: startet das alte Image nicht
    //     (fehlende Env-Var, geaenderte Schema-Voraussetzung), ist die Seite
    //     offline und niemand merkt es.
    // Deshalb: Image ZUERST pruefen, dann umbenennen statt loeschen, und bei
    // Fehlschlag zurueckbenennen.
    try {
      await execFileP('docker', ['image', 'inspect', target.image_tag]);
    } catch {
      throw new Error(
        `Rollback nicht moeglich: Image ${target.image_tag} existiert lokal nicht mehr ` +
        `(vermutlich vom Cleanup entfernt). Der aktuell laufende Container wurde NICHT ` +
        `angefasst. Stattdessen den gewuenschten Commit neu deployen.`
      );
    }

    const { stdout: existingRb } = await execFileP('docker', ['ps', '-aq', '--filter', `name=^/${publicName}$`]);
    const hadPrevious = existingRb.trim().length > 0;
    const parkedName = `${publicName}-rb-${Date.now()}`;
    if (hadPrevious) {
      await execFileP('docker', ['rename', publicName, parkedName]);
      await execFileP('docker', ['stop', parkedName]).catch(() => {});
    }

    // Idempotent: der innere Fehlerpfad ruft das hier auf und wirft danach, der
    // aeussere catch ruft es erneut. Ohne dieses Flag wuerde der zweite Aufruf
    // den gerade wiederhergestellten Container wieder loeschen.
    let restored = false;
    const restorePrevious = async () => {
      if (restored) return;
      restored = true;
      await execFileP('docker', ['rm', '-f', publicName]).catch(() => {});
      if (hadPrevious) {
        await execFileP('docker', ['rename', parkedName, publicName]).catch(() => {});
        await execFileP('docker', ['start', publicName]).catch(() => {});
      }
    };

    try {
    await execFileP('docker', [
      'run', '-d',
      '--name', publicName,
      '--network', projectNet,
      `--memory=${limits.mem}`,
      `--cpus=${limits.cpus}`,
      '--pids-limit', '512',
      '--restart', 'unless-stopped',
      '--label', 'traefik.enable=true',
      '--label', `traefik.http.routers.${project.slug}-app.rule=Host(\`${project.preview_hostname}\`)`,
      '--label', `traefik.http.routers.${project.slug}-app.entrypoints=websecure`,
      '--label', `traefik.http.routers.${project.slug}-app.tls.certresolver=myresolver`,
      '--label', `traefik.http.services.${project.slug}-app.loadbalancer.server.port=${appPort}`,
      ...envArgs,
      target.image_tag,
    ]);

    const rolledBackHealthy = await pollHealthcheck(publicName, appPort, 60_000, project.health_path || '/');
    if (!rolledBackHealthy) {
      const logs = await execFileP('docker', ['logs', '--tail', '100', publicName]).catch(() => ({ stdout: '', stderr: '' }));
      await restorePrevious();
      throw new Error(
        `Rollback-Container wurde nicht gesund (Port ${appPort}). Der vorherige Container ` +
        `wurde wiederhergestellt.\n--- Logs ---\n${logs.stdout}\n${logs.stderr}`
      );
    }
    } catch (err) {
      await restorePrevious();
      throw err;
    }

    // Erst jetzt, nach bestandenem Healthcheck, den geparkten Container entfernen.
    if (hadPrevious) await execFileP('docker', ['rm', '-f', parkedName]).catch(() => {});

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
