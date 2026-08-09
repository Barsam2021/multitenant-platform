import { Pool } from "pg";

// Verbindung zur admin_dashboard-DB. Läuft über pgbouncer, siehe .env.example
// (DATABASE_URL) und SETUP.md Schritt 2.
let adminPool: Pool | null = null;

function getAdminPool(): Pool {
  if (!adminPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL fehlt (siehe .env.example und SETUP.md Schritt 2)");
    }
    adminPool = new Pool({ connectionString, max: 5 });
  }
  return adminPool;
}

export interface Tenant {
  id: string;
  slug: string;
  db_name: string;
  tariff: string;
  display_name: string | null;
  contact_email: string | null;
  status: string;
  notes: string | null;
  created_at: string;
}

export async function listTenants(): Promise<Tenant[]> {
  const pool = getAdminPool();
  const { rows } = await pool.query<Tenant>(
    "SELECT id, slug, db_name, tariff, display_name, contact_email, status, notes, created_at FROM kunden ORDER BY created_at DESC"
  );
  return rows;
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const pool = getAdminPool();
  const { rows } = await pool.query<Tenant>(
    "SELECT id, slug, db_name, tariff, display_name, contact_email, status, notes, created_at FROM kunden WHERE slug = $1",
    [slug]
  );
  return rows[0] ?? null;
}

export interface SavedQuery {
  id: string;
  tenant_slug: string;
  name: string;
  sql_text: string;
  created_at: string;
}

// P2-3: Gespeicherte SQL-Editor-Abfragen pro Tenant.
export async function listSavedQueries(tenantSlug: string): Promise<SavedQuery[]> {
  const pool = getAdminPool();
  const { rows } = await pool.query<SavedQuery>(
    "SELECT id, tenant_slug, name, sql_text, created_at FROM saved_queries WHERE tenant_slug = $1 ORDER BY created_at DESC",
    [tenantSlug]
  );
  return rows;
}

export async function saveQuery(tenantSlug: string, name: string, sqlText: string): Promise<SavedQuery> {
  const pool = getAdminPool();
  const { rows } = await pool.query<SavedQuery>(
    "INSERT INTO saved_queries (tenant_slug, name, sql_text) VALUES ($1, $2, $3) RETURNING id, tenant_slug, name, sql_text, created_at",
    [tenantSlug, name, sqlText]
  );
  return rows[0];
}

export async function deleteSavedQuery(id: string, tenantSlug: string): Promise<void> {
  const pool = getAdminPool();
  await pool.query("DELETE FROM saved_queries WHERE id = $1 AND tenant_slug = $2", [id, tenantSlug]);
}
