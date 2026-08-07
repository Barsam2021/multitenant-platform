-- P0-2: 'healthchecking' im status-CHECK zulassen.
--
-- lib/deploy.ts setzt diesen Status zwischen Container-Start und Traffic-Switch.
-- Der urspruengliche Constraint aus 02_admin_schema.sql kannte ihn nicht -> jeder
-- Deploy scheiterte an einer Constraint-Verletzung und wurde als 'failed'
-- protokolliert, obwohl der Build erfolgreich war.
--
-- 'cancelled' ist bereits mit aufgenommen (Vorbereitung P2-4, Deploy-Abbruch).
-- Idempotent, gefahrlos mehrfach ausfuehrbar.
\connect admin_dashboard

ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_status_check;

ALTER TABLE deployments ADD CONSTRAINT deployments_status_check
  CHECK (status IN ('queued','building','healthchecking','deployed','failed','rolled_back','cancelled'));
