import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { maskSecrets } from './crypto';

const execFileP = promisify(execFile);

// Default für Repos ohne eigene Node-Version-Angabe (.nvmrc/engines.node/nixpacks.toml) —
// eine vorhandene Repo-eigene Angabe hat immer Vorrang (siehe unten, wir schreiben nur,
// wenn keine nixpacks.toml existiert). Überschreibbar über PLATFORM_DEFAULT_NODE_VERSION
// in der zentralen .env. Nur Major-Version, siehe Nix-Paketnamen-Konvention (nodejs_20 etc.).
//
// WICHTIG: NIXPACKS_NODE_VERSION als Env-Var an den `nixpacks`-Prozess durchzureichen ist
// unzuverlässig (mehrere offene Upstream-Issues, u.a. railwayapp/nixpacks#1359,
// coollabsio/coolify#5885 — "stays at 18" trotz gesetzter Env-Var). Stattdessen schreiben
// wir eine `nixpacks.toml` mit explizitem `phases.setup.nixPkgs`, das der Planer direkt
// liest, unabhängig von Auto-Detection.
const DEFAULT_NODE_VERSION_MAJOR = (process.env.PLATFORM_DEFAULT_NODE_VERSION || '20').split('.')[0];

/**
 * Baut ein OCI-Image aus dem ausgecheckten Repo-Pfad via Nixpacks v1.41.0.
 * Respektiert ein vorhandenes Dockerfile im Repo automatisch (Nixpacks-Default-Verhalten).
 *
 * Rückgabe: gebauter Image-Tag + (secret-maskiertes) Build-Log für die `deployments.build_log`-Spalte.
 */
export async function nixpacksBuild(
  buildPath: string,
  imageTag: string,
  buildCommand?: string,
  envVars?: Record<string, string>,
  signal?: AbortSignal // P2-4: Deploy-Abbruch waehrend des Builds
): Promise<{ imageTag: string; log: string }> {
  // Nur schreiben, wenn das Repo keine eigene nixpacks.toml mitbringt — Repo-eigene
  // Config hat immer Vorrang, wir liefern nur einen sinnvollen Plattform-Default.
  const configPath = `${buildPath}/nixpacks.toml`;
  if (!existsSync(configPath)) {
    await writeFile(configPath, `[phases.setup]\nnixPkgs = ["nodejs_${DEFAULT_NODE_VERSION_MAJOR}"]\n`, 'utf8');
  }

  const args = [
  'build',
  buildPath,
  '--name',
  imageTag,
  '--docker-output',
  'type=docker',
  ];

  // Env-Vars dem BUILD-Schritt verfügbar machen — Next.js/Vite lesen beim Build
  // bereits Env-Vars (Page-Data-Collection, NEXT_PUBLIC_*-Inlining, Modul-Level
  // `new Resend(...)` wirft sonst schon beim Build).
  //
  // P0-4 (Audit 0430f9c): ABER NICHT ALLE. Was hier reingeht, landet als ENV-Layer
  // im fertigen Image und ist per `docker history app-<slug>:<sha>` lesbar. Vorher
  // ging JWT_SECRET (das Signaturgeheimnis von GoTrue — wer es hat, faelscht
  // beliebige Tokens fuer beliebige Rollen dieses Tenants) und
  // SUPABASE_SERVICE_ROLE_KEY (BYPASSRLS) mit ins Image.
  //
  // Regel: zur Build-Zeit nur, was im Client-Bundle sowieso oeffentlich landet.
  // Alles andere ausschliesslich zur Laufzeit ueber `docker run -e` (siehe
  // deploy.ts, envArgs) — dort ist es zwar per `docker inspect` sichtbar, aber
  // nicht im weitergebbaren Image und nicht im Build-Log.
  const BUILD_TIME_DENYLIST = [
    'JWT_SECRET',
    'SUPABASE_SERVICE_ROLE_KEY',
    'MINIO_SECRET_KEY',
    'DATABASE_URL',
    'POSTGRES_PASSWORD',
  ];
  const isBuildTimeSafe = (key: string): boolean => {
    if (BUILD_TIME_DENYLIST.includes(key)) return false;
    // Framework-Konventionen fuer "landet im Browser-Bundle" — per Definition oeffentlich.
    if (/^(NEXT_PUBLIC_|VITE_|PUBLIC_|REACT_APP_|NUXT_PUBLIC_|GATSBY_|EXPO_PUBLIC_)/.test(key)) return true;
    // Alles, was nach Secret aussieht, bleibt draussen.
    if (/SECRET|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|_KEY$|^KEY$|TOKEN|CREDENTIAL/i.test(key)) return false;
    return true;
  };

  const skippedAtBuildTime: string[] = [];
  for (const [key, value] of Object.entries(envVars || {})) {
    if (!isBuildTimeSafe(key)) { skippedAtBuildTime.push(key); continue; }
    args.push('--env', `${key}=${value}`);
  }
  const skipNote = skippedAtBuildTime.length
    ? `[build-env] Zur Build-Zeit ausgelassen (nur zur Laufzeit gesetzt): ${skippedAtBuildTime.join(', ')}\n`
    : '';

  if (buildCommand) {
    // Nixpacks erlaubt Override einzelner Build-Phasen über --build-cmd.
    // buildCommand kommt aus project.build_command (DB), wird NIE in eine Shell interpoliert —
    // hier als eigenes Argument im Array, execFile führt kein Shell-Parsing durch.
    args.push('--build-cmd', buildCommand);
  }

  try {
    const { stdout, stderr } = await execFileP('nixpacks', args, {
      maxBuffer: 1024 * 1024 * 32, // 32MB — Build-Logs können lang werden
      timeout: 10 * 60 * 1000, // 10 Minuten Hard-Timeout pro Build
      signal,
      // Nixpacks baut mit `--docker-output type=docker`, das erzwingt BuildKit/buildx.
      // BuildKit braucht dafuer eine rohe, bidirektionale Session zum Docker-Daemon
      // (HTTP-Upgrade auf einen gRPC-Stream) — das kann der tecnativa/docker-socket-proxy
      // (HAProxy-ACL nach Pfad+Methode, kein echtes Protokoll-Upgrade) strukturell nicht
      // durchreichen und antwortet mit "unable to upgrade to tcp, received 403". Nur fuer
      // den Build-Prozess deshalb der rohe Socket statt DOCKER_HOST=tcp://docker-socket-proxy:2375
      // (Env-Default aus dem Container) — alle anderen Docker-Aufrufe (deploy.ts, cleanup.ts,
      // traefikDynamic.ts) laufen unveraendert ueber den Proxy.
      env: { ...process.env, DOCKER_HOST: 'unix:///var/run/docker.sock' },
    });
    const secretValues = Object.values(envVars || {});
    return { imageTag, log: skipNote + maskSecrets(stdout + '\n' + stderr, secretValues) };
  } catch (err: any) {
    if (err.name === 'AbortError') {
      // P2-4: Abbruch, kein Build-Fehler - deploy.ts unterscheidet danach.
      throw err;
    }
    // Node haengt bei execFile-Fehlern das komplette Kommando inklusive aller
    // Argumente an err.message — also auch jedes durchgereichte --env KEY=VALUE.
    // Genau das war der Hauptleak-Pfad in deployments.build_log.
    const log = skipNote + maskSecrets(
      (err.stdout || '') + '\n' + (err.stderr || '') + '\n' + err.message,
      Object.values(envVars || {})
    );
    throw Object.assign(new Error('nixpacks build failed'), { buildLog: log });
  }
}
