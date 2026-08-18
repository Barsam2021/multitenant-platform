import { Client } from 'pg';
import format from 'pg-format';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

/**
 * CMS-Rollenverwaltung.
 *
 * Der CMS-Dienst verbindet sich NICHT als Superuser (anders als das
 * Admin-Dashboard), sondern pro Tenant mit einer eigenen Rolle `cms_<slug>`,
 * die ausschliesslich auf die freigegebenen Tabellen Rechte hat. Damit ist die
 * Freigabe einer Collection nicht nur eine UI-Entscheidung, sondern auf
 * Datenbankebene erzwungen: selbst ein Fehler in der Anwendungslogik kann keine
 * Tabelle erreichen, die nie freigegeben wurde — und `auth.*` (die GoTrue-Nutzer
 * des Kunden) ist grundsaetzlich unerreichbar.
 */

// Eigener Schluessel, NICHT ENCRYPTION_MASTER_KEY. Der CMS-Dienst ist der
// einzige Teil der Plattform, den kundenfremde Personen direkt benutzen; er
// braucht dieses eine Passwort und soll bei einer Kompromittierung nicht auch
// die MinIO- und JWT-Secrets aller Tenants entschluesseln koennen.
function cmsKey(): Buffer {
  const hex = process.env.CMS_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'CMS_ENCRYPTION_KEY fehlt oder hat falsche Laenge (64 hex chars / 32 bytes erwartet, ' +
      'siehe .env.example). Ohne ihn kann der CMS-Dienst sich nicht an der Tenant-DB anmelden.'
    );
  }
  return Buffer.from(hex, 'hex');
}

/** Gleiches Format wie lib/crypto.ts: [12 IV][16 authTag][ciphertext]. */
export function encryptForCms(plaintext: string): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cmsKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function cmsRoleName(slug: string): string {
  return `cms_${slug}`;
}

function tenantClient(dbName: string): Client {
  const client = new Client({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/${dbName}`,
  });
  client.on('error', (e) => console.error('pg client error (cms tenant):', e.message));
  return client;
}

function masterClient(): Client {
  const client = new Client({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/postgres`,
  });
  client.on('error', (e) => console.error('pg client error (cms master):', e.message));
  return client;
}

/**
 * Legt die Rolle an (oder setzt ihr Passwort neu) und gibt das Klartext-Passwort
 * zurueck — der Aufrufer verschluesselt es und schreibt es weg.
 *
 * Bewusst KEINE Rechte auf Tabellen hier: die kommen einzeln pro freigegebener
 * Collection dazu (grantTable). Eine frisch angelegte Rolle sieht in der
 * Tenant-DB genau nichts.
 */
