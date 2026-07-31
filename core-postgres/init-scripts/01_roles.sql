-- HINWEIS: Die 'authenticator'-Login-Rolle wird NICHT hier erzeugt.
-- Sie ist pro Tenant eindeutig benannt (authenticator_<slug>), weil Postgres-Rollen
-- cluster-weit sind — ein global geteilter Name würde bei jedem neuen Tenant das
-- Passwort des vorherigen überschreiben. Siehe core-postgres/templates/authenticator-role.sql.template,
-- das vom Provisioning Agent pro Tenant mit dem echten Rollennamen befüllt und ausgeführt wird.

-- Anonyme Rolle (nicht eingeloggte Requests)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
END
$$;

-- Eingeloggte Nutzer
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
END
$$;

-- Admin/Server-seitig, umgeht RLS
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$$;
