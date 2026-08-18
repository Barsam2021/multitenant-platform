import { Pool } from "pg";
import bcrypt from "bcryptjs";

// Konfiguration des CMS-Moduls (siehe docs/CMS-PLAN.md und Migration 21).
//
// Aufgabenteilung, bewusst so geschnitten:
//   - HIER (Dashboard): Collections, Felder, Redakteure — reine Metadaten in
//     admin_dashboard, dieselbe DB, mit der das Dashboard ohnehin arbeitet.
//   - Provisioning Agent: die DB-Rolle cms_<slug> und ihre Tabellenrechte. Das
//     braucht Superuser-Zugriff auf die Tenant-DB und den Umgang mit einem
//     Verschluesselungs-Key — beides gehoert nicht ins Dashboard.
// Beim Anlegen/Entfernen einer Collection ruft die API-Route deshalb zusaetzlich
// den Agent (POST /tenants/:slug/cms/grant bzw. /revoke).

let pool: Pool | null = null;
function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL fehlt (siehe .env.example)");
    pool = new Pool({ connectionString, max: 5 });
  }
  return pool;
}

export interface CmsCollection {
  id: string;
  tenant_slug: string;
  table_name: string;
  label: string;
  label_singular: string | null;
  sort_column: string | null;
  sort_dir: "asc" | "desc";
  can_create: boolean;
  can_delete: boolean;
  position: number;
}

export interface CmsField {
  id: string;
  collection_id: string;
  column_name: string;
  label: string;
  field_type: string;
  help_text: string | null;
  required: boolean;
  visible_list: boolean;
  visible_form: boolean;
  readonly: boolean;
  options: Record<string, unknown> | null;
  position: number;
}

export interface CmsUser {
  id: string;
  tenant_slug: string;
  email: string;
  display_name: string | null;
  role: string;
  disabled: boolean;
  last_login_at: string | null;
  created_at: string;
}

export interface TenantColumn {
  name: string;
  dataType: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
  hasDefault: boolean;
  isIdentity: boolean;
  maxLength: number | null;
  enumValues: string[] | null;
  checkValues: string[] | null;
}

/**
 * Vorbelegung eines Feldes aus der Spaltendefinition.
 *
 * Bewusst nur ein VORSCHLAG beim Anlegen der Collection: danach ist die
 * Feldkonfiguration ein eigener Datensatz und nicht mehr an das Schema
 * gekoppelt. Ändert der Kunde später den Spaltentyp, bleibt die
 * CMS-Darstellung, bis sie jemand anfasst — das ist gewollt, ein automatisches
 * Zurücksetzen würde Beschriftungen und Ausblendungen stillschweigend
 * überschreiben.
 */
export function deriveField(column: TenantColumn, position: number): Omit<CmsField, "id" | "collection_id"> {
  const name = column.name;
  const lower = name.toLowerCase();
  const type = column.dataType.toLowerCase();

  // Technische Spalten: sichtbar in der Liste, aber nicht bearbeitbar. Der
  // Primärschlüssel wird zusätzlich aus dem Formular genommen — ihn von Hand
  // zu setzen ist nie das, was gemeint war.
  const isTechnical =
    column.isPrimaryKey ||
    column.isIdentity ||
    ["created_at", "updated_at", "erstellt_am", "geaendert_am"].includes(lower);

  let fieldType = "text";
  if (column.enumValues?.length) fieldType = "select";
  else if (column.checkValues?.length) fieldType = "select";
  else if (type === "boolean") fieldType = "toggle";
  else if (["integer", "bigint", "smallint", "numeric", "real", "double precision"].includes(type))
    fieldType = "number";
  else if (type === "date") fieldType = "date";
  else if (type.startsWith("timestamp")) fieldType = "datetime";
  else if (type === "jsonb" || type === "json") fieldType = "json";
  else if (type === "uuid") fieldType = "text";
  else if (type === "text" || type === "character varying") {
    // Namensheuristik, absichtlich eng: nur eindeutige Endungen. Ein Feld
    // fälschlich als Bild anzubieten ist schlimmer als ein Textfeld, in das
    // jemand eine URL einfügt.
    if (/(^|_)(bild|image|foto|photo|logo|cover|thumbnail)(_url)?$/.test(lower)) fieldType = "image";
    else if (/(^|_)slug$/.test(lower)) fieldType = "slug";
    else if (column.maxLength === null || column.maxLength > 300) fieldType = "textarea";
    else fieldType = "text";
  }
  if (isTechnical) fieldType = "readonly";

  const options: Record<string, unknown> = {};
  const choices = column.enumValues || column.checkValues;
  if (choices?.length) options.choices = choices;
  if (column.maxLength) options.maxLength = column.maxLength;

  return {
    column_name: name,
    // "veroeffentlicht_am" -> "Veroeffentlicht am"
    label: name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
    field_type: fieldType,
    help_text: null,
    required: !column.isNullable && !column.hasDefault && !isTechnical,
    visible_list: true,
    visible_form: !column.isPrimaryKey && !column.isIdentity,
    readonly: isTechnical,
    options: Object.keys(options).length > 0 ? options : null,
    position,
  };
}

