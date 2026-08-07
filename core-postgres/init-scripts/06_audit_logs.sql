\connect admin_dashboard

-- Phase 6: Audit-Log-Tabelle. Idempotent, gegen admin_dashboard-DB auszuführen.
-- Single-Admin-Setup -> 'actor' ist aktuell immer 'admin', Spalte existiert trotzdem
-- schon jetzt für den Fall mehrerer Admin-Accounts später.
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor TEXT NOT NULL DEFAULT 'admin',
    action TEXT NOT NULL,
    target TEXT,
    meta JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action);