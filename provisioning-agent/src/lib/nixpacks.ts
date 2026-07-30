import { execFile } from 'child_process';
import { promisify } from 'util';
import { maskSecrets } from './crypto';

const execFileP = promisify(execFile);

/**
 * Baut ein OCI-Image aus dem ausgecheckten Repo-Pfad via Nixpacks v1.41.0.
 * Respektiert ein vorhandenes Dockerfile im Repo automatisch (Nixpacks-Default-Verhalten).
 *
 * Rückgabe: gebauter Image-Tag + (secret-maskiertes) Build-Log für die `deployments.build_log`-Spalte.
 */
export async function nixpacksBuild(
  buildPath: string,
  imageTag: string,
  buildCommand?: string
): Promise<{ imageTag: string; log: string }> {
  const args = ['build', buildPath, '--name', imageTag];
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
      // BuildKit braucht das buildx-Plugin, das im Agent-Image (Alpine, docker-cli
      // ohne docker-cli-buildx) nicht vorhanden ist ("BuildKit is enabled but the
      // buildx component is missing"). Legacy-Builder funktioniert ohne Zusatzpaket.
      env: { ...process.env, DOCKER_BUILDKIT: '0' },
    });
    return { imageTag, log: maskSecrets(stdout + '\n' + stderr) };
  } catch (err: any) {
    const log = maskSecrets((err.stdout || '') + '\n' + (err.stderr || '') + '\n' + err.message);
    throw Object.assign(new Error('nixpacks build failed'), { buildLog: log });
  }
}
