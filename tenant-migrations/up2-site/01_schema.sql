-- ============================================================================
-- UP2 Web — Schema fuer einen Tenant der MultiTenant-Plattform
-- Portiert aus einem Supabase-pg_dump (Quelle: PostgreSQL 17.6).
--
-- Ausfuehren gegen die Tenant-Datenbank kunde_<slug> im SQL-Editor.
-- Idempotent: mehrfaches Ausfuehren ist gefahrlos.
--
-- Gegenueber dem Original geaendert:
--   * CREATE SCHEMA public entfernt (existiert bereits -> harter Fehler)
--   * Trigger newsletter_on_publish entfernt: ruft supabase_functions.
--     http_request() auf, ein Schema das es nur bei gehostetem Supabase gibt.
--     Den Newsletter-Versand stattdessen in der App ausloesen.
--     (Der Bearer-Token aus dem alten Trigger gehoert rotiert.)
--   * is_admin() entfernt: braucht auth.uid() (Supabase-Helfer, nicht Teil von
--     GoTrue) und eine profiles-Tabelle, die im Dump gar nicht vorkommt.
--     Wortlaut unten als Kommentar erhalten.
--   * Policies zielen jetzt auf die TENANT-Rollen anon_<slug> /
--     authenticated_<slug> / service_role_<slug> statt auf die clusterweiten
--     anon/authenticated/service_role. Seit P0-2b ist der Tenant-Authenticator
--     kein Mitglied der Cluster-Rollen mehr — Policies auf "authenticated"
--     werfen keinen Fehler, greifen aber nie.
--   * GRANTs ergaenzt. Ohne sie meldet PostgREST "permission denied for
--     table", egal wie offen die Policy ist.
--   * COPY-Bloecke entfernt: COPY ... FROM stdin ist Teil des psql-Protokolls
--     und laeuft in keinem Web-SQL-Editor. Daten separat einspielen, siehe
--     Hinweis am Ende.
-- ============================================================================

-- --- TYPEN ------------------------------------------------------------------
-- CREATE TYPE kennt kein IF NOT EXISTS, deshalb die DO-Bloecke.
DO $$ BEGIN
  CREATE TYPE public.client_package AS ENUM ('starter', 'business', 'premium');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.client_status AS ENUM (
    'pending', 'email_sent', 'page_visited', 'form_submitted',
    'meeting_scheduled', 'closed_won', 'closed_lost');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.client_tier AS ENUM ('ku', 'mu', 'gross', 'enterprise');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.package_type AS ENUM ('one_pager', 'standard', 'pro', 'enterprise');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --- FUNKTIONEN -------------------------------------------------------------
