import { Router } from 'express';
import { Client as PGClient } from 'pg';
import { runDeployment, rollbackToDeployment, Project } from '../lib/deploy';
import { logAudit } from '../lib/audit';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

function adminClient(): PGClient {
  return new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
}

async function loadProject(db: PGClient, projectId: string): Promise<Project | null> {
  const { rows } = await db.query('SELECT * FROM projects WHERE id = $1', [projectId]);
  return rows[0] || null;
}

export const deploymentsRouter = Router();

// POST /deployments — manueller oder API-getriggerter Deploy
deploymentsRouter.post('/deployments', async (req, res) => {
  const { projectId, ref, triggeredBy } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId required' });

  const db = adminClient();
  await db.connect();
  try {
    const project = await loadProject(db, projectId);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const { rows: tariffRows } = await db.query('SELECT tariff FROM kunden WHERE slug = $1', [project.tenant_slug]);
    const tariff = tariffRows[0]?.tariff || 'starter';

    const { rows: depRows } = await db.query(
      `INSERT INTO deployments (project_id, status, triggered_by) VALUES ($1, 'queued', $2) RETURNING id`,
      [projectId, triggeredBy || 'manual']
    );
    const deploymentId = depRows[0].id;

    // Async im Hintergrund laufen lassen, Response sofort mit deploymentId zurückgeben.
    // Der Aufrufer pollt GET /deployments/:projectId für den Status.
    runDeployment(project, ref || project.default_branch, triggeredBy || 'manual', tariff, deploymentId).catch((err) => {
      console.error(`Deployment ${deploymentId} crashed unexpectedly:`, err.message);
    });

    await logAudit('deployment.trigger', project.slug, { deploymentId, ref: ref || project.default_branch, triggeredBy: triggeredBy || 'manual' });
    res.json({ status: 'queued', deploymentId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// GET /deployments/:projectId — Deployment-Historie für Dashboard-Ansicht/Polling
deploymentsRouter.get('/deployments/:projectId', async (req, res) => {
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT id, commit_sha, status, container_name, image_tag, triggered_by, created_at, finished_at,
              LEFT(build_log, 8000) AS build_log
       FROM deployments WHERE project_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [req.params.projectId]
    );
    res.json(rows);
  } finally {
    await db.end();
  }
});

// POST /deployments/:id/rollback — auf einen vorherigen erfolgreichen Deploy zurückrollen
deploymentsRouter.post('/deployments/:id/rollback', async (req, res) => {
  const { projectId } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId required' });

  const db = adminClient();
  await db.connect();
  try {
    const project = await loadProject(db, projectId);
    if (!project) return res.status(404).json({ error: 'project not found' });
    const { rows: tariffRows } = await db.query('SELECT tariff FROM kunden WHERE slug = $1', [project.tenant_slug]);
    const tariff = tariffRows[0]?.tariff || 'starter';

    await rollbackToDeployment(project, req.params.id, tariff);
    await logAudit('deployment.rollback', project.slug, { targetDeploymentId: req.params.id });
    res.json({ status: 'ok' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});
