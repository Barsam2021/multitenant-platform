-- P0-2b (Audit 0430f9c) — Bestandsmigration, PRO TENANT-DATENBANK ausfuehren.
-- __SLUG__ wird vom aufrufenden Script ersetzt. Idempotent.
--
-- Reihenfolge ist wichtig:
--   1. Rollen anlegen
--   2. ALLE bestehenden Grants der Cluster-Rollen auf die neuen Rollen kopieren
--   3. Default-Privileges kopieren
--   4. RLS-Policies um die neuen Rollen erweitern
--   5. ERST DANN die Cluster-Rollen dem Authenticator entziehen
-- Wird 5 vor 2-4 gemacht, sind die Kunden-Apps zwischenzeitlich rechtlos.

\set ON_ERROR_STOP on

-- 1 -------------------------------------------------------------------------
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon___SLUG__') THEN
    CREATE ROLE "anon___SLUG__" NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated___SLUG__') THEN
    CREATE ROLE "authenticated___SLUG__" NOLOGIN NOINHERIT;
  END IF;
  -- BYPASSRLS ist ein Rollen-ATTRIBUT und wird NICHT ueber Mitgliedschaft
  -- vererbt — service_role_<slug> braucht es selbst.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role___SLUG__') THEN
    CREATE ROLE "service_role___SLUG__" NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$mig$;

-- 2 --- Grants auf Schemas, Tabellen, Sequenzen, Funktionen kopieren ---------
DO $mig$
DECLARE r record; newrole text;
BEGIN
  FOR r IN
    SELECT n.nspname AS obj, a.privilege_type, pg_get_userbyid(a.grantee) AS grantee
    FROM pg_namespace n, aclexplode(n.nspacl) a
    WHERE n.nspacl IS NOT NULL
      AND pg_get_userbyid(a.grantee) IN ('anon','authenticated','service_role')
  LOOP
    newrole := r.grantee || '___SLUG__';
    EXECUTE format('GRANT %s ON SCHEMA %I TO %I', r.privilege_type, r.obj, newrole);
  END LOOP;

  FOR r IN
    SELECT c.relnamespace::regnamespace::text AS nsp, c.relname, c.relkind,
           a.privilege_type, pg_get_userbyid(a.grantee) AS grantee
    FROM pg_class c, aclexplode(c.relacl) a
    WHERE c.relacl IS NOT NULL
      AND c.relkind IN ('r','p','v','m','f','S')
      AND pg_get_userbyid(a.grantee) IN ('anon','authenticated','service_role')
  LOOP
    newrole := r.grantee || '___SLUG__';
    EXECUTE format('GRANT %s ON %s %I.%I TO %I',
      r.privilege_type,
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
      r.nsp, r.relname, newrole);
  END LOOP;

  FOR r IN
    SELECT p.oid::regprocedure::text AS fn, a.privilege_type,
           pg_get_userbyid(a.grantee) AS grantee
    FROM pg_proc p, aclexplode(p.proacl) a
    WHERE p.proacl IS NOT NULL
      AND pg_get_userbyid(a.grantee) IN ('anon','authenticated','service_role')
  LOOP
    newrole := r.grantee || '___SLUG__';
    EXECUTE format('GRANT %s ON FUNCTION %s TO %I', r.privilege_type, r.fn, newrole);
  END LOOP;
END
$mig$;

-- 3 --- ALTER DEFAULT PRIVILEGES kopieren -----------------------------------
DO $mig$
DECLARE r record; newrole text; objtype text;
BEGIN
  FOR r IN
    SELECT COALESCE(n.nspname, '') AS nsp,
           d.defaclobjtype AS objtype,
           pg_get_userbyid(d.defaclrole) AS owner,
           a.privilege_type,
           pg_get_userbyid(a.grantee) AS grantee
    FROM pg_default_acl d
    LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace,
         aclexplode(d.defaclacl) a
    WHERE pg_get_userbyid(a.grantee) IN ('anon','authenticated','service_role')
  LOOP
    newrole := r.grantee || '___SLUG__';
    objtype := CASE r.objtype
                 WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES'
                 WHEN 'f' THEN 'FUNCTIONS' WHEN 'T' THEN 'TYPES'
                 ELSE NULL END;
    IF objtype IS NULL THEN CONTINUE; END IF;
    IF r.nsp = '' THEN
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT %s ON %s TO %I',
                     r.owner, r.privilege_type, objtype, newrole);
    ELSE
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT %s ON %s TO %I',
                     r.owner, r.nsp, r.privilege_type, objtype, newrole);
    END IF;
  END LOOP;
END
$mig$;

-- 4 --- RLS-Policies um die neuen Rollen erweitern --------------------------
DO $mig$
DECLARE
  r record; existing text[]; extended text[]; nm text;
BEGIN
  FOR r IN
    SELECT pol.polname, pol.polrelid::regclass::text AS tbl, pol.polroles
    FROM pg_policy pol
    WHERE pol.polroles <> '{0}'::oid[]        -- '{0}' = PUBLIC, nichts zu tun
  LOOP
    SELECT array_agg(pg_get_userbyid(o) ORDER BY pg_get_userbyid(o))
      INTO existing FROM unnest(r.polroles) AS o;

    IF NOT (existing && ARRAY['anon','authenticated','service_role']) THEN
      CONTINUE;
    END IF;

    extended := existing;
    FOREACH nm IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF nm = ANY(existing) AND NOT (nm || '___SLUG__') = ANY(existing) THEN
        extended := extended || (nm || '___SLUG__');
      END IF;
    END LOOP;

    EXECUTE format('ALTER POLICY %I ON %s TO %s',
      r.polname, r.tbl,
      (SELECT string_agg(quote_ident(x), ', ') FROM unnest(extended) AS x));
  END LOOP;
END
$mig$;

-- 5 --- Mitgliedschaften umstellen -----------------------------------------
GRANT "anon___SLUG__", "authenticated___SLUG__", "service_role___SLUG__"
  TO "authenticator___SLUG__";

-- Der eigentliche Fix: ab hier kann authenticator___SLUG__ kein
-- SET ROLE service_role mehr machen, also kein clusterweites BYPASSRLS.
REVOKE anon, authenticated, service_role FROM "authenticator___SLUG__";
