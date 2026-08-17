import format from "pg-format";
import sanitizeHtml from "sanitize-html";
import { Field } from "./configDb";
import { getPrimaryKeyColumn, getTenantPool } from "./tenantDb";

/**
 * Lesen und Schreiben in den Inhaltstabellen des Kunden.
 *
 * Regel, die dieses Modul durchhaelt: Tabellen- und Spaltennamen stammen
 * AUSSCHLIESSLICH aus der Konfiguration (cms_collections/cms_fields), nie aus
 * dem Request, und werden ueber pg-format %I gesetzt. Werte gehen immer
 * parametrisiert. Ein Feldname aus einem Formular, den die Konfiguration nicht
 * kennt, wird verworfen — nicht durchgereicht.
 */

const MAX_PAGE_SIZE = 100;

export interface ListResult {
  rows: Record<string, unknown>[];
  total: number;
  primaryKey: string;
}

export async function listRows(
  tenantSlug: string,
  table: string,
  fields: Field[],
  opts: { limit: number; offset: number; sortColumn?: string | null; sortDir?: "asc" | "desc"; search?: string }
): Promise<ListResult> {
  const pool = await getTenantPool(tenantSlug);
  const primaryKey = await getPrimaryKeyColumn(tenantSlug, table);

  const knownColumns = new Set(fields.map((f) => f.column_name));
  const selectColumns = fields.filter((f) => f.visible_list).map((f) => f.column_name);
  if (!selectColumns.includes(primaryKey)) selectColumns.unshift(primaryKey);

  const columnsSql = selectColumns.map((c) => format("%I", c)).join(", ");

  // Suche ueber alle sichtbaren Textspalten. ILIKE auf ::text funktioniert
  // auch fuer Zahlen und Datumswerte, ohne pro Typ eine Sonderbehandlung.
  const params: unknown[] = [];
  let whereSql = "";
  if (opts.search?.trim()) {
    const term = `%${opts.search.trim()}%`;
    const searchable = fields.filter((f) => f.visible_list && f.field_type !== "toggle");
    if (searchable.length > 0) {
      params.push(term);
      whereSql = `WHERE ${searchable.map((f) => format("%I::text ILIKE $1", f.column_name)).join(" OR ")}`;
    }
  }

  const sortColumn = opts.sortColumn && knownColumns.has(opts.sortColumn) ? opts.sortColumn : primaryKey;
  const sortDir = opts.sortDir === "asc" ? "ASC" : "DESC";
  // LIMIT/OFFSET werden direkt in die Query geschrieben (Postgres erlaubt dort
  // keine Parameter in jeder Position) — deshalb muessen es garantiert Zahlen
  // sein und nicht NaN, das als Text im SQL landen wuerde.
  const limit = Number.isFinite(opts.limit) ? Math.min(Math.max(1, Math.trunc(opts.limit)), MAX_PAGE_SIZE) : 25;
  const offset = Number.isFinite(opts.offset) ? Math.max(0, Math.trunc(opts.offset)) : 0;

  const { rows } = await pool.query(
    `SELECT ${columnsSql} FROM public.${format("%I", table)} ${whereSql}
     ORDER BY ${format("%I", sortColumn)} ${sortDir}
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::bigint AS total FROM public.${format("%I", table)} ${whereSql}`,
    params
  );

  return { rows, total: Number(countRows[0]?.total || 0), primaryKey };
}

export async function getRow(
  tenantSlug: string,
  table: string,
  fields: Field[],
  pkValue: string
): Promise<Record<string, unknown> | null> {
  const pool = await getTenantPool(tenantSlug);
  const primaryKey = await getPrimaryKeyColumn(tenantSlug, table);
  const columns = [...new Set([primaryKey, ...fields.map((f) => f.column_name)])];
  const columnsSql = columns.map((c) => format("%I", c)).join(", ");

  // $1::text-Vergleich, damit derselbe Code fuer uuid-, integer- und
  // text-Schluessel funktioniert, ohne den Typ zu kennen.
  const { rows } = await pool.query(
    `SELECT ${columnsSql} FROM public.${format("%I", table)} WHERE ${format("%I", primaryKey)}::text = $1 LIMIT 1`,
    [pkValue]
  );
  return rows[0] ?? null;
}

/**
 * Formularwert -> Datenbankwert.
 *
 * Formulare liefern ausschliesslich Strings. Ein leeres Feld wird zu NULL und
 * nicht zum leeren String: "kein Wert" ist in einer Datenbank NULL, und eine
 * Datums- oder Zahlenspalte wuerde einen leeren String ohnehin ablehnen.
 */
