import { Router } from 'express';

const GITHUB_PAT = process.env.GITHUB_PAT;

export const githubRouter = Router();

interface GithubRepo {
  name: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
  updatedAt: string;
}

// GET /github/repos — listet die Repos des PAT-Owners (Solo-Admin-Setup, siehe
// projects.ts § registerGithubWebhook: gleicher GITHUB_PAT, kein OAuth-Flow nötig,
// da nur ein einziger GitHub-Account (der des Betreibers) angebunden wird).
githubRouter.get('/github/repos', async (_req, res) => {
  if (!GITHUB_PAT) {
    return res.status(400).json({ error: 'GITHUB_PAT nicht gesetzt — Repo-Liste nicht verfügbar, Repo-URL manuell eintragen.' });
  }

  try {
    const repos: GithubRepo[] = [];
    // Bis zu 300 Repos (3 Seiten à 100) — Solo-Admin-Setup, mehr wird in der Praxis nicht gebraucht.
    for (let page = 1; page <= 3; page++) {
      const resp = await fetch(
        `https://api.github.com/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator`,
        {
          headers: {
            Authorization: `Bearer ${GITHUB_PAT}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );
      if (!resp.ok) {
        const body = await resp.text();
        return res.status(502).json({ error: `GitHub API ${resp.status}: ${body.slice(0, 300)}` });
      }
      const batch = await resp.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const r of batch) {
        repos.push({
          name: r.name,
          fullName: r.full_name,
          cloneUrl: r.clone_url,
          defaultBranch: r.default_branch,
          private: r.private,
          updatedAt: r.updated_at,
        });
      }
      if (batch.length < 100) break;
    }
    res.json({ repos });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
