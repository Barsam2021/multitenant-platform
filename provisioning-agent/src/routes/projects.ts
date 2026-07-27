import { Router } from 'express';
import { Client as PGClient } from 'pg';
import crypto from 'crypto';
import { encrypt } from '../lib/crypto';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

function adminClient(): PGClient {
  return new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
}

export const projectsRouter = Router();

// POST /projects — neues Deployment-Projekt für einen bestehenden Tenant anlegen
projectsRouter.post('/projects', async (req, res) => {
  const { tenantSlug, slug, repoUrl, repoProvider, defaultBranch, buildCommand } = req.body;

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'invalid project slug' });
  if (!tenantSlug || !/^[a-z0-9-]+$/.test(tenantSlug)) return res.status(400).json({ error: 'invalid tenant slug' });
  if (!repoUrl) return res.status(400).json({ error: 'repoUrl required' });

  const webhookSecret = crypto.randomBytes(32).toString('hex');
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `INSERT INTO projects (tenant_slug, slug, repo_url, repo_provider, default_branch, build_command, webhook_secret)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, slug`,
      [tenantSlug, slug, repoUrl, repoProvider || 'github', defaultBranch || 'main', buildCommand || null, webhookSecret]
    );
    // Standard-Subdomain gleich mit anlegen
    await db.query(
      `INSERT INTO domains (project_id, hostname, kind, dns_verified, tls_issued)
       VALUES ($1, $2, 'subdomain', true, true)`,
      [rows[0].id, `app.${slug}.vps.meine-domain.com`]
    );
    res.json({
      status: 'ok',
      project: rows[0],
      webhookSecret, // einmalig im Klartext zurückgeben, danach nur noch verschlüsselt/gehashed genutzt
      webhookUrl: `https://webhooks.vps.meine-domain.com/webhooks/github/${rows[0].id}`,
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
      `SELECT p.id, p.tenant_slug, p.slug, p.repo_url, p.default_branch, p.active_container, p.created_at,
              k.tariff
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
    res.json({ status: 'ok' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});
