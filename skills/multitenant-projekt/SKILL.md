---
name: multitenant-projekt
description: Regeln und Referenz-Vorlagen fuer Projekte, die auf der selbstgehosteten MultiTenant-Plattform (Netcup-VPS, Traefik + PostgREST + GoTrue + MinIO + Nixpacks, Supabase-/Vercel-Ersatz) laufen sollen. IMMER verwenden, wenn ein Projekt fuer diese Plattform gebaut, migriert oder deployt wird - erkennbar an SUPABASE_URL/POSTGREST_URL auf api-<slug>:3000, GOTRUE_URL auf auth-<slug>:9999, S3_BUCKET_NAME=kunde-<slug>-storage, MINIO_ENDPOINT=core-minio, Rollen wie anon_<slug>/authenticated_<slug>/service_role_<slug>, Datenbanken kunde_<slug>, Preview-Domains unter der PLATFORM_DOMAIN, einem Provisioning-Agent oder Admin-Dashboard mit Tenant-Verwaltung. Ebenso verwenden bei Migration eines Supabase-Projekts auf eigene Infrastruktur, beim Schreiben von SQL-Migrationen fuer eine Tenant-Datenbank, beim Anlegen von MinIO-Buckets oder Storage-Uploads, beim Setzen von Env-Variablen fuer den Deploy und bei Nixpacks-Buildfehlern.
---

# Projekte fuer die MultiTenant-Plattform

Diese Plattform ist **Supabase-kompatibel im SDK, nicht im Schema**. Ein
unveraendertes Supabase-Projekt laeuft hier nicht. Die Abweichungen sind wenige,
aber jede einzelne bricht den Deploy vollstaendig.

Vollstaendige Herleitung mit Codestellen: `REPO-REVIEW.md` im Plattform-Repo
(`/opt/multitenant-platform`).

## Zuerst: Slug klaeren

Alles wird aus dem Tenant-Slug abgeleitet. Ohne ihn ist keine Migration und
keine Env-Var korrekt schreibbar. Wenn er nicht bekannt ist: **fragen**, nicht
raten.

| Ressource | Muster | Beispiel (`slug = up2-site`) |
|---|---|---|
| Datenbank | `kunde_<slug>` | `kunde_up2-site` (Unterstrich!) |
| MinIO-Bucket | `kunde-<slug>-storage` | `kunde-up2-site-storage` (Bindestrich!) |
| Rollen | `anon_<slug>`, `authenticated_<slug>`, `service_role_<slug>` | `anon_up2-site` |
| API intern | `http://api-<slug>:3000` | PostgREST |
| Auth intern | `http://auth-<slug>:9999` | GoTrue |

Slug-Regel: `/^[a-z0-9-]+$/`. Kleinbuchstaben, Ziffern, Bindestrich. Sonst nichts.

---

## 1. Migrationen

### Regeln

1. **Reines SQL.** Kein Supabase-CLI, kein Prisma, kein Drizzle-Kit, kein
   Flyway. `supabase db push` / `supabase migration up` existieren hier nicht.
2. **Pfad im Projekt-Repo:** `supabase/migrations/NN_<name>.sql`, aufsteigend
   nummeriert (`01_schema.sql`, `02_seed.sql`, …). Der Pfad ist Konvention —
   es gibt **keinen automatischen Migrations-Laeufer fuer Tenant-Datenbanken**.
   Eingespielt wird von Hand.
3. **Zwingend idempotent.** Ohne Tracking laeuft jedes File beim naechsten
   Einspielen wieder komplett durch.
4. **Rollennamen zur Laufzeit ableiten.** Niemals `TO authenticated` schreiben.
5. **GRANT *und* Policy.** Zwei unabhaengige Tore. Fehlt der GRANT, meldet
   PostgREST `permission denied for table`, egal wie offen die Policy ist.
6. **Kein `CREATE SCHEMA public`**, **kein `auth.uid()`**, **kein
   `COPY ... FROM stdin`**, **keine psql-Meta-Befehle** (`\connect`, `\c`,
   `\gexec`, `\i`) — die laufen nicht durch den SQL-Editor des Dashboards.

