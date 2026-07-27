import { Pool, QueryResult } from "pg";
import format from "pg-format";

const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;
const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || "pgbouncer";

// Ein Pool pro Tenant-DB, wiederverwendet über Requests hinweg (Next.js-Server-Prozess
// lebt dauerhaft). Verbindet als 'postgres'-Superuser -> Table Editor braucht vollen
// Zugriff (Schema lesen, DDL perspektivisch), anders als der eingeschränkte
// 'authenticator'-Role, den PostgREST/GoTrue nutzen (siehe 10_env_reference.md § 4).
const tenantPools = new Map<string, Pool>();

function getTenantPool(dbName: string): Pool {
  if (!/^[a-z0-9_]+$/.test(dbName)) {
    throw new Error("invalid db name");
  }
  let pool = tenantPools.get(dbName);
  if (!pool) {
    pool = new Pool({
      connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/${dbName}`,
      max: 3,
    });
    tenantPools.set(dbName, pool);
  }
  return pool;
}

export interface TableInfo {
  name: string;
  rowEstimate: number;
}

export async function listTables(dbName: string): Promise<TableInfo[]> {
  const pool = getTenantPool(dbName);
  const { rows } = await pool.query<{ table_name: string; row_estimate: string }>(
    `SELECT c.relname AS table_name, GREATEST(c.reltuples, 0)::bigint AS row_estimate
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname`
  );
  return rows.map((r) => ({ name: r.table_name, rowEstimate: Number(r.row_estimate) }));
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
  columnDefault: string | null;
}

export async function getTableColumns(dbName: string, table: string): Promise<ColumnInfo[]> {
  const pool = getTenantPool(dbName);
  const { rows: cols } = await pool.query(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table]
  );
  const { rows: pk } = await pool.query(
    `SELECT a.attname AS column_name
     FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = format('public.%I', $1)::regclass AND i.indisprimary`,
    [table]
  );
  const pkNames = new Set(pk.map((r) => r.column_name));
  return cols.map((c) => ({
    name: c.column_name,
    dataType: c.data_type,
    isNullable: c.is_nullable === "YES",
    isPrimaryKey: pkNames.has(c.column_name),
    columnDefault: c.column_default,
  }));
}

export async function getRows(
  dbName: string,
  table: string,
  limit: number,
  offset: number
): Promise<{ rows: Record<string, unknown>[]; columns: ColumnInfo[] }> {
  const pool = getTenantPool(dbName);
  const columns = await getTableColumns(dbName, table);
  const sql = format("SELECT * FROM %I.%I LIMIT %L OFFSET %L", "public", table, limit, offset);
  const { rows } = await pool.query(sql);
  return { rows, columns };
}

export async function insertRow(
  dbName: string,
  table: string,
  values: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const pool = getTenantPool(dbName);
  const cols = Object.keys(values);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const sql = format(
    "INSERT INTO %I.%I (%s) VALUES (%s) RETURNING *",
    "public",
    table,
    cols.map((c) => format("%I", c)).join(", "),
    placeholders.join(", ")
  );
  const { rows } = await pool.query<Record<string, unknown>>(sql, Object.values(values));
  return rows[0];
}

export async function updateRow(
  dbName: string,
  table: string,
  pkColumn: string,
  pkValue: unknown,
  values: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const pool = getTenantPool(dbName);
  const cols = Object.keys(values);
  const setClauses = cols.map((c, i) => format("%I = $%s", c, i + 1)).join(", ");
  const sql = format(
    "UPDATE %I.%I SET %s WHERE %I = $%s RETURNING *",
    "public",
    table,
    setClauses,
    pkColumn,
    cols.length + 1
  );
  const { rows } = await pool.query<Record<string, unknown>>(sql, [
    ...Object.values(values),
    pkValue,
  ]);
  return rows[0];
}

export async function deleteRow(
  dbName: string,
  table: string,
  pkColumn: string,
  pkValue: unknown
): Promise<void> {
  const pool = getTenantPool(dbName);
  const sql = format("DELETE FROM %I.%I WHERE %I = $1", "public", table, pkColumn);
  await pool.query(sql, [pkValue]);
}

// SQL-Editor: freie Query-Ausführung. Bewusst ohne Statement-Whitelist -
// Dashboard ist single-admin-only (Cloudflare Zero Trust + NextAuth davor),
// analog zum echten Supabase SQL Editor.
export async function runSql(dbName: string, sql: string): Promise<QueryResult> {
  const pool = getTenantPool(dbName);
  return pool.query(sql);
}
