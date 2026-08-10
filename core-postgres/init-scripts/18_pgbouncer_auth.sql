-- Audit §5: dedizierte Auth-Rolle fuer PgBouncer, damit AUTH_QUERY nicht als
-- Superuser laeuft und trotzdem an pg_shadow kommt.
--
-- Ohne AUTH_QUERY kennt PgBouncer nur die User aus userlist.txt (beim
-- edoburu-Image genau DB_USER, also `postgres`). Die Rollen
-- authenticator_<slug> stehen dort nicht — entweder koennen sie sich gar nicht
-- verbinden, oder das Image pinnt sie auf postgres, und dann laeuft jeder
-- Tenant-PostgREST in seiner Datenbank als Superuser und RLS ist ueberall
-- wirkungslos. Beides ist inakzeptabel; deshalb hier die saubere Variante.
\c postgres

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pgbouncer_auth') THEN
    CREATE ROLE pgbouncer_auth LOGIN;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS pgbouncer_auth AUTHORIZATION pgbouncer_auth;

-- SECURITY DEFINER, damit pgbouncer_auth selbst KEIN Leserecht auf pg_shadow
-- braucht. Die Funktion gibt genau eine Zeile fuer genau einen angefragten
-- Usernamen zurueck, nicht die gesamte Passwort-Tabelle.
CREATE OR REPLACE FUNCTION pgbouncer_auth.user_lookup(IN i_username text,
  OUT usename name, OUT passwd text)
RETURNS record AS $$
BEGIN
  SELECT s.usename, s.passwd FROM pg_catalog.pg_shadow s
    WHERE s.usename = i_username INTO usename, passwd;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION pgbouncer_auth.user_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pgbouncer_auth.user_lookup(text) TO pgbouncer_auth;
GRANT USAGE ON SCHEMA pgbouncer_auth TO pgbouncer_auth;
