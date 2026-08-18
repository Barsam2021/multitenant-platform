import { Pool } from "pg";
import crypto from "crypto";

/**
 * Zugriff auf admin_dashboard: die CMS-Konfiguration (Collections, Felder,
 * Nutzer, Medien) und das verschluesselte Passwort der Tenant-Rolle.
 *
 * Der Dienst verbindet sich hier NICHT als Superuser — CMS_DATABASE_URL zeigt
 * auf eine Rolle mit Rechten ausschliesslich auf die cms_*-Tabellen und ein
 * paar Spalten von `kunden` (siehe SETUP.md). Die Inhalte der Kunden liegen in
 * einer ganz anderen Verbindung, siehe tenantDb.ts.
 */

let pool: Pool | null = null;
function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.CMS_DATABASE_URL;
    if (!connectionString) throw new Error("CMS_DATABASE_URL fehlt (siehe .env.example)");
    pool = new Pool({ connectionString, max: 4 });
  }
  return pool;
}

export interface Collection {
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

export interface Field {
  id: string;
  column_name: string;
  label: string;
  field_type: string;
  help_text: string | null;
  required: boolean;
  visible_list: boolean;
  visible_form: boolean;
  readonly: boolean;
  options: { choices?: string[]; maxLength?: number } | null;
  position: number;
}

export interface TenantInfo {
  slug: string;
  db_name: string;
  display_name: string | null;
  cms_enabled: boolean;
  cms_db_password_encrypted: Buffer | null;
}

export async function getTenant(slug: string): Promise<TenantInfo | null> {
  const { rows } = await getPool().query<TenantInfo>(
    `SELECT slug, db_name, display_name, cms_enabled, cms_db_password_encrypted
     FROM kunden WHERE slug = $1`,
    [slug]
  );
  return rows[0] ?? null;
}

export async function listCollections(tenantSlug: string): Promise<Collection[]> {
  const { rows } = await getPool().query<Collection>(
    `SELECT id, tenant_slug, table_name, label, label_singular, sort_column, sort_dir,
            can_create, can_delete, position
     FROM cms_collections WHERE tenant_slug = $1 ORDER BY position, label`,
    [tenantSlug]
  );
  return rows;
}

/**
 * Collection samt Feldern — immer zusammen mit dem Tenant-Bezug geladen.
 *
 * Diese Funktion ist die einzige Stelle, an der aus einer ID eine Collection
 * wird. Der tenant_slug steht deshalb im WHERE und nicht in einer spaeteren
 * Pruefung: eine fremde Collection-ID liefert schlicht null, statt Daten, die
 * dann jemand vergisst zu pruefen.
 */
export async function getCollectionWithFields(
  tenantSlug: string,
  collectionId: string
): Promise<{ collection: Collection; fields: Field[] } | null> {
  const { rows } = await getPool().query<Collection>(
    `SELECT id, tenant_slug, table_name, label, label_singular, sort_column, sort_dir,
            can_create, can_delete, position
     FROM cms_collections WHERE id = $1 AND tenant_slug = $2`,
    [collectionId, tenantSlug]
  );
  const collection = rows[0];
  if (!collection) return null;

  const { rows: fields } = await getPool().query<Field>(
    `SELECT id, column_name, label, field_type, help_text, required, visible_list,
            visible_form, readonly, options, position
     FROM cms_fields WHERE collection_id = $1 ORDER BY position, column_name`,
    [collectionId]
  );
  return { collection, fields };
}

export interface CmsUserRow {
  id: string;
  tenant_slug: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  role: string;
  disabled: boolean;
  failed_logins: number;
  locked_until: string | null;
}

export async function findUser(tenantSlug: string, email: string): Promise<CmsUserRow | null> {
  const { rows } = await getPool().query<CmsUserRow>(
    `SELECT id, tenant_slug, email, password_hash, display_name, role, disabled,
            failed_logins, locked_until
     FROM cms_users WHERE tenant_slug = $1 AND email = $2`,
    [tenantSlug, email.toLowerCase().trim()]
  );
  return rows[0] ?? null;
}

/**
 * Fehlversuche zaehlen und ab einer Schwelle sperren. Der CMS-Login steht im
 * offenen Internet — ohne diese Bremse ist ein Passwort mit 12 Zeichen nur so
 * gut wie die Geduld des Angreifers.
 */
const MAX_FAILED_LOGINS = 8;
const LOCK_MINUTES = 15;

export async function recordFailedLogin(userId: string): Promise<void> {
  await getPool().query(
    `UPDATE cms_users
     SET failed_logins = failed_logins + 1,
         locked_until = CASE WHEN failed_logins + 1 >= $2
                             THEN now() + ($3 || ' minutes')::interval
                             ELSE locked_until END
     WHERE id = $1`,
    [userId, MAX_FAILED_LOGINS, String(LOCK_MINUTES)]
  );
}

export async function recordSuccessfulLogin(userId: string): Promise<void> {
  await getPool().query(
    "UPDATE cms_users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1",
    [userId]
  );
}

export interface MediaRow {
  id: string;
  object_key: string;
  public_url: string;
  original_name: string | null;
  content_type: string;
  size_bytes: string;
  width: number | null;
  height: number | null;
  created_at: string;
}

export async function listMedia(tenantSlug: string, limit = 60): Promise<MediaRow[]> {
  const { rows } = await getPool().query<MediaRow>(
    `SELECT id, object_key, public_url, original_name, content_type, size_bytes, width, height, created_at
     FROM cms_media WHERE tenant_slug = $1 ORDER BY created_at DESC LIMIT $2`,
    [tenantSlug, limit]
  );
  return rows;
}

export async function insertMedia(entry: {
  tenantSlug: string;
  objectKey: string;
  publicUrl: string;
  originalName: string | null;
  contentType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  uploadedBy: string;
}): Promise<MediaRow> {
  const { rows } = await getPool().query<MediaRow>(
    `INSERT INTO cms_media (tenant_slug, object_key, public_url, original_name, content_type,
                            size_bytes, width, height, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, object_key, public_url, original_name, content_type, size_bytes, width, height, created_at`,
    [
      entry.tenantSlug,
      entry.objectKey,
      entry.publicUrl,
      entry.originalName,
      entry.contentType,
      entry.sizeBytes,
      entry.width,
      entry.height,
      entry.uploadedBy,
    ]
  );
  return rows[0];
}

/** Wie viele Bytes hat dieser Tenant bereits hochgeladen? (Kontingent-Pruefung) */
export async function usedStorageBytes(tenantSlug: string): Promise<number> {
  const { rows } = await getPool().query<{ total: string }>(
    "SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total FROM cms_media WHERE tenant_slug = $1",
    [tenantSlug]
  );
  return Number(rows[0]?.total || 0);
}

export async function logCmsAudit(entry: {
  tenantSlug: string;
  userId: string | null;
  userEmail: string | null;
  action: string;
  collection?: string | null;
  rowPk?: string | null;
  detail?: Record<string, unknown>;
  ip?: string | null;
}): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO cms_audit (tenant_slug, user_id, user_email, action, collection, row_pk, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.tenantSlug,
        entry.userId,
        entry.userEmail,
        entry.action,
        entry.collection ?? null,
        entry.rowPk ?? null,
        entry.detail ? JSON.stringify(entry.detail) : null,
        entry.ip ?? null,
      ]
    );
  } catch (err) {
    // Ein fehlgeschlagener Log-Eintrag darf nie die eigentliche Aktion kippen.
    console.error("cms_audit write failed:", (err as Error).message);
  }
}

