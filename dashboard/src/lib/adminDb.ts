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
  /** Migration 19: laufen api-/auth-Container fuer diesen Tenant? */
  db_enabled: boolean;
  /** Migration 19: existiert ueberhaupt eine Datenbank (dann liegen dort Daten)? */
  db_provisioned: boolean;
  created_at: string;
}

/**
 * Migration 19: Tabellen-/SQL-Editor brauchen eine EXISTIERENDE Datenbank,
 * nicht laufende Container. Das Dashboard verbindet sich als postgres-Superuser
 * direkt ueber PgBouncer (siehe lib/tenantDb.ts) — PostgREST und GoTrue sind
 * daran unbeteiligt. Ein Kunde mit db_provisioned=true, db_enabled=false kann
 * seine Daten hier also weiterhin einsehen und bearbeiten; nur seine App kommt
 * nicht mehr an die API.
 */
export function hasTenantDatabase(tenant: Tenant): boolean {
  return tenant.db_provisioned;
}

export const NO_TENANT_DATABASE_ERROR =
  "Für diesen Kunden wurde nie eine Datenbank angelegt. Im Tab „Übersicht“ unter „Datenbank & Auth“ einschalten.";

const TENANT_COLUMNS =
  "id, slug, db_name, tariff, display_name, contact_email, status, notes, db_enabled, db_provisioned, created_at";

export async function listTenants(): Promise<Tenant[]> {
  const pool = getAdminPool();
  const { rows } = await pool.query<Tenant>(
    `SELECT ${TENANT_COLUMNS} FROM kunden ORDER BY created_at DESC`
  );
  return rows;
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const pool = getAdminPool();
  const { rows } = await pool.query<Tenant>(
    `SELECT ${TENANT_COLUMNS} FROM kunden WHERE slug = $1`,
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
