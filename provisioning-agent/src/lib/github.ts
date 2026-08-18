const GITHUB_PAT = process.env.GITHUB_PAT;
const WEBHOOK_PUBLIC_URL = process.env.WEBHOOK_PUBLIC_URL || 'https://webhooks.example.com';

/**
 * GitHub-API-Kleinkram an einer Stelle. Vorher lagen parseGithubRepo() und die
 * Header-Konstruktion in routes/projects.ts und waren damit fuer lib/-Module
 * (Cleanup) nicht erreichbar.
 */

export function parseGithubRepo(repoUrl: string): { owner: string; repo: string } | null {
  const match = repoUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(\.git)?\/?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

export function githubHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${GITHUB_PAT}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export function webhookUrlFor(projectId: string): string {
  return `${WEBHOOK_PUBLIC_URL}/webhooks/github/${projectId}`;
}

export function hasGithubToken(): boolean {
  return !!GITHUB_PAT;
}

/**
 * Entfernt den Push-Webhook aus dem Repo. Wird beim Loeschen eines Projekts
 * gebraucht: bleibt er stehen, feuert GitHub bei jedem Push weiter gegen einen
 * Endpunkt, den es nicht mehr gibt — und deaktiviert den Hook irgendwann selbst
 * wegen dauerhafter Fehler, was im Repo wie ein Defekt aussieht.
 */
export async function deleteGithubWebhook(
  repoUrl: string,
  hookId: number
): Promise<{ deleted: boolean; reason?: string }> {
  if (!GITHUB_PAT) return { deleted: false, reason: 'GITHUB_PAT nicht gesetzt' };
  const parsed = parseGithubRepo(repoUrl);
  if (!parsed) return { deleted: false, reason: 'keine GitHub-URL' };

  try {
    const res = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/hooks/${hookId}`, {
      method: 'DELETE',
      headers: githubHeaders(),
    });
    // 404 = schon weg. Fuer den Aufrufer ist das dasselbe Ergebnis.
    if (res.ok || res.status === 404) return { deleted: true };
    return { deleted: false, reason: `GitHub API ${res.status}` };
  } catch (err: any) {
    return { deleted: false, reason: err.message };
  }
}
