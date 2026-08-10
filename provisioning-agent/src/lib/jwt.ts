import jwt from 'jsonwebtoken';

export type TenantRoleKind = 'anon' | 'service_role';

/**
 * P0-2b (Audit 0430f9c): Der `role`-Claim muss die TENANT-EIGENE Rolle nennen,
 * nicht die clusterweite. PostgREST macht mit dem Claim direkt `SET ROLE` —
 * stand dort "service_role", landete jeder Tenant in derselben clusterweiten
 * BYPASSRLS-Rolle.
 */
export function tenantRoleName(kind: TenantRoleKind | 'authenticated', slug: string): string {
  return `${kind}_${slug}`;
}

/**
 * Erzeugt einen langlebigen JWT für einen Tenant, signiert mit dessen
 * `gotrue_jwt_secret`. Wird als SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
 * in die Kunden-App injiziert (siehe lib/secrets.ts:buildEnvVars) und von
 * PostgREST/GoTrue zur Rollen-Ermittlung ausgewertet (Claim `role`).
 *
 * Deterministisch aus Secret + Slug ableitbar — kein separater Storage für die
 * Signatur nötig, daher Klartext-Speicherung der fertigen JWTs in `kunden`
 * unbedenklich (siehe Migration 09_tenant_api_keys.sql).
 *
 * Kein `exp`: das sind langlebige API-Keys (Supabase-Konvention). Widerruf
 * laeuft ueber Rotation des Tenant-Secrets (POST /secrets/:slug/rotate/jwt).
 * `iss` ist gesetzt, damit ein fremdes Token nicht versehentlich als
 * Plattform-Token durchgeht. Siehe P2-12 fuer die offene exp/aud-Frage.
 */
export function signTenantJwt(secret: string, kind: TenantRoleKind, slug: string): string {
  return jwt.sign(
    { role: tenantRoleName(kind, slug), iss: 'multitenant-platform' },
    secret,
    { algorithm: 'HS256' }
  );
}
