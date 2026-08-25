import { Router } from 'express';
import { Client as PGClient } from 'pg';
import { runInventoryOnce, hasDrift } from '../lib/inventory';
import { logAudit } from '../lib/audit';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

function adminClient(): PGClient {
  const client = new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
  client.on('error', (err) => console.error('pg client error (security):', err.message));
  return client;
}

export const securityRouter = Router();

/**
 * Versionsinventar. Liefert den zuletzt erhobenen Stand aus der Datenbank —
 * nicht live, weil jeder Aufruf sonst die Docker-API belasten wuerde und die
 * Seite bei einem haengenden Daemon mit haengt.
 */
securityRouter.get('/security/components', async (req, res) => {
  const scope = typeof req.query.scope === 'string' ? req.query.scope : null;
  const db = adminClient();
  // connect() gehoert mit in den try: schlaegt es fehl (PgBouncer weg), lief
  // das finally darunter vorher nie und der Fehler ging an der 500-Antwort
  // dieser Route vorbei in die zentrale Error-Middleware.
  try {
    await db.connect();
    const { rows } = await db.query(
      `SELECT c.id, c.scope, c.project_id, c.target, c.kind, c.name, c.version,
              c.pinned_version, c.first_seen, c.last_seen, p.slug AS project_slug
         FROM components c
         LEFT JOIN projects p ON p.id = c.project_id
        WHERE ($1::text IS NULL OR c.scope = $1)
        ORDER BY c.scope, c.name`,
      [scope]
    );
    const components = rows.map((r) => ({
      ...r,
      drift: hasDrift({ ...r, pinnedVersion: r.pinned_version } as any),
    }));
    res.json({
      components,
      driftCount: components.filter((c) => c.drift).length,
      lastSeen: components.reduce<string | null>(
        (max, c) => (!max || c.last_seen > max ? c.last_seen : max),
        null
      ),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end().catch(() => {});
  }
});

/** Inventar neu erheben (Docker-API + Compose-Dateien). */
securityRouter.post('/security/inventory', async (_req, res) => {
  try {
    // Der Guard sitzt in lib/inventory.ts, gemeinsam mit dem Timer aus
    // index.ts — ein Flag hier haette den Timerlauf nicht gesehen.
    const components = await runInventoryOnce();
    if (!components) return res.status(409).json({ error: 'inventory already running' });
    await logAudit('security.inventory.collected', null, { count: components.length });
    res.json({ status: 'ok', count: components.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
