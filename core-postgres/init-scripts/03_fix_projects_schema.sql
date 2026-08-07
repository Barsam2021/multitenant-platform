\connect admin_dashboard

-- Fix: Schema/Code-Mismatch aus 02_admin_schema.sql.
-- Code (projects.ts, deployments.ts, deploy.ts, webhooks.ts) nutzt tenant_slug,
-- active_container, webhook_secret, container_name, image_tag, finished_at —
-- keine dieser Spalten existierte im ursprünglichen Schema.
-- Idempotent, gegen admin_dashboard-DB auszuführen.

ALTER TABLE projects DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tenant_slug TEXT REFERENCES kunden(slug) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS active_container TEXT;

ALTER TABLE projects DROP COLUMN IF EXISTS webhook_secret_encrypted;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS webhook_secret TEXT;

ALTER TABLE deployments ADD COLUMN IF NOT EXISTS container_name TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS image_tag TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;