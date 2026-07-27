import { Router } from 'express';
import { Client as PGClient } from 'pg';
import { verifyGithubSignature } from '../lib/git';
import { runDeployment, Project } from '../lib/deploy';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

function adminClient(): PGClient {
  return new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
}

export const webhooksRouter = Router();

// POST /webhooks/github/:projectId
// WICHTIG: dieser Router wird in index.ts mit express.raw() statt express.json()
// gemountet, weil die HMAC-Signatur über den EXAKTEN rohen Body berechnet wird —
// ein bereits geparster/re-serialisierter JSON-Body würde die Signatur invalidieren.
webhooksRouter.post('/webhooks/github/:projectId', async (req, res) => {
  const { projectId } = req.params;
  const rawBody: Buffer = req.body; // Buffer dank express.raw()
  const signature = req.header('X-Hub-Signature-256');
  const event = req.header('X-GitHub-Event');

  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query('SELECT * FROM projects WHERE id = $1', [projectId]);
    if (rows.length === 0) return res.status(404).json({ error: 'project not found' });
    const project: Project = rows[0];

    const secretRow = await db.query('SELECT webhook_secret FROM projects WHERE id = $1', [projectId]);
    const secret = secretRow.rows[0]?.webhook_secret;
    if (!secret || !verifyGithubSignature(rawBody, signature, secret)) {
      return res.status(401).json({ error: 'invalid signature' });
    }

    // Nur auf 'push' reagieren, und nur wenn der Ziel-Branch der default_branch ist.
    if (event !== 'push') {
      return res.json({ status: 'ignored', reason: `event ${event} not handled` });
    }

    const payload = JSON.parse(rawBody.toString('utf8'));
    const pushedBranch = (payload.ref || '').replace('refs/heads/', '');
    if (pushedBranch !== project.default_branch) {
      return res.json({ status: 'ignored', reason: `push to ${pushedBranch}, watching ${project.default_branch}` });
    }

    const { rows: tariffRows } = await db.query('SELECT tariff FROM kunden WHERE slug = $1', [project.tenant_slug]);
    const tariff = tariffRows[0]?.tariff || 'starter';

    const { rows: depRows } = await db.query(
      `INSERT INTO deployments (project_id, status, triggered_by) VALUES ($1, 'queued', 'webhook') RETURNING id`,
      [projectId]
    );
    const deploymentId = depRows[0].id;

    runDeployment(project, payload.after || project.default_branch, 'webhook', tariff, deploymentId).catch((err) => {
      console.error(`Webhook-triggered deployment ${deploymentId} crashed:`, err.message);
    });

    res.json({ status: 'queued', deploymentId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});