### Idempotenz-Muster (die drei, die immer gebraucht werden)

```sql
-- CREATE TYPE kennt kein IF NOT EXISTS
DO $$ BEGIN
  CREATE TYPE public.post_status AS ENUM ('draft','published');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CREATE POLICY kennt kein IF NOT EXISTS -> erst weg, dann neu
DROP POLICY IF EXISTS posts_public_read ON public.posts;

-- Spalte nachtraeglich
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS views integer NOT NULL DEFAULT 0;
```

### Referenz-Migrationsfile

Kopiervorlage. Der `DO`-Block am Ende ist der Teil, der dieses Projekt von
einem Supabase-Projekt unterscheidet — er gehoert in **jede** Migration, die
Rechte oder Policies vergibt.

```sql
-- ============================================================================
-- 01_schema.sql — Schema fuer einen Tenant der MultiTenant-Plattform
--
-- Einspielen (Weg 1, empfohlen, kein 30s-Timeout):
--   docker exec -i core-postgres psql -U postgres -d "kunde_<slug>" \
--     -v ON_ERROR_STOP=1 < supabase/migrations/01_schema.sql
--   docker kill -s SIGUSR1 api-<slug>      # PostgREST-Schema-Cache neu lesen
--
-- Einspielen (Weg 2): Dashboard -> Projekt -> SQL, Schreibmodus aktivieren.
--   Der Reload passiert dort automatisch. 30s statement_timeout beachten.
--
-- Idempotent: mehrfaches Ausfuehren ist gefahrlos.
-- ============================================================================

-- --- TYPEN ------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.post_status AS ENUM ('draft', 'published');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --- TABELLEN ---------------------------------------------------------------
-- gen_random_uuid() ist in Postgres 16 eingebaut, kein pgcrypto noetig.
-- Primaerschluessel nicht weglassen: der Table-Editor und das CMS brauchen ihn,
-- um eine Zeile eindeutig zu adressieren.
CREATE TABLE IF NOT EXISTS public.posts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE,
  title      text NOT NULL,
  body       text,
  status     public.post_status NOT NULL DEFAULT 'draft',
  views      integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.submissions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL,
  message    text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS posts_status_idx ON public.posts (status);

-- --- FUNKTIONEN -------------------------------------------------------------
-- SECURITY DEFINER braucht ein festgenageltes search_path, sonst kann ein
-- Aufrufer mit eigenem Schema die referenzierten Objekte unterschieben.
CREATE OR REPLACE FUNCTION public.increment_post_views(post_slug text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
BEGIN
  UPDATE public.posts SET views = views + 1
   WHERE slug = post_slug AND status = 'published';
END;
$fn$;

-- --- ROW LEVEL SECURITY -----------------------------------------------------
ALTER TABLE public.posts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submissions ENABLE ROW LEVEL SECURITY;

-- --- RECHTE UND POLICIES ----------------------------------------------------
-- Kernstueck. Die Rollen heissen auf dieser Plattform anon_<slug> statt anon.
-- "TO authenticated" wirft KEINEN Fehler (die clusterweite Rolle existiert
-- noch), die Policy greift aber nie -> 200er mit leerem Array, ohne Hinweis.
DO $grants$
DECLARE
  slug      text;
  r_anon    text;
  r_auth    text;
  r_service text;
BEGIN
  slug      := regexp_replace(current_database(), '^kunde_', '');
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

  -- GRANTs. Ohne diese meldet PostgREST "permission denied for table",
  -- unabhaengig von jeder Policy.
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I, %I, %I', r_anon, r_auth, r_service);
  EXECUTE format('GRANT SELECT ON public.posts TO %I, %I', r_anon, r_auth);
  EXECUTE format('GRANT INSERT ON public.submissions TO %I, %I', r_anon, r_auth);
  EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA public TO %I', r_service);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I, %I, %I', r_anon, r_auth, r_service);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.increment_post_views(text) TO %I, %I', r_anon, r_auth);

  -- Policies: erst weg, dann neu (CREATE POLICY kennt kein IF NOT EXISTS).
  EXECUTE 'DROP POLICY IF EXISTS posts_public_read   ON public.posts';
  EXECUTE 'DROP POLICY IF EXISTS submissions_insert  ON public.submissions';
  EXECUTE 'DROP POLICY IF EXISTS submissions_no_read ON public.submissions';

  EXECUTE format(
    'CREATE POLICY posts_public_read ON public.posts FOR SELECT TO %I, %I USING (status = ''published'')',
    r_anon, r_auth);
  -- Formulare: einwerfen ja, lesen nein. Lesen macht der Server mit
  -- service_role_<slug> (BYPASSRLS).
  EXECUTE format(
    'CREATE POLICY submissions_insert ON public.submissions FOR INSERT TO %I, %I WITH CHECK (true)',
    r_anon, r_auth);
  EXECUTE format(
    'CREATE POLICY submissions_no_read ON public.submissions FOR SELECT TO %I USING (false)',
    r_auth);
END
$grants$;
```