export async function ensureCmsRole(slug: string, dbName: string): Promise<string> {
  const role = cmsRoleName(slug);
  const password = crypto.randomBytes(24).toString('hex');

  const master = masterClient();
  await master.connect();
  try {
    const { rows } = await master.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (rows.length === 0) {
      await master.query(format('CREATE ROLE %I LOGIN PASSWORD %L;', role, password));
    } else {
      // Neu-Aktivierung nach einem Abschalten: Passwort rotieren, statt das
      // alte weiterzuverwenden (es koennte in einem Backup liegen).
      await master.query(format('ALTER ROLE %I WITH LOGIN PASSWORD %L;', role, password));
    }
    await master.query(format('GRANT CONNECT ON DATABASE %I TO %I;', dbName, role));
  } finally {
    await master.end().catch(() => {});
  }

  const tenant = tenantClient(dbName);
  await tenant.connect();
  try {
    await tenant.query(format('GRANT USAGE ON SCHEMA public TO %I;', role));
    // Sequenzen fuer Tabellen mit serial/identity-Primaerschluessel — ohne das
    // scheitert jedes INSERT in eine solche Tabelle mit "permission denied for
    // sequence", was auf nichts Erkennbares hindeutet.
    await tenant.query(format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I;', role));
    await tenant.query(
      format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I;', role)
    );
  } finally {
    await tenant.end().catch(() => {});
  }

  return password;
}

/**
 * Rolle vollstaendig entfernen. DROP OWNED BY raeumt die Rechte in der
 * Tenant-DB weg — ohne das scheitert DROP ROLE mit "cannot be dropped because
 * some objects depend on it", und die Rolle bliebe mit ihren Rechten bestehen.
 */
export async function dropCmsRole(slug: string, dbName: string): Promise<void> {
  const role = cmsRoleName(slug);

  const master = masterClient();
  await master.connect();
  try {
    const { rows } = await master.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (rows.length === 0) return;
  } finally {
    await master.end().catch(() => {});
  }

  const tenant = tenantClient(dbName);
  await tenant.connect();
  try {
    await tenant.query(format('DROP OWNED BY %I;', role));
  } catch (e: any) {
    console.error(`DROP OWNED BY ${role} fehlgeschlagen:`, e.message);
  } finally {
    await tenant.end().catch(() => {});
  }

  const master2 = masterClient();
  await master2.connect();
  try {
    await master2.query(format('REVOKE ALL ON DATABASE %I FROM %I;', dbName, role));
    await master2.query(format('DROP ROLE IF EXISTS %I;', role));
  } finally {
    await master2.end().catch(() => {});
  }
}

/** Existiert die Tabelle wirklich, und ist sie eine normale Tabelle in `public`? */
async function assertRealTable(tenant: Client, table: string): Promise<void> {
  const { rows } = await tenant.query(
    `SELECT 1 FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = $1 AND c.relkind IN ('r', 'p')`,
    [table]
  );
  if (rows.length === 0) throw new Error(`Tabelle "public.${table}" existiert nicht`);
}

/** Schreibrechte auf genau eine Tabelle. */
export async function grantTable(slug: string, dbName: string, table: string): Promise<void> {
  const role = cmsRoleName(slug);
  const tenant = tenantClient(dbName);
  await tenant.connect();
  try {
    await assertRealTable(tenant, table);
    await tenant.query(format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO %I;', table, role));
  } finally {
    await tenant.end().catch(() => {});
  }
}

export async function revokeTable(slug: string, dbName: string, table: string): Promise<void> {
  const role = cmsRoleName(slug);
  const tenant = tenantClient(dbName);
  await tenant.connect();
  try {
    await tenant.query(format('REVOKE ALL ON public.%I FROM %I;', table, role));
  } catch (e: any) {
    // Tabelle wurde inzwischen geloescht — dann ist auch nichts mehr zu
    // entziehen. Kein Grund, das Entfernen der Collection scheitern zu lassen.
    console.error(`REVOKE auf ${table} fehlgeschlagen:`, e.message);
  } finally {
    await tenant.end().catch(() => {});
  }
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
 * Spalten einer Tenant-Tabelle samt allem, woraus sich ein Feldtyp ableiten
 * laesst: Enum-Werte, IN-Listen aus CHECK-Constraints, Laengenbegrenzung.
 * Grundlage fuer die Vorbelegung der cms_fields beim Anlegen einer Collection.
 */
export async function describeTenantTable(dbName: string, table: string): Promise<TenantColumn[]> {
  const tenant = tenantClient(dbName);
  await tenant.connect();
  try {
    await assertRealTable(tenant, table);

    const { rows: cols } = await tenant.query(
      `SELECT c.column_name, c.data_type, c.udt_name, c.is_nullable, c.column_default,
              c.is_identity, c.character_maximum_length
       FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = $1
       ORDER BY c.ordinal_position`,
      [table]
    );

    const { rows: pk } = await tenant.query(
      `SELECT a.attname AS column_name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = format('public.%I', $1::text)::regclass AND i.indisprimary`,
      [table]
    );
    const pkNames = new Set(pk.map((r) => r.column_name));

    // Enum-Werte fuer alle benutzerdefinierten Typen der Tabelle.
    const { rows: enums } = await tenant.query(
      `SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
       GROUP BY t.typname`
    );
    const enumMap = new Map<string, string[]>(enums.map((r) => [r.typname, r.values]));

    // CHECK-Constraints der Form  spalte IN ('a','b')  bzw.  spalte = ANY (ARRAY[...]).
    // Postgres normalisiert beides zu derselben Darstellung, deshalb reicht ein
    // Muster. Was nicht passt, wird ignoriert — dann bleibt es ein Textfeld.
    const { rows: checks } = await tenant.query(
      `SELECT pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       WHERE con.conrelid = format('public.%I', $1::text)::regclass AND con.contype = 'c'`,
      [table]
    );

    function checkValuesFor(column: string): string[] | null {
      for (const row of checks) {
        const def: string = row.def || '';
        if (!new RegExp(`\\(${column}\\b`).test(def) && !def.includes(`${column} =`)) continue;
        const arrayMatch = def.match(/ARRAY\[([^\]]+)\]/);
        const source = arrayMatch ? arrayMatch[1] : def;
        const values = [...source.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
        if (values.length > 0) return values;
      }
      return null;
    }

    return cols.map((c) => ({
      name: c.column_name,
      dataType: c.data_type,
      isNullable: c.is_nullable === 'YES',
      isPrimaryKey: pkNames.has(c.column_name),
      hasDefault: c.column_default !== null,
      isIdentity: c.is_identity === 'YES',
      maxLength: c.character_maximum_length,
      enumValues: enumMap.get(c.udt_name) || null,
      checkValues: checkValuesFor(c.column_name),
    }));
  } finally {
    await tenant.end().catch(() => {});
  }
}

/** Kandidaten fuer Collections: Tabellen in `public`, ohne Plattform-Kram. */
export async function listTenantTables(dbName: string): Promise<{ name: string; rowEstimate: number }[]> {
  const tenant = tenantClient(dbName);
  await tenant.connect();
  try {
    const { rows } = await tenant.query(
      `SELECT c.relname AS name, GREATEST(c.reltuples, 0)::bigint AS row_estimate
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
         AND c.relname NOT LIKE 'schema_migrations%'
       ORDER BY c.relname`
    );
    return rows.map((r) => ({ name: r.name, rowEstimate: Number(r.row_estimate) }));
  } finally {
    await tenant.end().catch(() => {});
  }
}

/**
 * Gibt das Praefix `public/` im MinIO-Bucket des Tenants zum anonymen Lesen
 * frei — und NUR dieses Praefix.
 *
 * Ohne diesen Schritt laedt ein Redakteur Bilder hoch, bekommt eine URL
 * zurueck, und die liefert dann 403: der Bucket ist per Default komplett
 * privat. Das war bisher ein manueller `mc`-Aufruf pro Kunde in der
 * Einrichtungsanleitung — also genau die Art Schritt, die man beim zehnten
 * Kunden vergisst und danach eine halbe Stunde sucht.
 *
 * Alles ausserhalb von `public/` bleibt unerreichbar; der CMS-Dienst legt
 * Uploads ausschliesslich unter diesem Praefix ab (cms/src/lib/media.ts).
 */
export async function publishTenantMediaPrefix(slug: string): Promise<void> {
  const { MINIO_ROOT_USER, MINIO_ROOT_PASSWORD } = process.env;
  if (!MINIO_ROOT_USER || !MINIO_ROOT_PASSWORD) {
    throw new Error('MINIO_ROOT_USER/MINIO_ROOT_PASSWORD fehlen — Medien-Freigabe nicht moeglich.');
  }
  await execFileP('mc', ['alias', 'set', 'localminio', 'http://core-minio:9000', MINIO_ROOT_USER, MINIO_ROOT_PASSWORD]);
  await execFileP('mc', ['anonymous', 'set', 'download', `localminio/kunde-${slug}-storage/public`]);
}

/** Gegenstueck: Freigabe zuruecknehmen, wenn das CMS abgeschaltet wird. */
export async function unpublishTenantMediaPrefix(slug: string): Promise<void> {
  const { MINIO_ROOT_USER, MINIO_ROOT_PASSWORD } = process.env;
  if (!MINIO_ROOT_USER || !MINIO_ROOT_PASSWORD) return;
  await execFileP('mc', ['alias', 'set', 'localminio', 'http://core-minio:9000', MINIO_ROOT_USER, MINIO_ROOT_PASSWORD]);
  await execFileP('mc', ['anonymous', 'set', 'none', `localminio/kunde-${slug}-storage/public`]);
}
