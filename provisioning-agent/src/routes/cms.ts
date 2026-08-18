import { Router } from 'express';
import { Client as PGClient } from 'pg';
import { logAudit } from '../lib/audit';
import {
  ensureCmsRole,
  dropCmsRole,
  encryptForCms,
  grantTable,
  revokeTable,
  describeTenantTable,
  listTenantTables,
  publishTenantMediaPrefix,
  unpublishTenantMediaPrefix,
  reloadPostgrestSchema,
} from '../lib/cms';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

function adminClient(): PGClient {
  const client = new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
  client.on('error', (err) => console.error('pg client error (cms route):', err.message));
  return client;
}

export const cmsRouter = Router();

const SLUG_RE = /^[a-z0-9-]+$/;
// Tabellennamen aus dem Request landen ausschliesslich ueber pg-format %I in
// SQL (lib/cms.ts), werden hier aber trotzdem streng geprueft — doppelt, weil
// dieser Endpunkt Rechte vergibt (CLAUDE.md § 1.1/2.3).
const TABLE_RE = /^[a-z_][a-z0-9_]*$/;

async function loadTenant(db: PGClient, slug: string) {
  const { rows } = await db.query(
    'SELECT slug, db_name, db_provisioned, cms_enabled FROM kunden WHERE slug = $1',
    [slug]
  );
  return rows[0] || null;
}

