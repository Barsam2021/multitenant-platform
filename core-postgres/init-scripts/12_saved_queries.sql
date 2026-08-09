-- P2-3: Gespeicherte SQL-Editor-Queries pro Tenant.
--
-- Bisher gab es keine Query-Historie und keine Moeglichkeit, eine Abfrage
-- fuer spaeter zu sichern - jede Session begann bei "SELECT * FROM".
--
-- Idempotent.
\connect admin_dashboard

CREATE TABLE IF NOT EXISTS saved_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_slug TEXT NOT NULL,
  name TEXT NOT NULL,
  sql_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_saved_queries_tenant ON saved_queries (tenant_slug, created_at DESC);
