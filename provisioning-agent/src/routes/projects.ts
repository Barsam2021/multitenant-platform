import { Router } from 'express';
import { Client as PGClient } from 'pg';
import crypto from 'crypto';
import { encrypt } from '../lib/crypto';
import { createHttpMonitor, isMonitoringConfigured } from '../lib/monitoring';
import { logAudit } from '../lib/audit';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;
const PREVIEW_DOMAIN_SUFFIX = process.env.PLATFORM_DOMAIN || 'example.com';
const WEBHOOK_PUBLIC_URL = process.env.WEBHOOK_PUBLIC_URL || 'https://webhooks.example.com';
const GITHUB_PAT = process.env.GITHUB_PAT; // Fine-grained PAT, Scope: Webhooks (write) — Solo-Admin-Setup, kein OAuth-Flow (Phase 3 YAGNI für 1 User).

function adminClient(): PGClient {
  return new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
}

// slug-<10 zufällige Hex-Zeichen>.<suffix> — kollisionsarm, keine Rückschlüsse auf Kundenzahl.
function generatePreviewHostname(slug: string): string {
  return `${slug}-${crypto.randomBytes(5).toString('hex')}.${PREVIEW_DOMAIN_SUFFIX}`;
}

interface GithubWebhookResult {
  registered: boolean;
  reason?: string;
}

async function registerGithubWebhook(
  repoUrl: string,
  webhookUrl: string,
  secret: string
): Promise<GithubWebhookResult> {
  if (!GITHUB_PAT) return { registered: false, reason: 'GITHUB_PAT nicht gesetzt — manuell in GitHub eintragen.' };

  const match = repoUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(\.git)?\/?$/);
  if (!match) return { registered: false, reason: 'Keine GitHub-URL erkannt.' };
  const [, owner, repo] = match;

  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/hooks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GITHUB_PAT}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        name: 'web',
        active: true,
        events: ['push'],
        config: { url: webhookUrl, content_type: 'json', secret, insecure_ssl: '0' },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { registered: false, reason: `GitHub API ${res.status}: ${body.slice(0, 200)}` };
    }
    return { registered: true };
  } catch (err: any) {
    return { registered: false, reason: err.message };
  }
}

export const projectsRouter = Router();