### Aus einem Supabase-Dump portieren

`pg_dump` erzeugt Dinge, die hier hart fehlschlagen. Diese Liste abarbeiten:

| Im Dump | Was tun |
|---|---|
| `CREATE SCHEMA public;` | loeschen — existiert bereits, harter Fehler |
| `TO anon` / `TO authenticated` / `TO service_role` | in den `DO`-Block oben umbauen |
| `auth.uid()`, `auth.jwt()`, `auth.role()` | existiert nicht. Policy umbauen oder Pruefung in die App verlegen |
| `COPY ... FROM stdin;` | Datenteil separat: `pg_dump --data-only --column-inserts` |
| `CREATE EXTENSION` | in der Tenant-DB nicht vorhanden. `gen_random_uuid()` ist in PG16 eingebaut, `uuid_generate_v4()` (uuid-ossp) nicht |
| Trigger auf `supabase_functions.http_request()` | Schema existiert nicht. Webhook in der App ausloesen; alten Bearer-Token rotieren |
| `storage.objects`, Storage-Policies | kein Storage-Schema. Siehe Abschnitt 2 |
| `ALTER ... OWNER TO supabase_admin` | loeschen |
| PG-17-Syntax | Ziel ist Postgres 16 |

---

## 2. Storage / MinIO

### Struktur

**Ein** Bucket pro Tenant. Supabase-Buckets werden zu **Praefixen**.

```
kunde-<slug>-storage/
├── public/                       ← EINZIGES anonym lesbares Praefix
│   └── <YYYY>/<MM>/<name>-<8-hex>.<ext>
│       z.B. public/2026/08/team-foto-a3f9c211.webp
├── avatars/                      ← privat (frueher Supabase-Bucket "avatars")
├── documents/                    ← privat
└── ...                           ← alles Uebrige: privat, 403 ohne Credentials
```

Der Bucket wird beim Anlegen des Tenants automatisch erzeugt — **nicht selbst
anlegen**. `mc mb` auf einen anderen Namen laeuft ins Leere: die IAM-Policy des
Tenants erlaubt ausschliesslich `arn:aws:s3:::kunde-<slug>-storage` und
`.../*`, jeder andere Bucket antwortet mit `AccessDenied`.

### Regeln

1. **`supabase.storage.from('bucket')` gibt es nicht.** Kein Storage-Service,
   keine Storage-API, keine Storage-RLS. Zugriff nur ueber das S3-SDK.
2. **Alles Oeffentliche gehoert unter `public/`.** Die anonyme Download-Policy
   steht ausschliesslich auf diesem Praefix. Eine Datei unter `uploads/` ist
   ueber die oeffentliche URL 403 — kommentarlos.
3. **Die anonyme Freigabe wird erst mit dem CMS gesetzt.** Ohne aktiviertes CMS
   ist auch `public/` privat. Wenn ein Projekt oeffentliche Dateien ohne CMS
   braucht: beim Betreiber anfordern, nicht selbst umkonfigurieren.
4. **Upload serverseitig, nicht per presigned URL aus dem Browser.** Typ, Groesse
   und Bildinhalt muessen vorher geprueft werden.
5. **Kein SVG annehmen** — darf Skript enthalten und laeuft unter der Domain des
   Kunden. Erlaubt: JPEG, PNG, WebP, AVIF, GIF, PDF.
