import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';

const execFileP = promisify(execFile);

const BUILDS_ROOT = '/opt/multitenant-platform/deployments/builds';

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
  ref: string // Branch-Name oder Commit-SHA
): Promise<{ path: string; resolvedSha: string }> {
  if (!/^[a-z0-9-]+$/.test(projectSlug)) {
    throw new Error('invalid project slug for git checkout');
  }

  const repoDir = `${BUILDS_ROOT}/${projectSlug}/repo`;

  if (!existsSync(repoDir)) {
    await execFileP('mkdir', ['-p', repoDir]);
    await execFileP('git', ['clone', '--no-single-branch', repoUrl, repoDir]);
  } else {
    await execFileP('git', ['-C', repoDir, 'fetch', '--all', '--prune']);
  }

  // ref kann Branch oder SHA sein — 'git checkout' handhabt beides.
  await execFileP('git', ['-C', repoDir, 'checkout', ref]);
  // Falls ref ein Branch war: auf neuesten Remote-Stand ziehen.
  await execFileP('git', ['-C', repoDir, 'reset', '--hard', `origin/${ref}`]).catch(() => {
    // Kein Remote-Branch dieses Namens (z.B. weil ref bereits ein SHA war) — ignorieren.
  });

  const { stdout } = await execFileP('git', ['-C', repoDir, 'rev-parse', 'HEAD']);
  const resolvedSha = stdout.trim();

  // Isolierter Build-Snapshot pro Commit, damit parallele Deploys sich nicht in die Quere kommen.
  const commitDir = `${BUILDS_ROOT}/${projectSlug}/${resolvedSha.slice(0, 12)}`;
  await execFileP('rm', ['-rf', commitDir]);
  await execFileP('cp', ['-r', repoDir, commitDir]);

  return { path: commitDir, resolvedSha };
}

/**
 * Verifiziert eine GitHub-Webhook-Signatur (X-Hub-Signature-256, HMAC-SHA256).
 * Timing-safe Vergleich, siehe 05_deployment_engine_specification.md § 6.
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
