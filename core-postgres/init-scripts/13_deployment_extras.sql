-- P2-4: Commit-Message fuer die Deployment-Historie.
--
-- 'cancelled' als Status ist bereits seit Migration 10 im CHECK-Constraint
-- enthalten (Vorbereitung), hier kommt nur noch die fehlende Spalte dazu.
--
-- Idempotent.
\connect admin_dashboard

ALTER TABLE deployments ADD COLUMN IF NOT EXISTS commit_message TEXT;