export async function listCollections(tenantSlug: string): Promise<CmsCollection[]> {
  const { rows } = await getPool().query<CmsCollection>(
    `SELECT id, tenant_slug, table_name, label, label_singular, sort_column, sort_dir,
            can_create, can_delete, position
     FROM cms_collections WHERE tenant_slug = $1 ORDER BY position, label`,
    [tenantSlug]
  );
  return rows;
}

export async function getCollection(id: string, tenantSlug: string): Promise<CmsCollection | null> {
  const { rows } = await getPool().query<CmsCollection>(
    `SELECT id, tenant_slug, table_name, label, label_singular, sort_column, sort_dir,
            can_create, can_delete, position
     FROM cms_collections WHERE id = $1 AND tenant_slug = $2`,
    [id, tenantSlug]
  );
  return rows[0] ?? null;
}

export async function listFields(collectionId: string): Promise<CmsField[]> {
  const { rows } = await getPool().query<CmsField>(
    `SELECT id, collection_id, column_name, label, field_type, help_text, required,
            visible_list, visible_form, readonly, options, position
     FROM cms_fields WHERE collection_id = $1 ORDER BY position, column_name`,
    [collectionId]
  );
  return rows;
}

/**
 * Collection samt vorbelegter Felder anlegen. Eine Transaktion, damit keine
 * Collection ohne Felder entsteht, wenn zwischendurch etwas schiefgeht.
 */