// POST /tenants/:slug/cms  { enabled: boolean }
//
// Aktivieren legt die eingeschraenkte Rolle cms_<slug> an und hinterlegt ihr
// Passwort verschluesselt. Deaktivieren entfernt die Rolle wieder — die
// Konfiguration (Collections, Felder, Redakteure) bleibt bestehen, damit ein
// erneutes Aktivieren nicht bei null anfaengt.
cmsRouter.post('/tenants/:slug/cms', async (req, res) => {
  const { slug } = req.params;
  const { enabled } = req.body;
  if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'invalid slug' });
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });

  const db = adminClient();
  await db.connect();
  try {
    const tenant = await loadTenant(db, slug);
    if (!tenant) return res.status(404).json({ error: 'tenant not found' });

    // Das CMS braucht eine EXISTIERENDE Datenbank, aber keine laufenden
    // Container: es spricht direkt ueber PgBouncer mit Postgres, PostgREST und
    // GoTrue sind unbeteiligt. Ein Kunde mit db_enabled=false kann also
    // trotzdem ein CMS haben — Inhalte pflegen, statische Seite bauen.
    if (enabled && !tenant.db_provisioned) {
      return res.status(409).json({
        error:
          `Tenant "${slug}" hat keine Datenbank. Erst unter "Datenbank & Auth" einschalten — ` +
          `das CMS speichert die Inhalte in den Tabellen dieser Datenbank.`,
      });
    }

    if (enabled) {
      const password = await ensureCmsRole(slug, tenant.db_name);
      await db.query('UPDATE kunden SET cms_enabled = true, cms_db_password_encrypted = $1 WHERE slug = $2', [
        encryptForCms(password),
        slug,
      ]);
      // Bereits konfigurierte Collections wieder freischalten — nach einem
      // Abschalten ist die Rolle weg und mit ihr alle Tabellenrechte.
      const { rows: collections } = await db.query(
        'SELECT table_name FROM cms_collections WHERE tenant_slug = $1',
        [slug]
      );
      const warnings: string[] = [];
      for (const c of collections) {
        await grantTable(slug, tenant.db_name, c.table_name).catch((e: any) =>
          warnings.push(`Rechte auf ${c.table_name}: ${e.message}`)
        );
      }
      // Medien-Praefix oeffentlich lesbar machen. Best effort: schlaegt es
      // fehl, funktioniert das CMS vollstaendig — nur hochgeladene Bilder
      // liefern 403. Das als Warnung zu melden ist deutlich besser, als das
      // Aktivieren daran scheitern zu lassen.
      await publishTenantMediaPrefix(slug).catch((e: any) =>
        warnings.push(
          `Medien-Freigabe fehlgeschlagen (${e.message}) — hochgeladene Bilder sind nicht abrufbar. ` +
          `Manuell: mc anonymous set download localminio/kunde-${slug}-storage/public`
        )
      );

      await reloadPostgrestSchema(slug);
      await logAudit('cms.enabled', slug, { collections: collections.length, warnings });
      return res.json({ status: 'ok', enabled: true, warnings: warnings.length ? warnings : undefined });
    }

    await dropCmsRole(slug, tenant.db_name);
    // Die Dateien selbst bleiben liegen (sie gehoeren dem Kunden), aber
    // oeffentlich abrufbar muessen sie nicht bleiben, wenn niemand mehr ein CMS
    // hat, das darauf verweist.
    await unpublishTenantMediaPrefix(slug).catch((e: any) =>
      console.error(`Medien-Freigabe fuer ${slug} zuruecknehmen fehlgeschlagen:`, e.message)
    );
    await db.query(
      'UPDATE kunden SET cms_enabled = false, cms_db_password_encrypted = NULL WHERE slug = $1',
      [slug]
    );
    await logAudit('cms.disabled', slug, {});
    res.json({ status: 'ok', enabled: false });
  } catch (err: any) {
    console.error(`CMS-Umschaltung fuer "${slug}" fehlgeschlagen:`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// GET /tenants/:slug/cms/tables — Kandidaten fuer neue Collections.
cmsRouter.get('/tenants/:slug/cms/tables', async (req, res) => {
  const { slug } = req.params;
  if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'invalid slug' });

  const db = adminClient();
  await db.connect();
  try {
    const tenant = await loadTenant(db, slug);
    if (!tenant) return res.status(404).json({ error: 'tenant not found' });
    if (!tenant.db_provisioned) return res.json({ tables: [], reason: 'Tenant hat keine Datenbank.' });

    const tables = await listTenantTables(tenant.db_name);
    const { rows: used } = await db.query('SELECT table_name FROM cms_collections WHERE tenant_slug = $1', [slug]);
    const usedSet = new Set(used.map((r) => r.table_name));
    res.json({ tables: tables.map((t) => ({ ...t, alreadyCollection: usedSet.has(t.name) })) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// GET /tenants/:slug/cms/tables/:table/columns — Spalten samt allem, woraus
// sich ein Feldtyp ableiten laesst. Das Dashboard baut daraus die Vorbelegung
// der Felder beim Anlegen einer Collection.
cmsRouter.get('/tenants/:slug/cms/tables/:table/columns', async (req, res) => {
  const { slug, table } = req.params;
  if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'invalid slug' });
  if (!TABLE_RE.test(table)) return res.status(400).json({ error: 'invalid table name' });

  const db = adminClient();
  await db.connect();
  try {
    const tenant = await loadTenant(db, slug);
    if (!tenant) return res.status(404).json({ error: 'tenant not found' });
    if (!tenant.db_provisioned) return res.status(409).json({ error: 'Tenant hat keine Datenbank.' });

    const columns = await describeTenantTable(tenant.db_name, table);
    res.json({ columns });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// POST /tenants/:slug/cms/grant  { table }   — Tabellenrechte fuer cms_<slug>
// POST /tenants/:slug/cms/revoke { table }
//
// Bewusst eigene Endpunkte statt einer Nebenwirkung des Collection-Anlegens:
// die Collection-Verwaltung liegt im Dashboard (das schreibt direkt in
// admin_dashboard), die Rechtevergabe hier — sie braucht den Superuser-Zugang
// zur Tenant-DB, den nur der Agent haben soll.
async function handleGrantOrRevoke(
  req: import('express').Request,
  res: import('express').Response,
  action: 'grant' | 'revoke'
) {
  const { slug } = req.params;
  const { table } = req.body;
  if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'invalid slug' });
  if (typeof table !== 'string' || !TABLE_RE.test(table)) {
    return res.status(400).json({ error: 'invalid table name' });
  }

  const db = adminClient();
  await db.connect();
  try {
    const tenant = await loadTenant(db, slug);
    if (!tenant) return res.status(404).json({ error: 'tenant not found' });
    if (!tenant.cms_enabled) return res.status(409).json({ error: `CMS ist fuer "${slug}" nicht aktiviert.` });

    if (action === 'grant') {
      await grantTable(slug, tenant.db_name, table);
    } else {
      await revokeTable(slug, tenant.db_name, table);
    }
    // Geaenderte Rechte aendern, was PostgREST ueberhaupt anzeigt — ohne
    // Reload bleibt die Tabelle fuer die Kunden-API unsichtbar bzw. sichtbar,
    // je nach Richtung, bis der Container irgendwann neu startet.
    await reloadPostgrestSchema(slug);
    await logAudit(`cms.${action}`, slug, { table });
    res.json({ status: 'ok', table, action });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
}

cmsRouter.post('/tenants/:slug/cms/grant', (req, res) => handleGrantOrRevoke(req, res, 'grant'));
cmsRouter.post('/tenants/:slug/cms/revoke', (req, res) => handleGrantOrRevoke(req, res, 'revoke'));
