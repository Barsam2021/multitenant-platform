import { Router } from 'express';
import { Client as PGClient } from 'pg';
import { logAudit } from '../lib/audit';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

function adminClient(): PGClient {
  return new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
}

export const tenantsRouter = Router();

// GET /tenants/:slug/api-keys — liefert die Supabase-kompatiblen JWTs für den Tenant
// (siehe lib/jwt.ts + Migration 09_tenant_api_keys.sql). Kein logAudit() mit den
// Werten selbst — nur die Tatsache des Zugriffs, analog zu project.env.set in
// routes/projects.ts, das den Wert bewusst nicht loggt.
tenantsRouter.get('/tenants/:slug/api-keys', async (req, res) => {
  const { slug } = req.params;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'invalid slug' });

  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT anon_jwt, service_role_jwt FROM kunden WHERE slug = $1`,
      [slug]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'tenant not found' });

    await logAudit('tenant.api-keys.viewed', slug, {});

    res.json({
      postgrestUrl: `http://api-${slug}:3000`,
      anonKey: rows[0].anon_jwt,
      serviceRoleKey: rows[0].service_role_jwt,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});
