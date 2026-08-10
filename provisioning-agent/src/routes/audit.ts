import { Router } from 'express';
import { Client as PGClient } from 'pg';

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

export const auditRouter = Router();

// GET /audit-logs?limit&offset&action&from&to (P2-7: Filter/Pagination statt
// fest 100 Eintraege ohne jede Einschraenkung). Liefert zusaetzlich totalCount
// fuer echte Seitenzahlen, analog zum Tabellen-Editor (P2-2).
auditRouter.get('/audit-logs', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const action = typeof req.query.action === 'string' ? req.query.action : undefined;
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;

  const whereParts: string[] = [];
  const vals: any[] = [];
  let i = 1;
  if (action) { whereParts.push(`action = $${i++}`); vals.push(action); }
  if (from) { whereParts.push(`created_at >= $${i++}`); vals.push(from); }
  if (to) { whereParts.push(`created_at <= $${i++}`); vals.push(to); }
  const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT id, actor, action, target, meta, created_at, ip_address, user_agent
       FROM audit_logs ${whereSql} ORDER BY created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
      [...vals, limit, offset]
    );
    const { rows: countRows } = await db.query(
      `SELECT count(*)::bigint AS n FROM audit_logs ${whereSql}`,
      vals
    );
    const { rows: actionRows } = await db.query(
      `SELECT DISTINCT action FROM audit_logs ORDER BY action`
    );
    res.json({
      logs: rows,
      totalCount: Number(countRows[0]?.n ?? 0),
      actions: actionRows.map((r) => r.action),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});
