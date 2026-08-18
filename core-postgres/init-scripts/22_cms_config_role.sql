-- Datenbankrolle des CMS-Dienstes fuer die KONFIGURATION (admin_dashboard).
--
-- Nicht zu verwechseln mit den Rollen cms_<slug>: die geben Zugriff auf die
-- INHALTE eines einzelnen Kunden und werden zur Laufzeit vom Provisioning Agent
-- angelegt (provisioning-agent/src/lib/cms.ts). Diese hier ist eine einzige
-- Rolle fuer den Dienst selbst, mit der er nachschlaegt, welche Sammlungen es
-- gibt und wer sich anmelden darf.
--
-- Warum nicht einfach DATABASE_URL wie im Dashboard: das ist der
-- postgres-Superuser. Der CMS-Dienst ist der einzige Teil der Plattform, der
-- offen im Internet steht — er bekommt genau die Rechte, die er braucht, und
-- keins mehr. Insbesondere KEIN Lesezugriff auf die Secret-Spalten von `kunden`
-- (gotrue_jwt_secret, minio_secret_key_encrypted, anon_jwt, ...); die
-- Spaltenliste unten ist deshalb ausdruecklich einzeln aufgezaehlt und nicht
-- "GRANT SELECT ON kunden".
--
-- Das Passwort steht bewusst NICHT hier (versionierte Datei). Nach dieser
-- Migration einmalig setzen und denselben Wert in CMS_DATABASE_URL eintragen:
--
--   ALTER ROLE cms_config WITH PASSWORD '<geheim>';
--
-- Bis dahin kann sich die Rolle nicht anmelden (LOGIN ohne Passwort wird von
-- scram-/md5-Authentifizierung immer abgelehnt) — die Migration ist also
-- gefahrlos, auch wenn niemand das CMS nutzt.
--
-- Idempotent.
\connect admin_dashboard

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cms_config') THEN
    CREATE ROLE cms_config LOGIN;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE admin_dashboard TO cms_config;
GRANT USAGE ON SCHEMA public TO cms_config;

-- Nur die Spalten, die der Dienst tatsaechlich braucht.
GRANT SELECT (slug, db_name, display_name, cms_enabled, cms_db_password_encrypted)
  ON kunden TO cms_config;

GRANT SELECT ON cms_collections TO cms_config;
GRANT SELECT ON cms_fields TO cms_config;

-- Nutzer: lesen zum Anmelden, schreiben ausschliesslich fuer den
-- Fehlversuchszaehler und den Zeitpunkt der letzten Anmeldung. Anlegen und
-- Loeschen bleibt beim Dashboard.
GRANT SELECT ON cms_users TO cms_config;
GRANT UPDATE (failed_logins, locked_until, last_login_at) ON cms_users TO cms_config;

GRANT SELECT, INSERT ON cms_media TO cms_config;
GRANT INSERT ON cms_audit TO cms_config;
GRANT USAGE ON SEQUENCE cms_audit_id_seq TO cms_config;
