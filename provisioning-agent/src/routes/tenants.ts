import { Router } from 'express';
import { Client as PGClient } from 'pg';
import { logAudit } from '../lib/audit';
import { writeTenantServiceRouter, removeTenantServiceRouter } from '../lib/traefikDynamic';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN || 'example.com';

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
      `SELECT anon_jwt, service_role_jwt, postgrest_public_enabled, auth_public_enabled FROM kunden WHERE slug = $1`,
      [slug]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'tenant not found' });

    await logAudit('tenant.api-keys.viewed', slug, {});

    // P1-6: postgrestUrl/authUrl sind Docker-interne Hostnamen — die funktionieren
    // NUR fuer Server-zu-Server-Aufrufe innerhalb desselben traefik-net (z.B. aus dem
    // Kunden-App-Container heraus, siehe lib/secrets.ts buildEnvVars). Von ausserhalb
    // (Browser, Postman, externe Systeme des Kunden) sind sie nicht erreichbar — vorher
    // zeigte das Dashboard genau diese URL mit Copy-Button, ohne das kenntlich zu machen.
    // *PublicUrl ist nur gesetzt, wenn der jeweilige *_public_enabled-Schalter aktiv ist
    // (siehe POST /tenants/:slug/public-access) — bewusst opt-in, ein SQL-REST-Endpoint
    // ist standardmaessig nicht oeffentlich erreichbar.
    res.json({
      postgrestUrl: `http://api-${slug}:3000`,
      postgrestPublicUrl: rows[0].postgrest_public_enabled ? `https://${slug}-api.${PLATFORM_DOMAIN}` : null,
      postgrestPublicEnabled: !!rows[0].postgrest_public_enabled,
      authUrl: `http://auth-${slug}:9999`,
      authPublicUrl: rows[0].auth_public_enabled ? `https://${slug}-auth.${PLATFORM_DOMAIN}` : null,
      authPublicEnabled: !!rows[0].auth_public_enabled,
      anonKey: rows[0].anon_jwt,
      serviceRoleKey: rows[0].service_role_jwt,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// POST /tenants/:slug/public-access  { service: 'postgrest' | 'auth', enabled: boolean }
// P1-6: schaltet die oeffentliche Erreichbarkeit von PostgREST bzw. GoTrue frei/zu.
// Schreibt/entfernt einen eigenen Traefik-Router (siehe lib/traefikDynamic.ts) und
// persistiert den Schalter in kunden.postgrest_public_enabled / auth_public_enabled
// (Spalten existierten schon seit Migration 02, wurden bis jetzt nie gelesen).
tenantsRouter.post('/tenants/:slug/public-access', async (req, res) => {
  const { slug } = req.params;
  const { service, enabled } = req.body;

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'invalid slug' });
  if (!['postgrest', 'auth'].includes(service)) return res.status(400).json({ error: "service must be 'postgrest' or 'auth'" });
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });

  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query('SELECT slug FROM kunden WHERE slug = $1', [slug]);
    if (rows.length === 0) return res.status(404).json({ error: 'tenant not found' });

    const hostname = `${slug}-${service === 'postgrest' ? 'api' : 'auth'}.${PLATFORM_DOMAIN}`;
    let url: string | null = null;

    if (enabled) {
      await writeTenantServiceRouter(service, slug, hostname);
      url = `https://${hostname}`;
    } else {
      await removeTenantServiceRouter(service, slug);
    }

    const column = service === 'postgrest' ? 'postgrest_public_enabled' : 'auth_public_enabled';
    await db.query(`UPDATE kunden SET ${column} = $1 WHERE slug = $2`, [enabled, slug]);
    await logAudit('tenant.public-access.set', slug, { service, enabled });

    res.json({ status: 'ok', service, enabled, url });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});
