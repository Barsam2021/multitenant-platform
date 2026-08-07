-- P1-1 + P1-3: Domain-Verifizierung mit echtem Status, plus konfigurierbarer App-Port.
--
-- Bisher gab es nur zwei Booleans (dns_verified/tls_issued) und keinerlei Information
-- darueber, WANN zuletzt geprueft wurde oder WARUM eine Pruefung scheiterte. Das
-- Dashboard konnte deshalb nur "ausstehend" anzeigen, ohne Grund und ohne Zeitbezug.
--
-- Idempotent.
\connect admin_dashboard

ALTER TABLE domains ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS last_check_at TIMESTAMPTZ;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS verification_method TEXT;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS is_primary BOOLEAN DEFAULT false;
-- Dateiname des Traefik-Routers dieser Domain. Frueher implizit "<projectSlug>.yml",
-- weshalb sich mehrere Domains desselben Projekts gegenseitig ueberschrieben haben.
ALTER TABLE domains ADD COLUMN IF NOT EXISTS router_file TEXT;

-- Bestandsdaten aus den alten Booleans ableiten.
UPDATE domains SET status = CASE
  WHEN tls_issued  THEN 'live'
  WHEN dns_verified THEN 'tls_pending'
  ELSE 'pending_dns'
END WHERE status IS NULL;

ALTER TABLE domains ALTER COLUMN status SET DEFAULT 'pending_dns';
ALTER TABLE domains DROP CONSTRAINT IF EXISTS domains_status_check;
ALTER TABLE domains ADD CONSTRAINT domains_status_check
  CHECK (status IN ('pending_dns','dns_ok','tls_pending','live','failed'));

CREATE INDEX IF NOT EXISTS idx_domains_status ON domains (status);

-- P1-3: Port und Healthcheck-Pfad pro Projekt statt hart 3000 / "/".
ALTER TABLE projects ADD COLUMN IF NOT EXISTS app_port INTEGER DEFAULT 3000;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS health_path TEXT DEFAULT '/';
UPDATE projects SET app_port = 3000 WHERE app_port IS NULL;
UPDATE projects SET health_path = '/' WHERE health_path IS NULL;
