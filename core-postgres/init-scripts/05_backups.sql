-- Phase 5: Backup-Metadaten-Tabelle. Idempotent, gegen admin_dashboard-DB auszuführen.
CREATE TABLE IF NOT EXISTS backups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    db_name TEXT NOT NULL,
    filename TEXT NOT NULL,
    size_bytes BIGINT DEFAULT 0,
    status TEXT CHECK (status IN ('ok','dump_failed','upload_failed')),
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_backups_created_at ON backups (created_at DESC);