function coerce(field: Field, raw: unknown): unknown {
  if (raw === undefined) return undefined;
  if (raw === null) return null;

  const value = typeof raw === "string" ? raw : String(raw);

  switch (field.field_type) {
    case "toggle":
      return raw === true || value === "true" || value === "on" || value === "1";
    case "number": {
      if (value.trim() === "") return null;
      const num = Number(value.replace(",", "."));
      if (Number.isNaN(num)) throw new Error(`"${field.label}": keine gültige Zahl`);
      return num;
    }
    case "json": {
      if (value.trim() === "") return null;
      try {
        return JSON.parse(value);
      } catch {
        throw new Error(`"${field.label}": kein gültiges JSON`);
      }
    }
    case "richtext": {
      if (value.trim() === "") return null;
      // Der Text landet auf der Seite des Kunden, unter seiner Domain.
      // Gespeichertes XSS waere dort ein echtes Problem, kein theoretisches —
      // deshalb serverseitig bereinigen, nicht im Browser.
      return sanitizeHtml(value, {
        allowedTags: [
          "p", "br", "strong", "b", "em", "i", "u", "s", "blockquote", "code", "pre",
          "h2", "h3", "h4", "ul", "ol", "li", "a", "img", "hr", "table", "thead",
          "tbody", "tr", "th", "td",
        ],
        allowedAttributes: {
          a: ["href", "title", "target", "rel"],
          img: ["src", "alt", "title", "width", "height"],
        },
        allowedSchemes: ["http", "https", "mailto"],
        transformTags: {
          // Fremde Ziele ohne noopener sind ein Tabnabbing-Vektor.
          a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }),
        },
      });
    }
    case "select":
    case "text":
    case "textarea":
    case "slug":
    case "image":
    case "file":
    case "date":
    case "datetime":
    default:
      return value.trim() === "" ? null : value;
  }
}

/** Felder, die ein Formular ueberhaupt schreiben darf. */
function writableFields(fields: Field[]): Field[] {
  return fields.filter((f) => f.visible_form && !f.readonly);
}

function validate(fields: Field[], values: Record<string, unknown>, partial: boolean): void {
  for (const field of fields) {
    if (!field.required) continue;
    const value = values[field.column_name];
    if (partial && value === undefined) continue;
    if (value === null || value === undefined || value === "") {
      throw new Error(`"${field.label}" ist ein Pflichtfeld.`);
    }
    if (field.options?.maxLength && typeof value === "string" && value.length > field.options.maxLength) {
      throw new Error(`"${field.label}" ist zu lang (maximal ${field.options.maxLength} Zeichen).`);
    }
    if (field.field_type === "select" && field.options?.choices?.length) {
      if (typeof value === "string" && !field.options.choices.includes(value)) {
        throw new Error(`"${field.label}": ungültige Auswahl.`);
      }
    }
  }
}

export async function insertRow(
  tenantSlug: string,
  table: string,
  fields: Field[],
  input: Record<string, unknown>
): Promise<string> {
  const pool = await getTenantPool(tenantSlug);
  const primaryKey = await getPrimaryKeyColumn(tenantSlug, table);

  const values: Record<string, unknown> = {};
  for (const field of writableFields(fields)) {
    const coerced = coerce(field, input[field.column_name]);
    if (coerced !== undefined) values[field.column_name] = coerced;
  }
  validate(writableFields(fields), values, false);

  const columns = Object.keys(values);
  if (columns.length === 0) throw new Error("Es gibt nichts zu speichern.");

  const columnsSql = columns.map((c) => format("%I", c)).join(", ");
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await pool.query(
    `INSERT INTO public.${format("%I", table)} (${columnsSql}) VALUES (${placeholders})
     RETURNING ${format("%I", primaryKey)}::text AS pk`,
    columns.map((c) => values[c])
  );
  return rows[0].pk;
}

export async function updateRow(
  tenantSlug: string,
  table: string,
  fields: Field[],
  pkValue: string,
  input: Record<string, unknown>
): Promise<boolean> {
  const pool = await getTenantPool(tenantSlug);
  const primaryKey = await getPrimaryKeyColumn(tenantSlug, table);

  const values: Record<string, unknown> = {};
  for (const field of writableFields(fields)) {
    const coerced = coerce(field, input[field.column_name]);
    if (coerced !== undefined) values[field.column_name] = coerced;
  }
  validate(writableFields(fields), values, true);

  const columns = Object.keys(values);
  if (columns.length === 0) throw new Error("Es gibt nichts zu speichern.");

  const sets = columns.map((c, i) => `${format("%I", c)} = $${i + 1}`).join(", ");
  const { rowCount } = await pool.query(
    `UPDATE public.${format("%I", table)} SET ${sets}
     WHERE ${format("%I", primaryKey)}::text = $${columns.length + 1}`,
    [...columns.map((c) => values[c]), pkValue]
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteRow(tenantSlug: string, table: string, pkValue: string): Promise<boolean> {
  const pool = await getTenantPool(tenantSlug);
  const primaryKey = await getPrimaryKeyColumn(tenantSlug, table);
  const { rowCount } = await pool.query(
    `DELETE FROM public.${format("%I", table)} WHERE ${format("%I", primaryKey)}::text = $1`,
    [pkValue]
  );
  return (rowCount ?? 0) > 0;
}
