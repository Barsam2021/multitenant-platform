\connect admin_dashboard

-- Phase 4: Verknüpfung Projekt <-> Uptime-Kuma-Monitor. Idempotent, gegen admin_dashboard-DB auszuführen.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS kuma_monitor_id INTEGER;