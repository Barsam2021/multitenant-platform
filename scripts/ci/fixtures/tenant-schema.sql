-- Testschema fuer den CI-Mandanten. Wird VOR dem Start von PostgREST
-- eingespielt, damit kein Schema-Reload (SIGUSR1) noetig ist.
--
-- Die Rollennamen werden aus current_database() abgeleitet — genau das Muster,
-- das REPO-REVIEW.md §1 fuer Tenant-Migrationen vorschreibt. Hart geschriebene
-- Supabase-Rollennamen (`anon`, `authenticated`) wuerden hier KEINEN Fehler
-- werfen, weil die clusterweiten Alt-Rollen noch existieren — die Policy
-- griffe nur nie. Das Fixture demonstriert deshalb den richtigen Weg.

CREATE TABLE IF NOT EXISTS public.offen (
  id   int PRIMARY KEY,
  wert text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.geschuetzt (
  id   int PRIMARY KEY,
  wert text NOT NULL
);

INSERT INTO public.offen (id, wert) VALUES (1, 'oeffentlich') ON CONFLICT DO NOTHING;
INSERT INTO public.geschuetzt (id, wert) VALUES (1, 'geheim') ON CONFLICT DO NOTHING;

DO $$
DECLARE
  slug      text := regexp_replace(current_database(), '^kunde_', '');
  r_anon    text := 'anon_'          || slug;
  r_auth    text := 'authenticated_' || slug;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r_anon) THEN
    RAISE EXCEPTION 'Rolle % fehlt — falsche Datenbank?', r_anon;
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I, %I', r_anon, r_auth);

  -- Tabelle OHNE RLS, aber mit GRANT: der in ANALYSE_1.md §2 beschriebene
  -- Zustand einer oeffentlich freigegebenen Tenant-DB ohne Policies.
  EXECUTE format('GRANT SELECT, INSERT ON public.offen TO %I, %I', r_anon, r_auth);

  -- Tabelle MIT RLS: anon darf nichts sehen, authenticated alles.
  EXECUTE format('GRANT SELECT ON public.geschuetzt TO %I, %I', r_anon, r_auth);
  EXECUTE 'ALTER TABLE public.geschuetzt ENABLE ROW LEVEL SECURITY';
  EXECUTE format('DROP POLICY IF EXISTS geschuetzt_auth ON public.geschuetzt');
  EXECUTE format('CREATE POLICY geschuetzt_auth ON public.geschuetzt FOR SELECT TO %I USING (true)', r_auth);
END
$$;
