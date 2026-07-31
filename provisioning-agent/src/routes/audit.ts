import { Router } from 'express';
import { Client as PGClient } from 'pg';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

function adminClient(): PGClient {
  return new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
}

export const auditRouter = Router();

auditRouter.get('/audit-logs', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT id, actor, action, target, meta, created_at
       FROM audit_logs ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});