export async function createCollection(
  tenantSlug: string,
  tableName: string,
  label: string,
  columns: TenantColumn[]
): Promise<CmsCollection> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: max } = await client.query<{ next: number }>(
      "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM cms_collections WHERE tenant_slug = $1",
      [tenantSlug]
    );
    // Standardsortierung: neueste zuerst, sofern es eine Datumsspalte gibt.
    const dateColumn = columns.find((c) => /^(created_at|erstellt_am|datum|date|published_at)$/i.test(c.name));
    const pkColumn = columns.find((c) => c.isPrimaryKey);

    const { rows } = await client.query<CmsCollection>(
      `INSERT INTO cms_collections (tenant_slug, table_name, label, label_singular, sort_column, sort_dir, position)
       VALUES ($1, $2, $3, $4, $5, 'desc', $6)
       RETURNING id, tenant_slug, table_name, label, label_singular, sort_column, sort_dir,
                 can_create, can_delete, position`,
      [tenantSlug, tableName, label, label.replace(/e$/, ""), dateColumn?.name || pkColumn?.name || null, max[0].next]
    );
    const collection = rows[0];

    for (const [index, column] of columns.entries()) {
      const field = deriveField(column, index);
      await client.query(
        `INSERT INTO cms_fields (collection_id, column_name, label, field_type, required,
                                 visible_list, visible_form, readonly, options, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          collection.id,
          field.column_name,
          field.label,
          field.field_type,
          field.required,
          // Bei sehr breiten Tabellen wäre die Liste sonst unlesbar — die
          // ersten sechs Spalten reichen für die Übersicht.
          field.visible_list && index < 6,
          field.visible_form,
          field.readonly,
          field.options ? JSON.stringify(field.options) : null,
          field.position,
        ]
      );
    }
    await client.query("COMMIT");
    return collection;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function updateCollection(
  id: string,
  tenantSlug: string,
  patch: Partial<Pick<CmsCollection, "label" | "label_singular" | "sort_column" | "sort_dir" | "can_create" | "can_delete" | "position">>
): Promise<CmsCollection | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    sets.push(`${key} = $${i++}`);
    vals.push(value);
  }
  if (sets.length === 0) return getCollection(id, tenantSlug);
  vals.push(id, tenantSlug);
  const { rows } = await getPool().query<CmsCollection>(
    `UPDATE cms_collections SET ${sets.join(", ")} WHERE id = $${i++} AND tenant_slug = $${i}
     RETURNING id, tenant_slug, table_name, label, label_singular, sort_column, sort_dir,
               can_create, can_delete, position`,
    vals
  );
  return rows[0] ?? null;
}

export async function deleteCollection(id: string, tenantSlug: string): Promise<string | null> {
  const { rows } = await getPool().query<{ table_name: string }>(
    "DELETE FROM cms_collections WHERE id = $1 AND tenant_slug = $2 RETURNING table_name",
    [id, tenantSlug]
  );
  return rows[0]?.table_name ?? null;
}

export async function updateField(
  fieldId: string,
  tenantSlug: string,
  patch: Partial<Pick<CmsField, "label" | "field_type" | "help_text" | "required" | "visible_list" | "visible_form" | "readonly" | "position">>
): Promise<CmsField | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    sets.push(`${key} = $${i++}`);
    vals.push(value);
  }
  if (sets.length === 0) return null;
  vals.push(fieldId, tenantSlug);
  // Der Tenant-Bezug hängt am Feld nur über die Collection — der Join im
  // WHERE stellt sicher, dass niemand über eine fremde Feld-ID schreibt.
  const { rows } = await getPool().query<CmsField>(
    `UPDATE cms_fields f SET ${sets.join(", ")}
     FROM cms_collections c
     WHERE f.collection_id = c.id AND f.id = $${i++} AND c.tenant_slug = $${i}
     RETURNING f.id, f.collection_id, f.column_name, f.label, f.field_type, f.help_text,
               f.required, f.visible_list, f.visible_form, f.readonly, f.options, f.position`,
    vals
  );
  return rows[0] ?? null;
}

/**
 * Felder mit dem aktuellen Tabellenschema abgleichen: neue Spalten dazu,
 * verschwundene raus. Nötig, weil sich die Tabelle des Kunden ändert, nachdem
 * die Collection angelegt wurde — ohne das taucht eine neue Spalte im CMS nie
 * auf, und eine gelöschte Spalte lässt jedes Speichern scheitern.
 */
export async function syncFields(
  collectionId: string,
  columns: TenantColumn[]
): Promise<{ added: string[]; removed: string[] }> {
  const existing = await listFields(collectionId);
  const existingNames = new Set(existing.map((f) => f.column_name));
  const currentNames = new Set(columns.map((c) => c.name));

  const added: string[] = [];
  const removed: string[] = [];
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    let position = existing.length;
    for (const column of columns) {
      if (existingNames.has(column.name)) continue;
      const field = deriveField(column, position++);
      await client.query(
        `INSERT INTO cms_fields (collection_id, column_name, label, field_type, required,
                                 visible_list, visible_form, readonly, options, position)
         VALUES ($1, $2, $3, $4, $5, false, $6, $7, $8, $9)`,
        [
          collectionId,
          field.column_name,
          field.label,
          field.field_type,
          field.required,
          field.visible_form,
          field.readonly,
          field.options ? JSON.stringify(field.options) : null,
          field.position,
        ]
      );
      added.push(column.name);
    }
    for (const field of existing) {
      if (currentNames.has(field.column_name)) continue;
      await client.query("DELETE FROM cms_fields WHERE id = $1", [field.id]);
      removed.push(field.column_name);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { added, removed };
}

export async function listCmsUsers(tenantSlug: string): Promise<CmsUser[]> {
  const { rows } = await getPool().query<CmsUser>(
    `SELECT id, tenant_slug, email, display_name, role, disabled, last_login_at, created_at
     FROM cms_users WHERE tenant_slug = $1 ORDER BY created_at`,
    [tenantSlug]
  );
  return rows;
}

export async function createCmsUser(
  tenantSlug: string,
  email: string,
  password: string,
  displayName: string | null,
  role: string
): Promise<CmsUser> {
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await getPool().query<CmsUser>(
    `INSERT INTO cms_users (tenant_slug, email, password_hash, display_name, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, tenant_slug, email, display_name, role, disabled, last_login_at, created_at`,
    [tenantSlug, email.toLowerCase().trim(), hash, displayName, role === "admin" ? "admin" : "editor"]
  );
  return rows[0];
}

export async function setCmsUserPassword(id: string, tenantSlug: string, password: string): Promise<boolean> {
  const hash = await bcrypt.hash(password, 10);
  // Sperre und Fehlversuchszähler mit zurücksetzen: ein neues Passwort ist
  // immer auch die Antwort auf "ich komme nicht mehr rein".
  const { rowCount } = await getPool().query(
    `UPDATE cms_users SET password_hash = $1, failed_logins = 0, locked_until = NULL
     WHERE id = $2 AND tenant_slug = $3`,
    [hash, id, tenantSlug]
  );
  return (rowCount ?? 0) > 0;
}

export async function setCmsUserDisabled(id: string, tenantSlug: string, disabled: boolean): Promise<boolean> {
  const { rowCount } = await getPool().query(
    "UPDATE cms_users SET disabled = $1 WHERE id = $2 AND tenant_slug = $3",
    [disabled, id, tenantSlug]
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteCmsUser(id: string, tenantSlug: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    "DELETE FROM cms_users WHERE id = $1 AND tenant_slug = $2",
    [id, tenantSlug]
  );
  return (rowCount ?? 0) > 0;
}
