-- Audit 0430f9c §6: Fehlende Indizes.
--
-- `deployments` ist die heisseste Tabelle der Plattform — das Dashboard pollt
-- sie alle 3 Sekunden — und hatte keinen einzigen Index. Zwei Queries laufen
-- deshalb als Full Scan plus Sort ueber die gesamte Tabelle:
--   routes/stats.ts:92   SELECT DISTINCT ON (project_id) ... ORDER BY project_id, created_at DESC
--   routes/deployments.ts:67  WHERE project_id = $1 ORDER BY created_at DESC LIMIT 20
--
-- CONCURRENTLY geht hier nicht: migrate.sh faehrt die Dateien in einer
-- Transaktion pro psql-Aufruf. Die Tabellen sind zum Zeitpunkt dieser Migration
-- klein genug, dass der kurze Lock nicht auffaellt.
\c admin_dashboard

CREATE INDEX IF NOT EXISTS idx_deployments_project_created
  ON deployments (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_domains_project
  ON domains (project_id);

CREATE INDEX IF NOT EXISTS idx_project_env_vars_project
  ON project_env_vars (project_id);

CREATE INDEX IF NOT EXISTS idx_projects_tenant_slug
  ON projects (tenant_slug);

ANALYZE deployments;
ANALYZE projects;
