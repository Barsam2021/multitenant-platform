import { Pool } from "pg";
import { decryptCmsPassword, getTenant } from "./configDb";

/**
 * Verbindung zur Datenbank EINES Kunden — als eingeschraenkte Rolle
 * cms_<slug>, nicht als Superuser.
 *
 * Der Unterschied zum Admin-Dashboard ist der Kern des Sicherheitsmodells:
 * das Dashboard verbindet sich als `postgres` und kommt damit ueberall hin,
 * dieser Dienst kommt ausschliesslich an die Tabellen, die im Dashboard
 * ausdruecklich als Sammlung freigegeben wurden (GRANT pro Tabelle, siehe
 * provisioning-agent/src/lib/cms.ts). Selbst ein Fehler in der Anwendungslogik
 * hier kann `auth.users` oder eine nicht freigegebene Tabelle nicht lesen.
 */

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || "pgbouncer";

// Ein Pool pro Tenant, aber klein: core-postgres laeuft mit max_connections=60
// fuer die gesamte Plattform. Redaktionsarbeit ist kein Lastszenario — zwei
// Verbindungen pro Kunde reichen, und der Timeout gibt sie im Leerlauf zurueck.
const pools = new Map<string, Pool>();

export async function getTenantPool(tenantSlug: string): Promise<Pool> {
  // Der Slug kommt aus der Sitzung und stammt damit aus `kunden.slug`, das per
  // CHECK-Constraint ohnehin nur [a-z0-9-] enthaelt. Die Pruefung hier ist
  // trotzdem da, weil aus dem Slug ein Rollenname gebaut wird — dieselbe Regel
  // wie im Agent (routes/cms.ts).
  if (!/^[a-z0-9-]+$/.test(tenantSlug)) throw new Error("ungültiger Mandant");

  const existing = pools.get(tenantSlug);
  if (existing) return existing;

  const tenant = await getTenant(tenantSlug);
  if (!tenant) throw new Error("Kunde nicht gefunden");
  if (!tenant.cms_enabled || !tenant.cms_db_password_encrypted) {
    throw new Error("Das CMS ist für diesen Kunden nicht aktiviert.");
  }
  if (!/^[a-z0-9_]+$/.test(tenant.db_name)) throw new Error("ungültiger Datenbankname");

  const password = decryptCmsPassword(tenant.cms_db_password_encrypted);
  const pool = new Pool({
    host: PGBOUNCER_HOST,
    port: 5432,
    database: tenant.db_name,
    user: `cms_${tenantSlug}`,
    password,
    max: 2,
    idleTimeoutMillis: 30_000,
  });
  pool.on("error", (err) => console.error(`pg pool error (cms_${tenantSlug}):`, err.message));
  pools.set(tenantSlug, pool);
  return pool;
}

/**
 * Nach dem Deaktivieren/Reaktivieren des CMS existiert die Rolle mit einem
 * neuen Passwort — ein Pool mit dem alten waere dauerhaft kaputt. Aufgerufen,
 * wenn eine Verbindung mit Authentifizierungsfehler scheitert.
 */
export async function dropTenantPool(tenantSlug: string): Promise<void> {
  const pool = pools.get(tenantSlug);
  if (!pool) return;
  pools.delete(tenantSlug);
  await pool.end().catch(() => {});
}

const primaryKeyCache = new Map<string, string>();

/**
 * Primaerschluessel-Spalte einer Tabelle. Ohne sie laesst sich keine Zeile
 * gezielt bearbeiten oder loeschen.
 *
 * Zusammengesetzte Schluessel werden bewusst nicht unterstuetzt: die Formulare
 * und URLs muessten dafuer ueberall mehrere Werte durchreichen, und
 * CMS-taugliche Inhaltstabellen haben praktisch immer einen einspaltigen
 * Schluessel. Wo nicht, sagt der Fehler das klar, statt halb zu funktionieren.
 */
export async function getPrimaryKeyColumn(tenantSlug: string, table: string): Promise<string> {
  const cacheKey = `${tenantSlug}.${table}`;
  const cached = primaryKeyCache.get(cacheKey);
  if (cached) return cached;

  const pool = await getTenantPool(tenantSlug);
  const { rows } = await pool.query<{ column_name: string }>(
    `SELECT a.attname AS column_name
     FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = format('public.%I', $1::text)::regclass AND i.indisprimary`,
    [table]
  );
  if (rows.length === 0) {
    throw new Error(`Die Tabelle "${table}" hat keinen Primärschlüssel — Bearbeiten ist damit nicht möglich.`);
  }
  if (rows.length > 1) {
    throw new Error(`Die Tabelle "${table}" hat einen zusammengesetzten Primärschlüssel — das unterstützt das CMS nicht.`);
  }
  primaryKeyCache.set(cacheKey, rows[0].column_name);
  return rows[0].column_name;
}
