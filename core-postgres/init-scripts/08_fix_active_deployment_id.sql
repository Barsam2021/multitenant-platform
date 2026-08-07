\connect admin_dashboard

-- Bugfix: lib/deploy.ts und routes/deployments.ts schreiben/lesen projects.active_deployment_id,
-- aber keine bisherige Migration hat die Spalte angelegt. Ohne diesen Fix würde jeder
-- erfolgreiche Deploy/Rollback mit einem SQL-Fehler crashen ("column does not exist").
-- Idempotent, gegen admin_dashboard-DB auszuführen.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS active_deployment_id UUID REFERENCES deployments(id) ON DELETE SET NULL;