import jwt from 'jsonwebtoken';

/**
 * Erzeugt einen langlebigen JWT für einen Tenant, signiert mit dessen
 * `gotrue_jwt_secret`. Wird als SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
 * in die Kunden-App injiziert (siehe lib/secrets.ts:buildEnvVars) und von
 * PostgREST/GoTrue zur Rollen-Ermittlung ausgewertet (Claim `role`).
 *
 * Deterministisch aus dem Secret ableitbar — kein separater Storage für die
 * Signatur nötig, daher Klartext-Speicherung der fertigen JWTs in `kunden`
 * unbedenklich (siehe Migration 09_tenant_api_keys.sql).
 */
export function signTenantJwt(secret: string, role: 'anon' | 'service_role'): string {
  return jwt.sign({ role }, secret, { algorithm: 'HS256' });
}
