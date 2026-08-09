-- P2-6: Kundenstamm - bisher kannte die Plattform von einem Kunden nur Slug
-- und Tarif. Bei zehn Kunden ist "gutshof" noch selbsterklaerend, bei fuenfzig
-- nicht mehr.
--
-- status='suspended' ist der Standardfall bei Zahlungsverzug: Container
-- stoppen, Traefik-Router entfernen, DB behalten - vorher gab es nur
-- "loeschen oder laufen lassen" (siehe routes/tenants.ts POST .../status).
--
-- Idempotent.
\connect admin_dashboard

ALTER TABLE kunden ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE kunden ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE kunden ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE kunden ADD COLUMN IF NOT EXISTS status TEXT;

UPDATE kunden SET status = 'active' WHERE status IS NULL;

ALTER TABLE kunden ALTER COLUMN status SET DEFAULT 'active';
ALTER TABLE kunden DROP CONSTRAINT IF EXISTS kunden_status_check;
ALTER TABLE kunden ADD CONSTRAINT kunden_status_check CHECK (status IN ('active', 'suspended'));

CREATE INDEX IF NOT EXISTS idx_kunden_status ON kunden (status);