6. **Oeffentliche URL** ist `${MEDIA_PUBLIC_BASE_URL}/kunde-<slug>-storage/<key>`,
   **nicht** `MINIO_ENDPOINT` — das ist ein Docker-interner Name, den kein
   Browser aufloest.

### Referenz-Upload

```ts
// lib/storage.ts — S3-SDK gegen MinIO. Alle Werte kommen aus der
// Auto-Injection der Plattform, nichts davon selbst setzen.
import { Client as MinioClient } from "minio";
import crypto from "crypto";

const client = new MinioClient({
  endPoint: (process.env.MINIO_ENDPOINT || "http://core-minio:9000")
    .replace(/^https?:\/\//, "").split(":")[0],
  port: 9000,
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY!,
  secretKey: process.env.MINIO_SECRET_KEY!,
});

const BUCKET = process.env.S3_BUCKET_NAME!;          // kunde-<slug>-storage
const PUBLIC_BASE = process.env.MEDIA_PUBLIC_BASE_URL!; // https://media.<domain>

/** Oeffentlich ausgeliefert: NUR unter dem Praefix "public/". */
export function publicKey(originalName: string, ext: string): string {
  const now = new Date();
  const base = originalName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const rand = crypto.randomBytes(4).toString("hex");
  return `public/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${base}-${rand}.${ext}`;
}

export async function uploadPublic(key: string, body: Buffer, contentType: string) {
  await client.putObject(BUCKET, key, body, body.length, {
    "Content-Type": contentType,
    // Der Schluessel enthaelt einen Zufallsanteil — eine Datei aendert sich nie
    // unter derselben Adresse, lange Cache-Zeit ist gefahrlos.
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  return `${PUBLIC_BASE}/${BUCKET}/${key}`;
}

/** Privat: jedes Praefix ausser "public/". Nur serverseitig lesbar. */
export async function uploadPrivate(key: string, body: Buffer, contentType: string) {
  if (key.startsWith("public/")) throw new Error("Privates Objekt gehoert nicht unter public/");
  await client.putObject(BUCKET, key, body, body.length, { "Content-Type": contentType });
  return key; // keine oeffentliche URL — Auslieferung ueber eine eigene Route
}
```

---

## 3. Auth / GoTrue

### Was die Plattform vorgibt (nicht ueberschreibbar)

- Der `role`-Claim in jedem Token ist **`authenticated_<slug>`**, Admin-Rolle ist
  **`service_role_<slug>`**. Code, der auf `role === "authenticated"` prueft, ist
  falsch.
- **`GOTRUE_DISABLE_SIGNUP=true`** — Selbstregistrierung ist plattformweit aus.
  Braucht die App ein Signup-Formular: beim Betreiber anfragen, bevor gebaut
  wird. Ohne Freischaltung ist das Formular tot.
- **`GOTRUE_MAILER_AUTOCONFIRM=false`** — Registrierung braucht eine bestaetigte
  Mail (Resend/SMTP zentral konfiguriert).
- GoTrue-Tabellen liegen im Schema **`auth`**, nicht `public`. PostgREST bedient
  ausschliesslich `public` — `auth.users` ist ueber die API nicht sichtbar.
- Tokens haben **kein `exp` und kein `aud`**, dafuer `iss:
  'multitenant-platform'`. Wer `aud: 'authenticated'` prueft, verwirft sie.
- `auth.uid()` existiert nicht (siehe Abschnitt 1).

### Env-Variablen: was NIEMALS selbst gesetzt wird

Diese Namen injiziert der Provisioning-Agent beim Deploy. Selbst gesetzte Werte
werden ueberschrieben oder brechen die App:

```
MINIO_ENDPOINT  MINIO_ACCESS_KEY  MINIO_SECRET_KEY  S3_BUCKET_NAME
GOTRUE_URL  JWT_SECRET  POSTGREST_URL
SUPABASE_URL  SUPABASE_ANON_KEY  SUPABASE_SERVICE_ROLE_KEY
NEXT_PUBLIC_SUPABASE_URL  NEXT_PUBLIC_SUPABASE_ANON_KEY
```