-- SECURITY DEFINER braucht ein festgenageltes search_path, sonst kann ein
-- Aufrufer mit eigenem Schema die referenzierten Objekte unterschieben.
CREATE OR REPLACE FUNCTION public.increment_post_views(post_slug text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
begin
  update public.posts set views = views + 1 where slug = post_slug and published = true;
end;
$$;

CREATE OR REPLACE FUNCTION public.sync_client_public() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  insert into public.client_public (slug, salutation, name, company, industry, tier, package)
  values (NEW.slug, NEW.salutation, NEW.name, NEW.company, NEW.industry, NEW.tier, NEW.package)
  on conflict (slug) do update
    set salutation = NEW.salutation,
        name       = NEW.name,
        company    = NEW.company,
        industry   = NEW.industry,
        tier       = NEW.tier,
        package    = NEW.package;
  return NEW;
end;
$$;

-- SECURITY DEFINER: der Trigger feuert, wenn ein anonymer Besucher das
-- Kontaktformular abschickt, und schreibt dabei nach public.clients — einer
-- Tabelle, auf die anon bewusst keinerlei Rechte hat. Ohne DEFINER scheitert
-- jede Formular-Einsendung mit "permission denied for table clients".
-- (Bei Supabase fiel das nicht auf, weil anon dort per Default breite Grants
-- auf public bekommt. Auf dieser Plattform nicht.)
CREATE OR REPLACE FUNCTION public.sync_submission_status() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
begin
  update public.clients
    set submitted_at = NEW.submitted_at,
        status       = 'form_submitted'
  where slug = NEW.client_slug;
  return NEW;
end;
$$;

-- SECURITY DEFINER, gleicher Grund: der Besucher markiert seinen Seitenaufruf
-- auf client_public, der Trigger zieht das nach public.clients nach.
CREATE OR REPLACE FUNCTION public.sync_visited_at() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
begin
  update public.clients
    set visited_at = NEW.visited_at,
        status     = 'page_visited'
  where slug = NEW.slug;
  return NEW;
end;
$$;

CREATE OR REPLACE FUNCTION public.update_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Bewusst NICHT angelegt — auth.uid() existiert auf dieser Plattform nicht und
-- public.profiles kommt im Dump nirgends vor. Wortlaut zur Erinnerung:
--
--   CREATE FUNCTION public.is_admin() RETURNS boolean
--       LANGUAGE plpgsql SECURITY DEFINER AS $fn$
--   BEGIN
--     RETURN EXISTS (SELECT 1 FROM profiles
--                    WHERE id = auth.uid() AND role IN ('admin','kassier'));
--   END;
--   $fn$;
--
-- Keine Policy im Dump ruft sie auf. Wenn du sie brauchst, muss sie erst auf
-- die Nutzerverwaltung dieser Plattform umgeschrieben werden.

-- --- TABELLEN ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.client_public (
    slug text NOT NULL,
    salutation text,
    name text,
    company text,
    industry text,
    tier public.client_tier,
    visited_at timestamp with time zone,
    package public.client_package,
    CONSTRAINT client_public_pkey PRIMARY KEY (slug)
);

CREATE TABLE IF NOT EXISTS public.clients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    salutation text,
    name text NOT NULL,
    company text,
    industry text,
    email text,
    phone text,
    pain_point text,
    tier public.client_tier,
    status public.client_status DEFAULT 'pending'::public.client_status,
    visited_at timestamp with time zone,
    submitted_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    consent boolean DEFAULT false,
    consent_at timestamp with time zone,
    package public.client_package DEFAULT 'starter'::public.client_package,
    CONSTRAINT clients_pkey PRIMARY KEY (id),
    CONSTRAINT clients_slug_key UNIQUE (slug)
);

CREATE TABLE IF NOT EXISTS public.posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    content text NOT NULL,
    category text,
    tags text[],
    published boolean DEFAULT false,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    views integer DEFAULT 0,
    CONSTRAINT posts_pkey PRIMARY KEY (id),
    CONSTRAINT posts_slug_key UNIQUE (slug)
);

CREATE TABLE IF NOT EXISTS public.pricing (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    package public.package_type NOT NULL,
    tier public.client_tier NOT NULL,
    price_monthly integer,
    available boolean DEFAULT true,
    CONSTRAINT pricing_pkey PRIMARY KEY (id),
    CONSTRAINT pricing_package_tier_key UNIQUE (package, tier)
);

CREATE TABLE IF NOT EXISTS public.quiz_leads (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    phone text NOT NULL,
    company text DEFAULT ''::text NOT NULL,
    score integer NOT NULL,
    lead_type text NOT NULL,
    answers jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT quiz_leads_pkey PRIMARY KEY (id),
    CONSTRAINT quiz_leads_lead_type_check
      CHECK (lead_type = ANY (ARRAY['hot'::text, 'warm'::text, 'cold'::text]))
);

CREATE TABLE IF NOT EXISTS public.roi_leads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    branche text NOT NULL,
    tier text NOT NULL,
    auftragswert integer NOT NULL,
    hat_website boolean,
    extra_umsatz integer,
    netto_gewinn integer,
    kosten_up2 integer,
    paket_name text,
    paket_preis integer,
    created_at timestamp with time zone DEFAULT now(),
    new_leads integer,
    new_auftraege integer,
    amortisierung_auftraege integer,
    CONSTRAINT roi_leads_pkey PRIMARY KEY (id),
    CONSTRAINT roi_leads_slug_key UNIQUE (slug)
);

CREATE TABLE IF NOT EXISTS public.submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_slug text,
    name text,
    email text,
    phone text,
    message text,
    interested_package public.package_type,
    submitted_at timestamp with time zone DEFAULT now(),
    CONSTRAINT submissions_pkey PRIMARY KEY (id),
    CONSTRAINT submissions_client_slug_fkey
      FOREIGN KEY (client_slug) REFERENCES public.client_public(slug)
);

