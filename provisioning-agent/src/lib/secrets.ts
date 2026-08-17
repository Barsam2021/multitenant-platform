import { Client as PGClient } from 'pg';
import { decrypt } from './crypto';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

function adminClient(): PGClient {
  // P1-4 (Audit 0430f9c): ein pg.Client emittiert bei Verbindungsverlust ein
  // 'error'-Event. OHNE Listener ist das in Node eine uncaught exception, also
  // Prozessende — im schlimmsten Fall mitten im Deploy zwischen `docker rename`
  // und `docker run`: Kundenseite offline, und nichts raeumt auf. deploy.ts
  // haelt einen solchen Client ueber die gesamte Deploy-Dauer offen (Build-
  // Timeout allein 10 Minuten).
  const client = new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
  client.on('error', (err) => console.error('pg client error (adminClient):', err.message));
  return client;
}

export interface TenantSecrets {
  gotrueJwtSecret: string;
  minioAccessKey: string;
  minioSecretKey: string;
  anonJwt: string;
  serviceRoleJwt: string;
  postgrestPublicEnabled: boolean;
  /** Migration 19: false = es laufen keine api-/auth-Container fuer diesen Tenant. */
  dbEnabled: boolean;
}

/**
 * Holt die pro-Kunde-Secrets aus admin_dashboard.kunden (entschlüsselt) für die
 * Auto-Env-Injection in den Kunden-App-Container (siehe lib/deploy.ts runDeployment() Schritt 2).
 */
export async function getTenantSecrets(tenantSlug: string): Promise<TenantSecrets> {
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT gotrue_jwt_secret, minio_access_key, minio_secret_key_encrypted, anon_jwt, service_role_jwt,
              postgrest_public_enabled, db_enabled
       FROM kunden WHERE slug = $1`,
      [tenantSlug]
    );
    if (rows.length === 0) throw new Error(`tenant not found: ${tenantSlug}`);
    const row = rows[0];
    return {
      gotrueJwtSecret: row.gotrue_jwt_secret,
      minioAccessKey: row.minio_access_key,
      minioSecretKey: row.minio_secret_key_encrypted ? decrypt(row.minio_secret_key_encrypted) : '',
      anonJwt: row.anon_jwt || '',
      serviceRoleJwt: row.service_role_jwt || '',
      postgrestPublicEnabled: !!row.postgrest_public_enabled,
      dbEnabled: row.db_enabled !== false,
    };
  } finally {
    await db.end();
  }
}

/**
 * Holt manuell im Dashboard gesetzte project_env_vars (entschlüsselt).
 */
export async function getProjectEnvVars(projectId: string): Promise<Record<string, string>> {
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT key, value_encrypted FROM project_env_vars WHERE project_id = $1`,
      [projectId]
    );
    const out: Record<string, string> = {};
    for (const row of rows) {
      out[row.key] = decrypt(row.value_encrypted);
    }
    return out;
  } finally {
    await db.end();
  }
}

/**
 * Baut die vollständige Env-Var-Liste für den `docker run`-Aufruf: Tenant-Secrets
 * (MinIO, GoTrue) + manuell gesetzte project_env_vars. Nie geloggt im Klartext.
 */
export async function buildEnvVars(
  tenantSlug: string,
  projectId: string
): Promise<Record<string, string>> {
  const tenant = await getTenantSecrets(tenantSlug);
  const projectVars = await getProjectEnvVars(projectId);
  const platformDomain = process.env.PLATFORM_DOMAIN;

  // @supabase/ssr (createBrowserClient/createServerClient) erwartet zwingend die
  // NEXT_PUBLIC_-praefixierten Namen — nur so nimmt Next.js sie ins Client-Bundle
  // auf. Die interne SUPABASE_URL (http://api-<slug>:3000) ist dafuer unbrauchbar,
  // ein Browser kann den Docker-Hostnamen nicht aufloesen — hier muss die oeffentliche
  // PostgREST-URL rein, und die existiert nur, wenn der Tenant das per
  // POST /tenants/:slug/public-access explizit freigegeben hat (siehe RLS-Warnung
  // dort: ohne RLS-Policies ist die DB dann fuer jeden mit dem Anon-Key lese-/
  // schreibbar). Deshalb bewusst kein Fallback auf die interne URL — ohne Freigabe
  // bleiben die NEXT_PUBLIC_-Vars weg, damit der App-seitige Fehler ("Missing
  // NEXT_PUBLIC_SUPABASE_URL") auf die eigentliche Ursache zeigt statt auf eine
  // unerreichbare interne Adresse.
  const publicSupabaseVars: Record<string, string> = tenant.postgrestPublicEnabled && platformDomain
    ? {
        NEXT_PUBLIC_SUPABASE_URL: `https://${tenantSlug}-api.${platformDomain}`,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: tenant.anonJwt,
      }
    : {};

  // Migration 19: hat der Tenant keine Datenbank-Ebene, wird KEINE der
  // DB-/Auth-Variablen gesetzt. Sie auf nicht existierende Container zeigen zu
  // lassen waere die schlechtere Variante: der Supabase-Client wuerde beim
  // ersten Aufruf mit einem DNS-Fehler auf api-<slug> abbrechen statt beim
  // Start mit "Missing SUPABASE_URL" — der Fehler zeigt dann auf die Ursache.
  const databaseVars: Record<string, string> = tenant.dbEnabled
    ? {
        GOTRUE_URL: `http://auth-${tenantSlug}:9999`,
        JWT_SECRET: tenant.gotrueJwtSecret,
        POSTGREST_URL: `http://api-${tenantSlug}:3000`,
        SUPABASE_URL: `http://api-${tenantSlug}:3000`, // Alias, falls Kunden-App Supabase-SDK nutzt
        SUPABASE_ANON_KEY: tenant.anonJwt,
        SUPABASE_SERVICE_ROLE_KEY: tenant.serviceRoleJwt,
        ...publicSupabaseVars,
      }
    : {};

  return {
    MINIO_ENDPOINT: 'http://core-minio:9000',
    MINIO_ACCESS_KEY: tenant.minioAccessKey,
    MINIO_SECRET_KEY: tenant.minioSecretKey,
    S3_BUCKET_NAME: `kunde-${tenantSlug}-storage`,
    ...databaseVars,
    ...projectVars,
  };
}