`.env.example` im Projekt-Repo darf sie dokumentieren (mit Platzhaltern), aber
sie gehoeren nicht ins Dashboard und nicht in eine committete `.env`.

### `NEXT_PUBLIC_SUPABASE_URL` fehlt zur Laufzeit

Das ist der haeufigste Deploy-Blocker und **kein Bug**: die beiden
`NEXT_PUBLIC_`-Variablen werden nur gesetzt, wenn die oeffentliche PostgREST-URL
fuer diesen Tenant freigeschaltet ist. Bewusst opt-in — ohne RLS-Policies waere
die Datenbank sonst mit dem Anon-Key fuer jeden lesbar.

Loesung: beim Betreiber `public-access` fuer PostgREST anfordern
(`POST /tenants/<slug>/public-access {"service":"postgrest","enabled":true}`),
**danach** neu deployen. Kein Fallback auf `http://api-<slug>:3000` einbauen —
diese Adresse ist im Browser nicht aufloesbar.

### Referenz-Client

```ts
// Serverseitig: interne URL, service_role fuer alles, was RLS umgehen soll.
import { createClient } from "@supabase/supabase-js";

export const serverClient = createClient(
  process.env.SUPABASE_URL!,               // http://api-<slug>:3000
  process.env.SUPABASE_SERVICE_ROLE_KEY!,  // BYPASSRLS — nie ins Client-Bundle
  { auth: { persistSession: false } }
);

// Browserseitig: nur die NEXT_PUBLIC_-Variablen. Fehlen sie, ist public-access
// nicht freigeschaltet — nicht auf die interne URL ausweichen.
import { createBrowserClient } from "@supabase/ssr";

export const browserClient = () =>
  createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
```

---

## 4. Deployment (Nixpacks)

### Harte Anforderungen

| Anforderung | Wert | Folge bei Verstoss |
|---|---|---|
| App im **Repo-Root** | kein Monorepo-Unterpfad einstellbar | Build findet nichts |
| `package.json` | `build`- **und** `start`-Script | `missing script: build\|start` |
| Listen-Adresse | **`0.0.0.0`**, nicht `127.0.0.1` | Healthcheck erreicht den Container nie |
| Port | 3000 (pro Projekt einstellbar) | Healthcheck laeuft ins Leere |
| Healthcheck | Pfad `/` antwortet in **< 60 s** mit **< 500** | Deploy wird zurueckgerollt |
| Speicher | 512 MB (starter/business), 1 GB (premium) | OOM-Kill, sichtbar nur als „Healthcheck FAILED" |
| Build-Dauer | < 10 Minuten hart | Abbruch |
| Node-Version | Default 20 | `nixpacks.toml` mitbringen, wenn anders |

### Der Build hat KEINEN Netzzugriff auf die eigene API

PostgREST, GoTrue und MinIO haengen in einem anderen Netz als der Build. Wer
Seiten zur Build-Zeit statisch aus der eigenen Datenbank rendert, backt eine
leere Seite ein — und die bleibt leer, obwohl zur Laufzeit alles erreichbar ist.

```ts
// Datengetriebene Seiten brauchen Laufzeit-Rendering:
export const revalidate = 60;     // ISR
// oder
export const dynamic = "force-dynamic";
```

### Node-Version festlegen

`.nvmrc` und `engines.node` greifen nur, solange keine `nixpacks.toml` existiert
— und die Plattform legt eine an, sobald keine da ist. Wer eine bestimmte
Version braucht, bringt sie selbst mit:

```toml
# nixpacks.toml — hat Vorrang vor dem Plattform-Default
[phases.setup]
nixPkgs = ["nodejs_22"]
```

### Env-Var-Benennung: Build-Zeit vs. Laufzeit

Zur Build-Zeit steht **nicht** alles zur Verfuegung. Ausgefiltert wird jeder
Name, der auf `SECRET`, `PASSWORD`, `PASSWD`, `PRIVATE_KEY`, `ACCESS_KEY`,
`_KEY` (am Ende), `TOKEN` oder `CREDENTIAL` matcht — plus fest `JWT_SECRET`,
`SUPABASE_SERVICE_ROLE_KEY`, `MINIO_SECRET_KEY`, `DATABASE_URL`,
`POSTGRES_PASSWORD`.

