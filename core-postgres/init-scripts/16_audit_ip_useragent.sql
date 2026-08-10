-- P3-5: Audit-Log war unvollstaendig - weder IP noch User-Agent wurden je
-- mitgeschrieben, actor stand hart auf 'admin'. Diese Migration ergaenzt nur
-- die Spalten; das Befuellen passiert im Code (lib/audit.ts auf beiden Seiten).
--
-- Idempotent.
\connect admin_dashboard

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip_address TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_agent TEXT;
