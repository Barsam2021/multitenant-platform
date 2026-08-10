import { Router } from 'express';
import { Client as PGClient } from 'pg';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logAudit } from '../lib/audit';
import { writeTenantServiceRouter, removeTenantServiceRouter, removeAllRoutersForProject } from '../lib/traefikDynamic';
import { syncProjectRouters } from './domains';

const execFileP = promisify(execFile);
const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN || 'example.com';

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

// GET /tenants/:slug — Stammdaten fuer die Bearbeiten-Ansicht (P2-6).
tenantsRouter.get('/tenants/:slug', async (req, res) => {
  const { slug } = req.params;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'invalid slug' });

  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT id, slug, db_name, tariff, display_name, contact_email, notes, status, created_at
       FROM kunden WHERE slug = $1`,
      [slug]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'tenant not found' });
    res.json(rows[0]);
  } finally {
    await db.end();
  }
});

// PATCH /tenants/:slug  { displayName?, contactEmail?, notes?, tariff? } — reine
// Stammdaten-Aenderung ohne Seiteneffekte auf Container/Traefik (P2-6). Fuer den
// Status-Wechsel (aktiv/gesperrt) siehe POST /tenants/:slug/status, der hat welche.
tenantsRouter.patch('/tenants/:slug', async (req, res) => {
  const { slug } = req.params;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'invalid slug' });

  const { displayName, contactEmail, notes, tariff } = req.body;
  const sets: string[] = [];
  const vals: any[] = [];
  let i = 1;
  if (displayName !== undefined) { sets.push(`display_name = $${i++}`); vals.push(String(displayName).trim() || slug); }
  if (contactEmail !== undefined) { sets.push(`contact_email = $${i++}`); vals.push(contactEmail ? String(contactEmail).trim() : null); }
  if (notes !== undefined) { sets.push(`notes = $${i++}`); vals.push(notes ? String(notes).trim() : null); }
  if (tariff !== undefined) {
    if (!['starter', 'business', 'premium'].includes(tariff)) {
      return res.status(400).json({ error: 'invalid tariff' });
    }
    sets.push(`tariff = $${i++}`);
    vals.push(tariff);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'nothing to update' });
  vals.push(slug);

  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `UPDATE kunden SET ${sets.join(', ')} WHERE slug = $${i} RETURNING id, slug, display_name, contact_email, notes, tariff, status`,
      vals
    );
    if (rows.length === 0) return res.status(404).json({ error: 'tenant not found' });
    await logAudit('tenant.update', slug, { fields: Object.keys(req.body) });
    res.json(rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// POST /tenants/:slug/status  { status: 'active' | 'suspended' }
// P2-6: der Standardfall bei Zahlungsverzug - Container stoppen, Traefik-Router
// entfernen, DB UND alle Secrets bleiben unangetastet. Vorher gab es nur
// "laufen lassen oder komplett loeschen" (DELETE /tenants/:slug, unwiderruflich).
tenantsRouter.post('/tenants/:slug/status', async (req, res) => {
  const { slug } = req.params;
  const { status } = req.body;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'invalid slug' });
  if (!['active', 'suspended'].includes(status)) {
    return res.status(400).json({ error: "status must be 'active' or 'suspended'" });
  }

  const tenantDir = `/opt/multitenant-platform/kunden-instances/${slug}`;
  const db = adminClient();
  await db.connect();
  const warnings: string[] = [];
  try {
    const { rows: tenantRows } = await db.query('SELECT slug, status FROM kunden WHERE slug = $1', [slug]);
    if (tenantRows.length === 0) return res.status(404).json({ error: 'tenant not found' });
    if (tenantRows[0].status === status) {
      return res.json({ status, unchanged: true });
    }

    const { rows: projects } = await db.query(
      'SELECT id, slug AS project_slug, active_container FROM projects WHERE tenant_slug = $1',
      [slug]
    );

    if (status === 'suspended') {
      // Tenant-Instanz (auth/api) stoppen - 'stop' statt 'down', damit 'start'
      // beim Reaktivieren reicht und keine Container-IDs/Volumes neu entstehen.
      await execFileP('docker', ['compose', '-f', `${tenantDir}/docker-compose.yml`, 'stop']).catch((e: any) =>
        warnings.push(`Tenant-Container stoppen fehlgeschlagen: ${e.message}`)
      );
      for (const p of projects) {
        if (p.active_container) {
          await execFileP('docker', ['stop', p.active_container]).catch((e: any) =>
            warnings.push(`Container ${p.active_container} stoppen fehlgeschlagen: ${e.message}`)
          );
        }
        await removeAllRoutersForProject(p.project_slug).catch((e: any) =>
          warnings.push(`Router fuer ${p.project_slug} entfernen fehlgeschlagen: ${e.message}`)
        );
      }
    } else {
      // Reaktivieren: erst Container wieder hochfahren, dann Router neu schreiben -
      // syncProjectRouters braucht den aktuellen Domain-Stand aus der DB, nicht
      // den Container-Status, daher Reihenfolge hier unkritisch, aber Container
      // zuerst ist die intuitivere Lesart im Log.
      await execFileP('docker', ['compose', '-f', `${tenantDir}/docker-compose.yml`, 'start']).catch((e: any) =>
        warnings.push(`Tenant-Container starten fehlgeschlagen: ${e.message}`)
      );
      for (const p of projects) {
        if (p.active_container) {
          await execFileP('docker', ['start', p.active_container]).catch((e: any) =>
            warnings.push(`Container ${p.active_container} starten fehlgeschlagen: ${e.message}`)
          );
        }
        await syncProjectRouters(db, p.id).catch((e: any) =>
          warnings.push(`Router fuer ${p.project_slug} wiederherstellen fehlgeschlagen: ${e.message}`)
        );
      }
    }

    await db.query('UPDATE kunden SET status = $1 WHERE slug = $2', [status, slug]);
    await logAudit('tenant.status.set', slug, { status, warnings: warnings.length > 0 ? warnings : undefined });
    res.json({ status, warnings: warnings.length > 0 ? warnings : undefined });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});