Durchgelassen wird alles mit den Praefixen `NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`,
`REACT_APP_`, `NUXT_PUBLIC_`, `GATSBY_`, `EXPO_PUBLIC_`.

```
# Wird beim Build ausgefiltert (endet auf _KEY) -> zur Build-Zeit undefined:
STRIPE_PUBLIC_KEY=pk_live_...

# Richtig, wenn der Wert beim Build gebraucht wird:
NEXT_PUBLIC_STRIPE_KEY=pk_live_...
```

Faustregel: was ins Client-Bundle gehoert, bekommt ein `NEXT_PUBLIC_`-Praefix.
Was geheim ist, wird nur zur Laufzeit gelesen — nie auf Modulebene
(`new Stripe(...)` im Modul-Scope wirft schon beim Build).

**Jede Env-Aenderung braucht einen Redeploy**, kein Neustart. `NEXT_PUBLIC_*`
sind fest ins Bundle eingebacken.

### Kein `DATABASE_URL`

Die App bekommt **keine** direkte Postgres-Verbindung — nur PostgREST und
GoTrue. Prisma, Drizzle, TypeORM oder ein `pg`-Client gegen die Tenant-DB sind
nicht vorgesehen. Datenzugriff laeuft ueber `@supabase/supabase-js` gegen
`SUPABASE_URL`.

### Was es hier nicht gibt

Edge Functions, Realtime/WebSockets, `supabase.channel()`, Supabase Storage-API,
Vercel-spezifisches (`@vercel/*`, `vercel.json`, Vercel-KV/Blob), Cron in der
App. Serverseitige Logik gehoert in die Next.js-App selbst.

---

## 5. Checkliste vor dem ersten Deploy

- [ ] Slug bekannt und `[a-z0-9-]+`
- [ ] Migration unter `supabase/migrations/NN_*.sql`, idempotent, mit
      `current_database()`-Rollenableitung, GRANTs **und** Policies
- [ ] Kein `auth.uid()`, kein `CREATE SCHEMA public`, kein `COPY`, keine
      psql-Meta-Befehle
- [ ] Storage: nur `kunde-<slug>-storage`, Oeffentliches unter `public/`,
      kein `supabase.storage`
- [ ] Keine plattformverwaltete Env-Var selbst gesetzt
- [ ] Build-Zeit-Variablen mit `NEXT_PUBLIC_`-Praefix benannt
- [ ] `build` + `start` in `package.json`, Listen auf `0.0.0.0`
- [ ] Datengetriebene Seiten mit `revalidate` oder `force-dynamic`
- [ ] `public-access` fuer PostgREST angefordert, falls die App
      `NEXT_PUBLIC_SUPABASE_URL` braucht
- [ ] Nach manuellem Schema-Einspielen: `docker kill -s SIGUSR1 api-<slug>`

## 6. Wenn etwas nicht laeuft

| Symptom | Ursache |
|---|---|
| `PGRST205 Could not find the table in the schema cache` | PostgREST-Reload fehlt → `docker kill -s SIGUSR1 api-<slug>` |
| `permission denied for table` | GRANT fehlt (Policy allein reicht nicht) |
| 200er mit leerem Array, obwohl Daten da sind | Policy zielt auf `authenticated` statt `authenticated_<slug>` |
| `function auth.uid() does not exist` | Supabase-Helfer, existiert hier nicht |
| `Missing NEXT_PUBLIC_SUPABASE_URL` | `public-access` fuer PostgREST nicht freigeschaltet |
| `AccessDenied` bei Upload | falscher Bucket-Name — nur `kunde-<slug>-storage` ist erlaubt |
| 403 auf eine Datei-URL | Objekt liegt nicht unter `public/`, oder CMS nie aktiviert |
| „Healthcheck FAILED" ohne weiteren Fehler | falscher Port, Listen auf `127.0.0.1`, oder OOM (512 MB) |
| `prepared statement does not exist` | PgBouncer im Transaction-Mode — Prepared Statements abschalten |
| Seite zeigt alte/leere Daten | statisch gebaut ohne API-Zugriff → `revalidate` setzen |
