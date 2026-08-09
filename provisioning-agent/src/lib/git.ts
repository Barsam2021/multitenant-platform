import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';

const execFileP = promisify(execFile);

const BUILDS_ROOT = '/opt/multitenant-platform/deployments/builds';
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
