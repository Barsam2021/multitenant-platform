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
  envVars?: Record<string, string>
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

  // Env-Vars (Tenant-Secrets + project_env_vars) auch dem BUILD-Schritt verfügbar
  // machen, nicht nur dem späteren `docker run` — Next.js liest z.B. beim `next build`
  // (Page-Data-Collection, NEXT_PUBLIC_*-Inlining) bereits Env-Vars, siehe RESEND_API_KEY-
  // Fehler bei up2-website (Modul-Level `new Resend(...)` wirft schon beim Build, nicht
  // erst beim Container-Start). Landet dadurch als ENV im fertigen Image — bewusster
  // Trade-off, für Next.js/Vite-artige Frameworks nötig (Werte teils schon zur Build-Zeit
  // in den JS-Bundle inlined).
  for (const [key, value] of Object.entries(envVars || {})) {
    args.push('--env', `${key}=${value}`);
  }

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
    });
    return { imageTag, log: maskSecrets(stdout + '\n' + stderr) };
  } catch (err: any) {
    const log = maskSecrets((err.stdout || '') + '\n' + (err.stderr || '') + '\n' + err.message);
    throw Object.assign(new Error('nixpacks build failed'), { buildLog: log });
  }
}