// POST /projects — neues Deployment-Projekt für einen bestehenden Tenant anlegen,
// inkl. automatischer Preview-Domain + automatischer GitHub-Webhook-Registrierung.
projectsRouter.post('/projects', async (req, res) => {
  const { tenantSlug, slug, repoUrl, repoProvider, defaultBranch, buildCommand } = req.body;

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'invalid project slug' });
  if (!tenantSlug || !/^[a-z0-9-]+$/.test(tenantSlug)) return res.status(400).json({ error: 'invalid tenant slug' });
  if (!repoUrl) return res.status(400).json({ error: 'repoUrl required' });

  const webhookSecret = crypto.randomBytes(32).toString('hex');
  const previewHostname = generatePreviewHostname(slug);
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `INSERT INTO projects (tenant_slug, slug, repo_url, repo_provider, default_branch, build_command, webhook_secret, preview_hostname)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, slug, tenant_slug, repo_url, default_branch, active_container, preview_hostname, created_at`,
      [tenantSlug, slug, repoUrl, repoProvider || 'github', defaultBranch || 'main', buildCommand || null, webhookSecret, previewHostname]
    );
    await db.query(
      `INSERT INTO domains (project_id, hostname, kind, dns_verified, tls_issued)
       VALUES ($1, $2, 'subdomain', true, true)`,
      [rows[0].id, previewHostname]
    );

    const webhookUrl = `${WEBHOOK_PUBLIC_URL}/webhooks/github/${rows[0].id}`;
    const githubWebhook = await registerGithubWebhook(repoUrl, webhookUrl, webhookSecret);

    // Monitoring-Registrierung (Phase 4) — "best effort", analog zu registerGithubWebhook:
    // ein Kuma-Ausfall darf das Projekt-Anlegen nicht scheitern lassen.
    let monitoring: { registered: boolean; reason?: string } = { registered: false, reason: 'not configured' };
    if (isMonitoringConfigured()) {
      try {
        const monitorId = await createHttpMonitor(`${tenantSlug}/${slug}`, `https://${previewHostname}`);
        await db.query('UPDATE projects SET kuma_monitor_id = $1 WHERE id = $2', [monitorId, rows[0].id]);
        monitoring = { registered: true };
      } catch (e: any) {
        monitoring = { registered: false, reason: e.message };
        console.error(`Uptime-Kuma monitor registration failed for ${slug}:`, e.message);
      }
    }

    await logAudit('project.create', slug, { tenantSlug, repoUrl, repoProvider: repoProvider || 'github' });

    res.json({
      status: 'ok',
      project: rows[0],
      previewHostname,
      webhookSecret, // einmalig im Klartext zurückgeben, danach nur noch verschlüsselt/gehashed genutzt
      webhookUrl,
      githubWebhook,
      monitoring,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// GET /projects — Liste für Dashboard-Übersicht
projectsRouter.get('/projects', async (_req, res) => {
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT p.id, p.tenant_slug, p.slug, p.repo_url, p.default_branch, p.active_container,
              p.preview_hostname, p.created_at, k.tariff
       FROM projects p JOIN kunden k ON k.slug = p.tenant_slug
       ORDER BY p.created_at DESC`
    );
    res.json(rows);
  } finally {
    await db.end();
  }
});

// PUT /projects/:id/env — Env-Var setzen (verschlüsselt gespeichert)
projectsRouter.put('/projects/:id/env', async (req, res) => {
  const { id } = req.params;
  const { key, value } = req.body;
  if (!key || typeof value !== 'string') return res.status(400).json({ error: 'key and value required' });
  if (!/^[A-Z0-9_]+$/.test(key)) return res.status(400).json({ error: 'invalid env var key format' });

  const db = adminClient();
  await db.connect();
  try {
    const encrypted = encrypt(value);
    // Parameterisierte Query statt pg-format hier — %L ist für Bytea/Buffer-Werte nicht
    // zuverlässig; pg-format bleibt reserviert für Identifier-Quoting (siehe CLAUDE.md § 2.3).
    await db.query(
      `INSERT INTO project_env_vars (project_id, key, value_encrypted) VALUES ($1, $2, $3)
       ON CONFLICT (project_id, key) DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted`,
      [id, key, encrypted]
    );
    await logAudit('project.env.set', id, { key }); // Wert bewusst NICHT geloggt
    res.json({ status: 'ok' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// PUT /projects/:id/env/bulk — .env-Datei-Inhalt auf einen Schlag importieren.
// Erwartet rohen .env-Text (KEY=VALUE pro Zeile), parst serverseitig — Frontend schickt
// einfach den kompletten Datei-Inhalt, kein Client-seitiges Parsing nötig.
projectsRouter.put('/projects/:id/env/bulk', async (req, res) => {
  const { id } = req.params;
  const { envText } = req.body;
  if (typeof envText !== 'string') return res.status(400).json({ error: 'envText required' });

  const parsed: Record<string, string> = {};
  const errors: string[] = [];
  for (const rawLine of envText.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) { errors.push(`Übersprungen (kein "="): ${line.slice(0, 40)}`); continue; }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Umschließende Anführungszeichen entfernen — üblich in .env-Dateien.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!/^[A-Z0-9_]+$/.test(key)) { errors.push(`Übersprungen (ungültiger Key): ${key}`); continue; }
    parsed[key] = value;
  }

  const db = adminClient();
  await db.connect();
  try {
    for (const [key, value] of Object.entries(parsed)) {
      const encrypted = encrypt(value);
      await db.query(
        `INSERT INTO project_env_vars (project_id, key, value_encrypted) VALUES ($1, $2, $3)
         ON CONFLICT (project_id, key) DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted`,
        [id, key, encrypted]
      );
    }
    await logAudit('project.env.bulk_import', id, { count: Object.keys(parsed).length, keys: Object.keys(parsed) });
    res.json({ status: 'ok', imported: Object.keys(parsed).length, skipped: errors });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// GET /projects/:id/env — gesetzte Keys auflisten (Werte bleiben verborgen)
projectsRouter.get('/projects/:id/env', async (req, res) => {
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT key FROM project_env_vars WHERE project_id = $1 ORDER BY key ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// DELETE /projects/:id/env/:key — Env-Var entfernen
projectsRouter.delete('/projects/:id/env/:key', async (req, res) => {
  const db = adminClient();
  await db.connect();
  try {
    await db.query(
      `DELETE FROM project_env_vars WHERE project_id = $1 AND key = $2`,
      [req.params.id, req.params.key]
    );
    await logAudit('project.env.delete', req.params.id, { key: req.params.key });
    res.json({ status: 'ok' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});
