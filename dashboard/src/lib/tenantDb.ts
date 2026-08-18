import { Pool, QueryResult } from "pg";
import format from "pg-format";

const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;
const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || "pgbouncer";

// Ein Pool pro Tenant-DB, wiederverwendet über Requests hinweg (Next.js-Server-Prozess
// lebt dauerhaft). Verbindet als 'postgres'-Superuser -> Table Editor braucht vollen
// Zugriff (Schema lesen, DDL perspektivisch), anders als der eingeschränkte
// 'authenticator'-Role, den PostgREST/GoTrue nutzen (siehe .env.example § Secrets).
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
     WHERE i.indrelid = format('public.%I', $1::text)::regclass AND i.indisprimary`,
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

export interface GetRowsOptions {
  limit: number;
  offset: number;
  /** Spaltenname oder "ctid" (nur bei PK-losen Tabellen gueltig). */
  orderBy?: string;
  orderDir?: "asc" | "desc";
  /** Spalte -> Suchtext, als ILIKE-Teilstringsuche angewandt (P2-2). */
  filters?: Record<string, string>;
}

export async function getRows(
  dbName: string,
  table: string,
  opts: GetRowsOptions
): Promise<{
  rows: Record<string, unknown>[];
  columns: ColumnInfo[];
  totalCount: number;
  hasPrimaryKey: boolean;
}> {
  const pool = getTenantPool(dbName);
  const columns = await getTableColumns(dbName, table);
  const hasPrimaryKey = columns.some((c) => c.isPrimaryKey);
  const validColNames = new Set(columns.map((c) => c.name));

  const whereParts: string[] = [];
  for (const [col, value] of Object.entries(opts.filters ?? {})) {
    if (!validColNames.has(col) || !value) continue;
    whereParts.push(format("%I::text ILIKE %L", col, `%${value}%`));
  }
  const whereSql = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

  // orderBy ist entweder eine echte Spalte oder "ctid" - und "ctid" nur, wenn
  // die Tabelle keinen echten PK hat (sonst gibt's keinen Grund, danach zu sortieren).
  let orderSql = "";
  if (opts.orderBy && (validColNames.has(opts.orderBy) || (opts.orderBy === "ctid" && !hasPrimaryKey))) {
    const dir = opts.orderDir === "desc" ? "DESC" : "ASC";
    orderSql = `ORDER BY ${format("%I", opts.orderBy)} ${dir}`;
  }

  const limit = Number.isFinite(opts.limit) ? Math.max(0, Math.min(500, Math.trunc(opts.limit))) : 50;
  const offset = Number.isFinite(opts.offset) ? Math.max(0, Math.trunc(opts.offset)) : 0;

  // PK-lose Tabellen: ctid als Fallback-Identifier mitliefern (P2-2). ctid
  // verschiebt sich bei VACUUM FULL / manchen UPDATEs - fuer eine Admin-UI
  // zwischen zwei Requests ausreichend stabil, im Frontend mit Warnhinweis.
  const selectCols = hasPrimaryKey ? "*" : "*, ctid::text AS __ctid";
  const tableRef = format("%I.%I", "public", table);

  const sql = `SELECT ${selectCols} FROM ${tableRef} ${whereSql} ${orderSql} LIMIT ${limit} OFFSET ${offset}`;
  const { rows } = await pool.query(sql);

  const countSql = `SELECT count(*)::bigint AS n FROM ${tableRef} ${whereSql}`;
  const { rows: countRows } = await pool.query<{ n: string }>(countSql);
  const totalCount = Number(countRows[0]?.n ?? 0);

  return { rows, columns, totalCount, hasPrimaryKey };
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

// "__ctid" ist der Sentinel-Wert, den das Frontend als pkColumn schickt, wenn
// die Tabelle keinen echten Primary Key hat (P2-2 Fallback). ctid ist kein
// normales Feld in information_schema, deshalb hier per Sonderfall behandelt
// statt ueber die generische %I-Spalten-Identifizierung.
function whereClauseFor(pkColumn: string, paramIndex: number): string {
  if (pkColumn === "__ctid") {
    return format("ctid = $%s::tid", paramIndex);
  }
  return format("%I = $%s", pkColumn, paramIndex);
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
  const sql = `UPDATE ${format("%I.%I", "public", table)} SET ${setClauses} WHERE ${whereClauseFor(
    pkColumn,
    cols.length + 1
  )} RETURNING *`;
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
  const sql = `DELETE FROM ${format("%I.%I", "public", table)} WHERE ${whereClauseFor(pkColumn, 1)}`;
  await pool.query(sql, [pkValue]);
}

export interface RunSqlResult {
  rows: Record<string, unknown>[];
  fields: string[];
  rowCount: number;
  durationMs: number;
  truncated: boolean;
}

const SQL_STATEMENT_TIMEOUT_MS = 30_000;
const SQL_MAX_ROWS = 1000;

// Wenn die Eingabe (nach optionalem Schluss-Semikolon) EIN einzelnes SELECT/WITH
// ist, wird sie als Subquery mit LIMIT gewrappt - das begrenzt bereits, was
// Postgres liefert, statt erst hinterher im Node-Prozess zu kuerzen (P2-3:
// verhindert den OOM-Fall aus der Gap-Analyse bei "SELECT * FROM grosse_tabelle").
// Bei Mehrfach-Statements oder Nicht-SELECT (INSERT/UPDATE/DDL/...) greift nur
// noch der statement_timeout plus eine Kuerzung der Antwort selbst - echter
// DB-seitiger Schutz ist dort nicht moeglich, ohne die Query zu parsen.
function tryWrapWithLimit(sql: string, maxRows: number): { sql: string; applied: boolean } {
  const trimmed = sql.trim();
  const withoutTrailingSemi = trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed;
  const hasInnerSemicolon = withoutTrailingSemi.includes(";");
  const startsWithSelectOrWith = /^(select|with)\b/i.test(withoutTrailingSemi);
  if (hasInnerSemicolon || !startsWithSelectOrWith) {
    return { sql, applied: false };
  }
  return {
    sql: `SELECT * FROM (\n${withoutTrailingSemi}\n) AS __sql_editor_limited LIMIT ${maxRows + 1}`,
    applied: true,
  };
}

// SQL-Editor: freie Query-Ausführung. Bewusst ohne Statement-Whitelist -
// Dashboard ist single-admin-only (Cloudflare Zero Trust + NextAuth davor),
// analog zum echten Supabase SQL Editor. statement_timeout und READ ONLY
// werden auf einem dedizierten Client gesetzt (nicht ueber pool.query, das
// wuerde die Session-Einstellung an spaeteren, unabhaengigen Requests
// haengen lassen, die denselben Pool-Client zurueckbekommen) und per
// RESET ALL vor der Rueckgabe an den Pool wieder entfernt.
export async function runSql(
  dbName: string,
  sql: string,
  opts: { readOnly?: boolean; maxRows?: number } = {}
): Promise<RunSqlResult> {
  const pool = getTenantPool(dbName);
  const client = await pool.connect();
  const maxRows = opts.maxRows ?? SQL_MAX_ROWS;
  const start = Date.now();
  try {
    await client.query(`SET statement_timeout = ${SQL_STATEMENT_TIMEOUT_MS}`);
    if (opts.readOnly) {
      await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    }
    const { sql: effectiveSql, applied } = tryWrapWithLimit(sql, maxRows);
    const result: QueryResult = await client.query(effectiveSql);
    const durationMs = Date.now() - start;
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const dbSideTruncated = applied && rows.length > maxRows;
    const outputTruncated = !applied && rows.length > maxRows;
    return {
      rows: dbSideTruncated || outputTruncated ? rows.slice(0, maxRows) : rows,
      fields: result.fields?.map((f) => f.name) ?? [],
      rowCount: result.rowCount ?? rows.length,
      durationMs,
      truncated: dbSideTruncated || outputTruncated,
    };
  } finally {
    try {
      await client.query("RESET ALL");
    } catch {
      // Verbindung ist evtl. durch den Timeout/Fehler schon kaputt - dann
      // kommt der Pool-Client beim naechsten Connect ohnehin frisch.
    }
    client.release();
  }
}