CREATE TABLE IF NOT EXISTS public.subscribers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    confirmed boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT subscribers_pkey PRIMARY KEY (id),
    CONSTRAINT subscribers_email_key UNIQUE (email)
);

CREATE TABLE IF NOT EXISTS public.website_checks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    domain text NOT NULL,
    name text NOT NULL,
    company text,
    phone text NOT NULL,
    branche text,
    created_at timestamp with time zone DEFAULT now(),
    email text DEFAULT ''::text,
    CONSTRAINT website_checks_pkey PRIMARY KEY (id)
);

-- --- TRIGGER ----------------------------------------------------------------
-- CREATE TRIGGER kennt kein IF NOT EXISTS -> erst weg, dann neu.
DROP TRIGGER IF EXISTS posts_updated_at            ON public.posts;
DROP TRIGGER IF EXISTS trg_sync_client_public      ON public.clients;
DROP TRIGGER IF EXISTS trg_sync_submission_status  ON public.submissions;
DROP TRIGGER IF EXISTS trg_sync_visited_at         ON public.client_public;
-- Aus dem Supabase-Setup, hier nicht lauffaehig:
DROP TRIGGER IF EXISTS newsletter_on_publish       ON public.posts;

CREATE TRIGGER posts_updated_at BEFORE UPDATE ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER trg_sync_client_public AFTER INSERT OR UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.sync_client_public();

CREATE TRIGGER trg_sync_submission_status AFTER INSERT ON public.submissions
  FOR EACH ROW EXECUTE FUNCTION public.sync_submission_status();

CREATE TRIGGER trg_sync_visited_at AFTER UPDATE OF visited_at ON public.client_public
  FOR EACH ROW EXECUTE FUNCTION public.sync_visited_at();

-- --- ROW LEVEL SECURITY -----------------------------------------------------
ALTER TABLE public.client_public    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pricing          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quiz_leads       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roi_leads        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submissions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscribers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.website_checks   ENABLE ROW LEVEL SECURITY;

-- --- RECHTE UND POLICIES ----------------------------------------------------
DO $up2$
DECLARE
  slug      text;
  r_anon    text;
  r_auth    text;
  r_service text;
