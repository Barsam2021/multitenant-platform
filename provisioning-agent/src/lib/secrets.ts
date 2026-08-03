import { Client as PGClient } from 'pg';
import { decrypt } from './crypto';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

function adminClient(): PGClient {
  return new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
}

export interface TenantSecrets {
  gotrueJwtSecret: string;
  minioAccessKey: string;
  minioSecretKey: string;
  anonJwt: string;
  serviceRoleJwt: string;
}

/**
 * Holt die pro-Kunde-Secrets aus admin_dashboard.kunden (entschlüsselt) für die
 * Auto-Env-Injection in den Kunden-App-Container (siehe 05_deployment_engine_specification.md § 4.1).
 */
export async function getTenantSecrets(tenantSlug: string): Promise<TenantSecrets> {
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT gotrue_jwt_secret, minio_access_key, minio_secret_key_encrypted, anon_jwt, service_role_jwt
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

  return {
    MINIO_ENDPOINT: 'http://core-minio:9000',
    MINIO_ACCESS_KEY: tenant.minioAccessKey,
    MINIO_SECRET_KEY: tenant.minioSecretKey,
    S3_BUCKET_NAME: `kunde-${tenantSlug}-storage`,
    GOTRUE_URL: `http://auth-${tenantSlug}:9999`,
    JWT_SECRET: tenant.gotrueJwtSecret,
    POSTGREST_URL: `http://api-${tenantSlug}:3000`,
    SUPABASE_URL: `http://api-${tenantSlug}:3000`, // Alias, falls Kunden-App Supabase-SDK nutzt
    SUPABASE_ANON_KEY: tenant.anonJwt,
    SUPABASE_SERVICE_ROLE_KEY: tenant.serviceRoleJwt,
    ...projectVars,
  };
}
