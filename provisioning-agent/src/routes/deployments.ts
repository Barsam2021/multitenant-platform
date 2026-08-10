import { Router } from 'express';
import { Client as PGClient } from 'pg';
import { runDeployment, rollbackToDeployment, cancelDeployment, Project } from '../lib/deploy';
import { logAudit } from '../lib/audit';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

function adminClient(): PGClient {
  // P1-4 (Audit 0430f9c): ein pg.Client emittiert bei Verbindungsverlust ein
  // 'error'-Event. OHNE Listener ist das in Node eine uncaught exception, also
  // Prozessende — im schlimmsten Fall mitten im Deploy zwischen `docker rename`
  // und `docker run`: Kundenseite offline, und nichts raeumt auf. deploy.ts
  // haelt einen solchen Client ueber die gesamte Deploy-Dauer offen (Build-
  // Timeout allein 10 Minuten).
  const client = new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
  client.on('error', (err) => console.error('pg client error (adminClient):', err.message));
  return client;
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

    // P1-11 (Audit 0430f9c): POST /tenants/:slug/status mit "suspended" stoppt
    // Container und entfernt Router — aber weder runDeployment() noch der
    // Webhook-Handler pruefen kunden.status. Ein Push ins verbundene Repo eines
    // gesperrten Kunden baute einen neuen Container samt Traefik-Labels und hob
    // die Sperre faktisch auf, inklusive Verbrauch von Build-CPU, Disk und RAM.
    const { rows: statusRows } = await db.query('SELECT status FROM kunden WHERE slug = $1', [project.tenant_slug]);
    if (statusRows[0]?.status === 'suspended') {
      return res.status(423).json({ error: `Tenant "${project.tenant_slug}" ist gesperrt — kein Deployment moeglich.` });
    }

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

// GET /deployments/:projectId — Deployment-Historie für Dashboard-Ansicht/Polling.
// P2-4: bewusst OHNE build_log - bei 32MB Logs war das alle 3s fuer bis zu 20
// Zeilen gleichzeitig spuerbar. Das Log einer einzelnen (aufgeklappten) Zeile
// kommt ueber GET /deployments/single/:id, optional inkrementell per logOffset.
deploymentsRouter.get('/deployments/:projectId', async (req, res) => {
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT id, commit_sha, commit_message, status, container_name, image_tag, triggered_by, created_at, finished_at
       FROM deployments WHERE project_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [req.params.projectId]
    );
    res.json(rows);
  } finally {
    await db.end();
  }
});

// GET /deployments/single/:id?logOffset=N — Einzelnes Deployment inkl. Build-Log.
// Mit logOffset: liefert nur das Delta ab dieser Zeichenposition (logDelta) plus
// logTotalLength, statt bei jedem Poll den kompletten (potenziell sehr langen)
// Log erneut zu uebertragen (P2-4).
deploymentsRouter.get('/deployments/single/:id', async (req, res) => {
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT id, project_id, commit_sha, commit_message, status, container_name, image_tag,
              triggered_by, created_at, finished_at, build_log
       FROM deployments WHERE id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'deployment not found' });
    const row = rows[0];
    const fullLog: string = row.build_log || '';

    if (req.query.logOffset !== undefined) {
      const offset = Math.max(0, Math.min(fullLog.length, Number(req.query.logOffset) || 0));
      const { build_log, ...rest } = row;
      return res.json({ ...rest, logDelta: fullLog.slice(offset), logTotalLength: fullLog.length });
    }
    res.json(row);
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
    // P1-11 (Audit 0430f9c): POST /tenants/:slug/status mit "suspended" stoppt
    // Container und entfernt Router — aber weder runDeployment() noch der
    // Webhook-Handler pruefen kunden.status. Ein Push ins verbundene Repo eines
    // gesperrten Kunden baute einen neuen Container samt Traefik-Labels und hob
    // die Sperre faktisch auf, inklusive Verbrauch von Build-CPU, Disk und RAM.
    const { rows: statusRows } = await db.query('SELECT status FROM kunden WHERE slug = $1', [project.tenant_slug]);
    if (statusRows[0]?.status === 'suspended') {
      return res.status(423).json({ error: `Tenant "${project.tenant_slug}" ist gesperrt — kein Deployment moeglich.` });
    }
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

// POST /deployments/:id/cancel — P2-4: laufenden Build/Healthcheck abbrechen,
// solange noch nicht live geschaltet wurde (siehe deploy.ts pastPointOfNoReturn).
deploymentsRouter.post('/deployments/:id/cancel', async (req, res) => {
  const result = cancelDeployment(req.params.id);
  if (result.ok) {
    await logAudit('deployment.cancel', null, { deploymentId: req.params.id });
    return res.json({ status: 'cancel_requested', containerName: result.containerName });
  }

  // Kein aktiver In-Process-Handle gefunden (z.B. Agent-Neustart waehrend des
  // Builds) - wenn die DB die Deployment noch als aktiv fuehrt, ist das ein
  // verwaister Zustand, den sonst nichts je korrigieren wuerde.
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query('SELECT status FROM deployments WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'deployment not found' });
    if (!['queued', 'building', 'healthchecking'].includes(rows[0].status)) {
      return res.status(409).json({ error: result.reason || 'deployment ist in diesem Status nicht abbrechbar' });
    }
    await db.query(
      `UPDATE deployments SET status = 'cancelled', finished_at = now(),
         build_log = COALESCE(build_log, '') || $2
       WHERE id = $1`,
      [req.params.id, '\n[cancel] Kein aktiver Prozess im Agent gefunden (vermutlich Neustart) - Status manuell auf cancelled gesetzt.\n']
    );
    await logAudit('deployment.cancel', null, { deploymentId: req.params.id, orphaned: true });
    res.json({ status: 'cancelled', orphaned: true });
  } finally {
    await db.end();
  }
});