BEGIN
  slug := regexp_replace(current_database(), '^kunde_', '');
  r_anon    := 'anon_'          || slug;
  r_auth    := 'authenticated_' || slug;
  r_service := 'service_role_'  || slug;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r_auth) THEN
    RAISE NOTICE 'Tenant-Rollen (%) nicht gefunden — nutze clusterweite Rollen', r_auth;
    r_anon := 'anon'; r_auth := 'authenticated'; r_service := 'service_role';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r_auth) THEN
    RAISE EXCEPTION 'Weder % noch die clusterweiten Rollen existieren. Falsche Datenbank?', r_auth;
  END IF;

  RAISE NOTICE 'Rechte fuer: %, %, %', r_anon, r_auth, r_service;

  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I, %I, %I', r_anon, r_auth, r_service);

  -- Oeffentlich lesbar (RLS schraenkt zusaetzlich ein, z.B. posts auf published)
  EXECUTE format('GRANT SELECT ON public.client_public, public.pricing, public.posts TO %I, %I', r_anon, r_auth);
  -- Besucher markiert seinen Seitenaufruf
  EXECUTE format('GRANT UPDATE ON public.client_public TO %I, %I', r_anon, r_auth);
  -- Formulare: anon darf einwerfen, aber nicht lesen
  EXECUTE format('GRANT INSERT ON public.submissions, public.website_checks, public.quiz_leads, public.subscribers TO %I, %I', r_anon, r_auth);
  EXECUTE format('GRANT SELECT ON public.quiz_leads TO %I', r_auth);
  -- clients und roi_leads bleiben komplett dem Server vorbehalten
  EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA public TO %I', r_service);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I, %I, %I', r_anon, r_auth, r_service);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.increment_post_views(text) TO %I, %I', r_anon, r_auth);

  -- CREATE POLICY kennt kein IF NOT EXISTS -> erst weg, dann neu.
  EXECUTE 'DROP POLICY IF EXISTS clients_service_only        ON public.clients';
  EXECUTE 'DROP POLICY IF EXISTS client_public_read          ON public.client_public';
  EXECUTE 'DROP POLICY IF EXISTS client_public_update_visit  ON public.client_public';
  EXECUTE 'DROP POLICY IF EXISTS posts_public_read           ON public.posts';
  EXECUTE 'DROP POLICY IF EXISTS pricing_public_read         ON public.pricing';
  EXECUTE 'DROP POLICY IF EXISTS quiz_leads_insert           ON public.quiz_leads';
  EXECUTE 'DROP POLICY IF EXISTS quiz_leads_select_none      ON public.quiz_leads';
  EXECUTE 'DROP POLICY IF EXISTS submissions_insert          ON public.submissions';
  EXECUTE 'DROP POLICY IF EXISTS website_checks_insert       ON public.website_checks';
  EXECUTE 'DROP POLICY IF EXISTS subscribers_insert          ON public.subscribers';
  -- Alte Policy-Namen aus dem Supabase-Dump mit entfernen
  EXECUTE 'DROP POLICY IF EXISTS "Admin only"                    ON public.clients';
  EXECUTE 'DROP POLICY IF EXISTS "Public read"                   ON public.client_public';
  EXECUTE 'DROP POLICY IF EXISTS "Public update visited_at"      ON public.client_public';
  EXECUTE 'DROP POLICY IF EXISTS "Public read"                   ON public.pricing';
  EXECUTE 'DROP POLICY IF EXISTS "public read"                   ON public.posts';
  EXECUTE 'DROP POLICY IF EXISTS "INSERT only public quiz_leads" ON public.quiz_leads';
  EXECUTE 'DROP POLICY IF EXISTS "SELECT quiz_leads admin only"  ON public.quiz_leads';
  EXECUTE 'DROP POLICY IF EXISTS "Public insert"                 ON public.submissions';
  EXECUTE 'DROP POLICY IF EXISTS "Public insert"                 ON public.website_checks';
  EXECUTE 'DROP POLICY IF EXISTS "insert only"                   ON public.subscribers';

  -- clients: nur der Server (service_role hat ohnehin BYPASSRLS)
  EXECUTE format(
    'CREATE POLICY clients_service_only ON public.clients FOR ALL TO %I USING (true) WITH CHECK (true)', r_service);

  EXECUTE format(
    'CREATE POLICY client_public_read ON public.client_public FOR SELECT TO %I, %I USING (true)', r_anon, r_auth);
  EXECUTE format(
    'CREATE POLICY client_public_update_visit ON public.client_public FOR UPDATE TO %I, %I USING (true) WITH CHECK (true)', r_anon, r_auth);

  EXECUTE format(
    'CREATE POLICY posts_public_read ON public.posts FOR SELECT TO %I, %I USING (published = true)', r_anon, r_auth);
  EXECUTE format(
    'CREATE POLICY pricing_public_read ON public.pricing FOR SELECT TO %I, %I USING (true)', r_anon, r_auth);

  -- quiz_leads: einwerfen ja, lesen nein (USING (false) wie im Original)
  EXECUTE format(
    'CREATE POLICY quiz_leads_insert ON public.quiz_leads FOR INSERT TO %I, %I WITH CHECK (true)', r_anon, r_auth);
  EXECUTE format(
    'CREATE POLICY quiz_leads_select_none ON public.quiz_leads FOR SELECT TO %I USING (false)', r_auth);

  EXECUTE format(
    'CREATE POLICY submissions_insert ON public.submissions FOR INSERT TO %I, %I WITH CHECK (true)', r_anon, r_auth);
  EXECUTE format(
    'CREATE POLICY website_checks_insert ON public.website_checks FOR INSERT TO %I, %I WITH CHECK (true)', r_anon, r_auth);
  EXECUTE format(
    'CREATE POLICY subscribers_insert ON public.subscribers FOR INSERT TO %I, %I WITH CHECK (true)', r_anon, r_auth);

  -- roi_leads: RLS an, KEINE Policy — genau wie im Original. Damit kommt nur
  -- service_role_<slug> (BYPASSRLS) heran. Absicht, kein Versehen.
END
$up2$;