/**
 * Entschluesselt das Passwort der Rolle cms_<slug>. Format wie in
 * provisioning-agent/src/lib/cms.ts: [12 IV][16 authTag][ciphertext], AES-256-GCM.
 *
 * Der Schluessel ist CMS_ENCRYPTION_KEY und ausdruecklich NICHT der
 * ENCRYPTION_MASTER_KEY der Plattform: dieser Dienst ist oeffentlich erreichbar
 * und soll bei einer Kompromittierung nicht auch die MinIO- und JWT-Secrets
 * aller Tenants entschluesseln koennen.
 */
export function decryptCmsPassword(payload: Buffer): string {
  const hex = process.env.CMS_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("CMS_ENCRYPTION_KEY fehlt oder hat falsche Laenge (64 hex chars erwartet)");
  }
  if (!Buffer.isBuffer(payload) || payload.length < 29) {
    throw new Error("Verschluesseltes CMS-Passwort ist unbrauchbar — CMS im Dashboard neu aktivieren.");
  }
  // Uint8Array statt Buffer: die Node-Typen fuer createDecipheriv verlangen in
  // dieser TypeScript-/@types/node-Kombination genau das, und Buffer ist zwar
  // zur Laufzeit eins, laut Typdefinition aber nicht zuweisbar.
  const key = new Uint8Array(Buffer.from(hex, "hex"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, new Uint8Array(payload.subarray(0, 12)));
  decipher.setAuthTag(new Uint8Array(payload.subarray(12, 28)));
  return Buffer.concat([decipher.update(new Uint8Array(payload.subarray(28))), decipher.final()]).toString("utf8");
}
