\connect admin_dashboard

-- Phase 0/1 (Admin-Workflow): Speichert die fertig signierten Supabase-kompatiblen
-- API-Keys pro Tenant, damit sie im Dashboard direkt angezeigt werden können,
-- ohne bei jedem Seitenaufruf neu signieren zu müssen.
--
-- Klartext-Speicherung ist hier bewusst okay (anders als z.B. minio_secret_key,
-- siehe 02_admin_schema.sql): beide JWTs sind ohnehin aus gotrue_jwt_secret
-- deterministisch neu erzeugbar (siehe provisioning-agent/src/lib/jwt.ts) und
-- müssen im Dashboard im Klartext zum Kopieren angezeigt werden.
--
-- Idempotent, gegen laufende admin_dashboard-DB ausführbar.
ALTER TABLE kunden ADD COLUMN IF NOT EXISTS anon_jwt TEXT;
ALTER TABLE kunden ADD COLUMN IF NOT EXISTS service_role_jwt TEXT;