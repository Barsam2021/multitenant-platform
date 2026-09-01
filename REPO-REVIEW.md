# REPO-REVIEW — Was ein neues Projekt mitbringen muss

Ergebnis einer Lese-Analyse des Repos (Stand `0b0d3bb`, 2026-08-26). Ziel ist
nicht die Reparatur bestehender Projekte, sondern die Frage: **wie muss ein NEUES
Projekt aussehen, damit es auf dieser Plattform ohne Nacharbeit deploybar ist?**

Jeder Punkt nennt die Codestelle, aus der er stammt. Was im Code nicht eindeutig
belegbar war, steht unten unter [§6 Offene Punkte](#6-offene-punkte) — nicht geraten.

---

## 1. DB-Schema und Migrations-Format

Es gibt **zwei getrennte Migrations-Ebenen** mit unterschiedlichen Regeln. Sie
werden regelmäßig verwechselt; das ist die erste Fehlerquelle.

### Ebene A — Plattform-Migrationen (`core-postgres/init-scripts/`)

Betreffen die Plattform selbst (`admin_dashboard`), **nicht** Kundenprojekte. Für
ein neues Kundenprojekt normalerweise irrelevant — hier nur, damit die Abgrenzung
klar ist.

| Aspekt | Vorgabe |
|---|---|
| Format | reines SQL, kein Migrations-Tool (kein Prisma/Drizzle/Flyway/sqitch) |
| Pfad | `core-postgres/init-scripts/` |
| Naming | `NN_<name>.sql`, zweistellig, lexikografisch sortiert |
| Erste Zeile | `\connect admin_dashboard` (Ausnahme: `00_admin_dashboard.sql`, das gegen die Default-DB `postgres` läuft) |
| Idempotenz | **zwingend** — `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `\gexec`-Trick für `CREATE DATABASE` |

**Wo die Logik liegt:**

- `core-postgres/docker-compose.yml:58` — `./init-scripts:/docker-entrypoint-initdb.d:ro`.
  Postgres führt das **nur bei leerem Datenverzeichnis** aus, also genau einmal
  im Leben eines Servers.
- `scripts/migrate.sh` — der Nachfahr-Pfad für laufende Installationen. Iteriert
  `find "$INIT" -maxdepth 1 -name '*.sql' | sort`, führt jede Datei mit
  `psql -U postgres -v ON_ERROR_STOP=1` aus (ohne `-d`, deshalb das `\connect`
  in Zeile 1) und trackt sie in `public.schema_migrations(filename, checksum,
  applied_at)` **in der Datenbank `postgres`** — nicht in `admin_dashboard`.
  Modi: ohne Argument nur Neues, `--force` alles erneut, `--status` nur anzeigen.

**Stolperstellen dieser Ebene:** die Nummern `12_` und `13_` sind je doppelt
vergeben (`12_project_lifecycle` / `12_saved_queries`, `13_deployment_extras` /
`13_env_dirty`). Die Reihenfolge innerhalb einer Nummer ist damit alphabetisch
und nicht fachlich gemeint — eine neue Migration bekommt die nächste freie
Nummer, aktuell `25_`.

### Ebene B — Tenant-/Projekt-Schema (das, was ein neues Projekt betrifft)

**Wichtigster Befund: es gibt keinen automatischen Migrations-Läufer für
Tenant-Datenbanken.** Kein Code liest `tenant-migrations/`. Der Ordner ist reine
Konvention aus der up2-site-Portierung (`tenant-migrations/up2-site/README.md`
sagt selbst: „nach erfolgreichem Import kann dieser Ordner weg").

Was der Provisioning-Agent beim Anlegen eines Tenants tatsächlich in der
Tenant-DB macht (`provisioning-agent/src/lib/tenantDatabase.ts:110-170`,
`provisionTenantDatabase()`):

1. `CREATE DATABASE kunde_<slug>`
2. `REVOKE ALL ON DATABASE ... FROM PUBLIC`
3. Rollen aus `core-postgres/templates/authenticator-role.sql.template` mit
   ersetzten Platzhaltern
4. `CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION authenticator_<slug>`
5. `ALTER ROLE ... SET search_path = auth, public`
6. `GRANT CONNECT, TEMPORARY ON DATABASE ... TO authenticator_<slug>`
7. GoTrue-Container hoch (legt seine `auth.*`-Tabellen selbst per eigener
   Migration an), auf `/health` warten, dann PostgREST hoch

**Danach ist die `public`-Schema der Tenant-DB leer.** Das Anwendungsschema
kommt zu 100 % vom Projekt und wird von Hand eingespielt.

#### Die zwei unterstützten Wege, ein Tenant-Schema einzuspielen

**Weg 1 — psql von der VPS (empfohlen für alles Größere):**

```bash
docker exec -i core-postgres psql -U postgres -d "kunde_<slug>" \
  -v ON_ERROR_STOP=1 < supabase/migrations/0001_init.sql
```

**Weg 2 — SQL-Editor im Dashboard** (`/dashboard/projects/<slug>/sql`):
`dashboard/src/app/api/tenants/[slug]/query/route.ts` → `runSql()` in
`dashboard/src/lib/tenantDb.ts:230-280`. Verbindet als **`postgres`-Superuser**
über PgBouncer.

Der SQL-Editor hat harte Grenzen, die ein Migrations-File verletzen kann:

| Grenze | Wert | Codestelle | Konsequenz für Migrations-Files |
|---|---|---|---|
| `statement_timeout` | 30 s | `tenantDb.ts:227` | Große Schemata/Datenimporte brechen ab → Weg 1 nehmen |
| Zeilenlimit | 1000 | `tenantDb.ts:228` | betrifft nur Ausgabe, nicht DDL |
| `readOnly` | Default **true** | `query/route.ts:41` | UI muss auf Schreibmodus stehen, sonst schlägt jedes DDL fehl |
| Treiber | `node-postgres`, nicht psql | `tenantDb.ts` | **keine psql-Meta-Befehle**: `\connect`, `\c`, `\gexec`, `\i`, `COPY ... FROM stdin` laufen nicht |

Nach schema-änderndem SQL (`/\b(create\|drop\|alter\|grant\|revoke\|comment\|rename)\b/i`,
`query/route.ts:15`) stößt das Dashboard automatisch
`POST /tenants/<slug>/postgrest/reload` an → `SIGUSR1` an `api-<slug>`
(`provisioning-agent/src/routes/tenants.ts:44`). Bei Weg 1 passiert das **nicht**
— dort manuell: `docker kill -s SIGUSR1 api-<slug>`. Ohne Reload antwortet die
Kunden-API mit `PGRST205 Could not find the table in the schema cache`
(`docs/OPERATIONS.md:100-115`).

#### Pflichtform eines Tenant-Migrations-Files

Verbindliches Referenz-Beispiel im Repo: **`tenant-migrations/up2-site/01_schema.sql`**
(390 Zeilen, portiertes Supabase-Schema). Daraus abgeleitet:

- **Pfad/Naming (Konvention, nicht erzwungen):** `tenant-migrations/<tenant-slug>/NN_<name>.sql`,
  aufsteigend, `01_schema.sql` zuerst, Daten danach getrennt.
- **Idempotent**, weil es kein Tracking gibt und jedes erneute Einspielen wieder
  von vorn läuft: `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`,
  `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL; END $$` für `CREATE TYPE`
  (kennt kein `IF NOT EXISTS`), `DROP POLICY IF EXISTS` vor jedem `CREATE POLICY`
  (kennt ebenfalls kein `IF NOT EXISTS`).
- **Kein `CREATE SCHEMA public`** — existiert bereits, harter Fehler.
- **Rollennamen zur Laufzeit ableiten, nie hart schreiben.** Das ist der Kern des
  Ganzen (siehe §5): Policies und GRANTs müssen auf `anon_<slug>` /
  `authenticated_<slug>` / `service_role_<slug>` zielen. Das Referenzfile löst
  das über `current_database()`:

  ```sql
  slug := regexp_replace(current_database(), '^kunde_', '');
  r_anon    := 'anon_'          || slug;
  r_auth    := 'authenticated_' || slug;
  r_service := 'service_role_'  || slug;
  ```
  (`01_schema.sql:300-320`, inklusive Fallback auf die clusterweiten Rollen und
  `RAISE EXCEPTION`, wenn keine der beiden existiert — „falsche Datenbank?")

- **GRANTs sind Pflicht, zusätzlich zu RLS.** Ohne `GRANT` meldet PostgREST
  `permission denied for table`, egal wie offen die Policy ist. RLS und GRANT
  sind zwei unabhängige Tore, beide müssen offen sein.
- **Keine `COPY ... FROM stdin`-Blöcke.** Daten getrennt, per
  `pg_dump --data-only --column-inserts`.

---

## 2. Storage / MinIO-Bucket-Struktur

### Namenskonvention (hart im Code, an fünf Stellen identisch)

| Objekt | Muster | Codestelle |
|---|---|---|
| Bucket | `kunde-<slug>-storage` | `index.ts:351`, `secrets.ts:134`, `cms/src/lib/media.ts:59` |
| IAM-Policy | `kunde-<slug>-policy` | `index.ts:372` |
| IAM-User | 32-hex Zufalls-Access-Key (kein sprechender Name) | `index.ts:356` |

Beachten: der **Bucket** nutzt Bindestriche (`kunde-up2-site-storage`), die
**Datenbank** Unterstrich plus Slug (`kunde_up2-site`). Das ist kein Tippfehler,
sondern S3-Namensregeln vs. Postgres-Identifier.

### Mandantentrennung

Ein Bucket pro Tenant, ein IAM-User pro Tenant, eine Policy pro Tenant. Die
Policy beschränkt exakt auf die beiden ARNs des eigenen Buckets
(`index.ts:358-373`):

```json
{ "Version": "2012-10-17", "Statement": [{
  "Effect": "Allow",
  "Action": ["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:ListBucket"],
  "Resource": ["arn:aws:s3:::kunde-<slug>-storage",
               "arn:aws:s3:::kunde-<slug>-storage/*"] }] }
```

Der Bucket wird **immer** angelegt, auch für Tenants ohne Datenbank
(`index.ts:346`: „MinIO hängt NICHT an der Datenbank-Entscheidung").

### Erwartete Ordnerhierarchie im Bucket

**Genau ein Präfix ist besonders: `public/`.** Es ist die Grenze zwischen
ausgeliefert und nicht ausgeliefert.

```
kunde-<slug>-storage/
├── public/              ← anonym lesbar (mc anonymous set download)
│   └── <YYYY>/<MM>/<name>-<8-hex>.<ext>
└── <alles andere>/      ← privat, nur mit IAM-Credentials
```

- Freigabe: `mc anonymous set download localminio/kunde-<slug>-storage/public`
  (`provisioning-agent/src/lib/cms.ts:359-366`, `publishTenantMediaPrefix()`).
  Läuft **nur beim Aktivieren des CMS** — ein Projekt ohne CMS hat einen komplett
  privaten Bucket.
- Objektschlüssel des CMS (`cms/src/lib/media.ts:164-168`):
  `public/2026/08/mein-bild-a3f9c211.webp`

Bilder werden beim Upload zwangsweise nach WebP neu kodiert (EXIF-Strip,
Resize auf max. 2400 px), erlaubt sind JPEG/PNG/WebP/AVIF/GIF/PDF — **SVG
bewusst nicht** (XSS-Vektor), `media.ts:27-34`.

### Was bricht, wenn ein Projekt eine andere Struktur mitbringt

Konkret der Supabase-Storage-Fall:

1. **Supabase-Bucket-Namen existieren hier nicht.** Supabase hat mehrere logische
   Buckets pro Projekt (`avatars`, `public`, `documents`) unter einer API. Hier
   gibt es **einen** physischen Bucket pro Tenant. Ein Projekt, das
   `supabase.storage.from('avatars')` aufruft, bekommt keinen Fehler mit dem
   Hinweis „Bucket fehlt" — es hat gar keine Storage-API. Der Bucket `avatars`
   wird nie angelegt, `mc` kennt ihn nicht, die IAM-Policy deckt ihn nicht ab
   (`s3:*` nur auf `kunde-<slug>-storage`). Ergebnis: `AccessDenied`, auch wenn
   jemand den Bucket von Hand nachlegt.
   → Umsetzung hier: Supabase-Buckets werden zu **Präfixen** im einen Bucket.
2. **Es gibt keinen Storage-Service.** Kein `storage-api`-Container, kein
   `storage`-Schema in der Datenbank, keine `storage.objects`-Tabelle, keine
   RLS-Policies auf Storage. Zugriff läuft ausschließlich über das S3-SDK mit
   `MINIO_*`-Credentials — also **serverseitig**. Presigned URLs direkt aus dem
   Browser sind nicht vorgesehen (`media.ts:6-11` begründet das: Typ, Größe und
   Bildinhalt müssen vor dem Ablegen geprüft werden).
3. **Alles außerhalb von `public/` ist per Default 403.** Ein Projekt, das
   Dateien nach `uploads/` oder `media/` schreibt und die URL direkt im `<img>`
   ausliefert, bekommt kommentarlos 403 — der Bucket ist vollständig privat, und
   die anonyme Download-Policy steht ausschließlich auf `public/`.
4. **Öffentliche URL ≠ MinIO-Endpoint.** Die ausgelieferte Adresse ist
   `${MEDIA_PUBLIC_BASE_URL}/kunde-<slug>-storage/<objectKey>`
   (`media.ts:180`), also der Traefik-Router auf `core-minio` — nicht
   `http://core-minio:9000`, das ist ein Docker-interner Name, den kein Browser
   auflöst.

---

## 3. Auth / GoTrue-Erwartungen

GoTrue wird **nicht vom Projekt konfiguriert**, sondern vollständig aus
`provisioning-agent/templates/tenant-compose.yml` erzeugt. Ein neues Projekt
kann dort nichts überschreiben — es muss sich an die vorhandene Konfiguration
anpassen. Was gesetzt wird:

| Env-Var | Wert | Warum es das Projekt betrifft |
|---|---|---|
| `GOTRUE_JWT_SECRET` | pro Tenant, 32 Byte hex | signiert auch `anon`/`service_role`-JWT |
| `GOTRUE_DB_DRIVER` | `postgres` | |
| `GOTRUE_DB_DATABASE_URL` | `postgres://authenticator_<slug>:<pw>@pgbouncer:5432/kunde_<slug>?search_path=auth` | GoTrue-Tabellen liegen in `auth`, nicht `public` |
| `GOTRUE_API_HOST` / `GOTRUE_API_PORT` | `0.0.0.0` / `9999` | interne Adresse ist `http://auth-<slug>:9999` |
| `GOTRUE_SITE_URL` / `API_EXTERNAL_URL` | `https://<slug>.<PLATFORM_DOMAIN>` | Redirect-Ziel nach Mail-Bestätigung |
| `GOTRUE_JWT_DEFAULT_GROUP_NAME` | **`authenticated_<slug>`** | der `role`-Claim im Token; PostgREST macht damit `SET ROLE` |
| `GOTRUE_JWT_ADMIN_ROLES` | **`service_role_<slug>`** | |
| `GOTRUE_MAILER_AUTOCONFIRM` | `false` | Registrierung braucht eine bestätigte Mail |
| `GOTRUE_DISABLE_SIGNUP` | **`true`** | **Self-Signup ist plattformweit aus** (P2-11) |
| `GOTRUE_SMTP_*` | Resend, Pass = globales `RESEND_API_KEY` | ohne diesen Wert verschickt GoTrue nichts |

**Zwei Konsequenzen, die neue Projekte regelmäßig treffen:**

1. `GOTRUE_DISABLE_SIGNUP=true` + `GOTRUE_MAILER_AUTOCONFIRM=false`: Ein
   frisch provisionierter Tenant erlaubt **keine** Selbstregistrierung. Eine App
   mit Signup-Formular funktioniert erst, wenn der Schalter für diesen Tenant
   bewusst umgelegt wird. Fehlt zusätzlich `RESEND_API_KEY` in der Plattform-
   `.env`, kann sich niemand registrieren — `tenantDatabase.ts:79-85` warnt
   beim Provisioning explizit, aber nur in den Agent-Logs.
2. Der `role`-Claim ist tenant-spezifisch. Ein hart auf `"authenticated"` oder
   `"service_role"` geprüfter Claim in der App ist falsch (siehe §5).

### Was die App an Auth-Env-Vars bekommt

Automatisch injiziert von `provisioning-agent/src/lib/secrets.ts:98-140`
(`buildEnvVars()`) — **die App darf diese Namen nicht selbst setzen**, sie werden
beim Deploy überschrieben:

```
# immer:
MINIO_ENDPOINT=http://core-minio:9000
MINIO_ACCESS_KEY=<hex>
MINIO_SECRET_KEY=<hex>
S3_BUCKET_NAME=kunde-<slug>-storage

# nur wenn der Tenant eine Datenbank hat (db_enabled):
GOTRUE_URL=http://auth-<slug>:9999
JWT_SECRET=<hex>
POSTGREST_URL=http://api-<slug>:3000
SUPABASE_URL=http://api-<slug>:3000          # Alias für Supabase-SDKs
SUPABASE_ANON_KEY=<jwt>
SUPABASE_SERVICE_ROLE_KEY=<jwt>

# NUR wenn public-access für PostgREST freigeschaltet wurde:
NEXT_PUBLIC_SUPABASE_URL=https://<slug>-api.<PLATFORM_DOMAIN>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<jwt>
```

Die letzten beiden sind der häufigste Deploy-Blocker: `@supabase/ssr`
(`createBrowserClient`) braucht sie zwingend, aber sie werden **nur** gesetzt,
wenn vorher `POST /tenants/<slug>/public-access {service:'postgrest',
enabled:true}` gelaufen ist (`routes/tenants.ts:100-133`). Bewusst kein Fallback
auf die interne URL — ein Browser kann `api-<slug>` nicht auflösen, und der
Fehler „Missing NEXT_PUBLIC_SUPABASE_URL" zeigt wenigstens auf die Ursache.

**Es gibt kein `DATABASE_URL`.** Eine Kunden-App bekommt nie eine direkte
Postgres-Verbindung — nur PostgREST und GoTrue. `DATABASE_URL` steht sogar auf
der Build-Time-Denylist (`nixpacks.ts:67`). Ein Projekt mit Prisma/Drizzle/
`pg`-Client gegen die Tenant-DB ist auf dieser Plattform nicht vorgesehen.

---

## 4. Deployment-Voraussetzungen (Nixpacks / Provisioning-Agent)

### Repo-Struktur

- **Build-Root ist das Repo-Root.** `checkoutRepo()` (`lib/git.ts:66-125`) klont
  nach `deployments/builds/<slug>/repo`, kopiert den Commit nach
  `<slug>/<sha12>` und übergibt genau diesen Pfad an Nixpacks. Es gibt **keine
  Root-Directory-Einstellung** — Monorepos mit der App in `apps/web/` bauen nicht,
  ohne dass ein `build_command` das kompensiert.
- **`Dockerfile` im Root gewinnt.** Nixpacks-Standardverhalten, ausdrücklich
  bestätigt in `nixpacks.ts:23`. Wer volle Kontrolle will, legt eines an.
- **`nixpacks.toml` im Root gewinnt vor dem Plattform-Default.** Fehlt sie,
  schreibt die Plattform selbst eine hinein (`nixpacks.ts:36-39`):
  ```toml
  [phases.setup]
  nixPkgs = ["nodejs_20"]
  ```
  Überschreibbar plattformweit über `PLATFORM_DEFAULT_NODE_VERSION`. Wer eine
  andere Node-Version braucht, bringt eine eigene `nixpacks.toml` mit —
  `.nvmrc`/`engines.node` greifen nur, solange keine `nixpacks.toml` existiert,
  und die Plattform legt eine an, sobald keine da ist.
- **`package.json` braucht ein `build`- und ein `start`-Script.**
  `buildErrorHints.ts:16` erkennt genau diesen Fehlerfall
  („`missing script: build|start`"). Alternativ ein projektspezifisches
  `build_command` im Dashboard (`--build-cmd`, `nixpacks.ts:96`).

### Laufzeit

- **Port:** Default `3000`, pro Projekt einstellbar (`projects.app_port`,
  `routes/projects.ts:132`). Die App **muss auf `0.0.0.0` lauschen**, nicht
  `127.0.0.1` — der Healthcheck kommt vom Agent-Container über das Docker-Netz
  (`deploy.ts:135-150`, `fetch(http://<container>:<port><path>)`).
- **Healthcheck:** `projects.health_path`, Default `/`. Muss innerhalb von
  **60 s** nach Containerstart mit Status **< 500** antworten, sonst wird der
  Deploy zurückgerollt (`deploy.ts:326-341`). Nach dem Swap noch einmal 30 s.
- **Speicher:** 512 MB (starter/business) bzw. 1 GB (premium), `--pids-limit 512`
  (`deploy.ts:31-39`). Ein Next.js-Standalone-Server liegt beim Start bereits bei
  150-250 MB.
- **Build-Timeout:** 10 Minuten hart (`nixpacks.ts:106`).
- **Der Build läuft NICHT im Projektnetz.** PostgREST/GoTrue/MinIO sind zur
  Build-Zeit unerreichbar. Statisches Rendering gegen die eigene API produziert
  deshalb leere Seiten (`docs/OPERATIONS.md:118-130`). Datengetriebene Seiten
  brauchen `export const revalidate = <sekunden>` oder echtes SSR.

### Env-Var-Konventionen

- **Build-Zeit vs. Laufzeit ist erzwungen** (`nixpacks.ts:60-80`, P0-4). Zur
  Build-Zeit gehen durch:
  - alles mit Präfix `NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`, `REACT_APP_`,
    `NUXT_PUBLIC_`, `GATSBY_`, `EXPO_PUBLIC_`
  - alles andere, das **nicht** auf `SECRET|PASSWORD|PASSWD|PRIVATE_KEY|
    ACCESS_KEY|_KEY$|^KEY$|TOKEN|CREDENTIAL` matcht
  - Denylist immer: `JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`,
    `MINIO_SECRET_KEY`, `DATABASE_URL`, `POSTGRES_PASSWORD`

  Praktische Folge: **eine Variable, die zur Build-Zeit gebraucht wird und wie
  ein Secret heißt, ist zur Build-Zeit nicht da.** Wer z. B.
  `STRIPE_PUBLIC_KEY` beim Build braucht, muss sie `NEXT_PUBLIC_STRIPE_KEY`
  nennen — `_KEY$` würde sie sonst aussortieren.
- **Env-Änderungen brauchen einen Redeploy**, kein Neustart: Werte gehen als
  `docker run -e` mit, `NEXT_PUBLIC_*` sind sogar ins Bundle eingebacken
  (`docs/OPERATIONS.md:160-175`).
- Projektspezifische Variablen liegen AES-256-GCM-verschlüsselt in
  `project_env_vars` und werden **nach** den Plattform-Variablen gemergt
  (`secrets.ts:137-140`) — sie können die injizierten also überschreiben. Tun,
  außer man weiß genau warum, sollte man das nicht.

### Slugs, Namen, Domains

- Tenant- und Projekt-Slug: `/^[a-z0-9-]+$/` — an ~15 Stellen geprüft
  (`index.ts:256`, `routes/projects.ts:120`, `git.ts:61`, …).
  Kleinbuchstaben, Ziffern, Bindestrich. Kein Unterstrich, kein Punkt.
- Daraus abgeleitet, alles ohne weitere Konfiguration: DB `kunde_<slug>`,
  Rollen `authenticator_|anon_|authenticated_|service_role_<slug>`, Bucket
  `kunde-<slug>-storage`, Container `api-<slug>`, `auth-<slug>`,
  `app-<projektslug>`, Netz `app-<projektslug>-net`, Image
  `app-<projektslug>:<sha12>`.
- Preview-Domain wird beim Anlegen automatisch vergeben und ein
  GitHub-Webhook registriert (`GITHUB_PAT` mit Scope „Webhooks: Read & write"
  vorausgesetzt, sonst manuell nachtragen).

### CMS-Anbindung (optional)

Wenn der Endkunde seine Inhalte im CMS pflegen soll, gelten für die betroffenen
Tabellen zusätzliche Anforderungen (`provisioning-agent/src/lib/cms.ts`):

- Tabellenname muss `/^[a-z_][a-z0-9_]*$/` erfüllen (`routes/cms.ts:34`)
- Tabelle liegt in `public`, `relkind` `r` oder `p`
- **Primärschlüssel wird gebraucht** — die Feldvorbelegung liest ihn aus
  (`cms.ts:272-279`); ohne PK ist keine Zeile eindeutig editierbar
- Zugriff läuft über eine eigene Rolle `cms_<slug>` mit `GRANT` pro
  freigegebener Tabelle (`cms.ts:213`), nicht über `anon`/`authenticated`

---

## 5. Unterschiede zu echtem Supabase — die eigentlichen Fehlerquellen

Nach Schweregrad. Punkte 1-4 brechen jedes unveränderte Supabase-Projekt.

### 5.1 Rollennamen sind tenant-spezifisch (der große)

| Supabase | Hier |
|---|---|
| `anon` | `anon_<slug>` |
| `authenticated` | `authenticated_<slug>` |
| `service_role` | `service_role_<slug>` |
| `authenticator` | `authenticator_<slug>` |

Grund: P0-2b (`core-postgres/templates/authenticator-role.sql.template:16-25`).
Vorher waren das clusterweite Rollen und jeder Tenant-Authenticator Mitglied
aller drei — ein Tenant, der nach Supabase-Konvention
`GRANT ALL ... TO service_role` ausführte, gab damit **jedem anderen Tenant im
Cluster** Zugriff, und `service_role` hat `BYPASSRLS`.

**Fehlerbild:** `CREATE POLICY ... TO authenticated` wirft **keinen Fehler** —
die clusterweite Rolle existiert ja noch. Die Policy greift nur nie. Die App
bekommt 200er mit leeren Arrays oder `permission denied`, und nichts im Log
zeigt auf die Ursache. Deshalb die `current_database()`-Ableitung aus §1.

### 5.2 `auth.uid()` existiert nicht

Supabase liefert Helfer wie `auth.uid()`, `auth.jwt()`, `auth.role()` — die sind
Teil der Supabase-Plattform, **nicht von GoTrue**. Hier existiert nur das nackte
`auth`-Schema, das GoTrue selbst anlegt (`auth.users` etc.).

Jede Policy der Form `USING (user_id = auth.uid())` schlägt beim Einspielen mit
`function auth.uid() does not exist` fehl. `01_schema.sql:118-125` dokumentiert
genau diesen Fall (dort wurde `is_admin()` deshalb ausgebaut).

### 5.3 Kein Storage-Service, kein `storage`-Schema

Siehe §2. Kein `storage.objects`, keine Storage-RLS, keine
`supabase.storage.from(...)`-API. Buckets werden zu Präfixen, Zugriff über das
S3-SDK, `public/` ist das einzige öffentlich lesbare Präfix.

### 5.4 Kein `supabase_functions`-Schema, keine Edge Functions, kein Realtime

- `supabase_functions.http_request()` existiert nicht. Trigger, die Webhooks
  feuern, müssen raus — die App löst stattdessen selbst aus. Genau dieser Fall
  ist in `tenant-migrations/up2-site/README.md` dokumentiert
  (Trigger `newsletter_on_publish`).
- Keine Edge Functions, kein `supabase functions deploy`. Serverseitige Logik
  gehört in die Next.js-App (die deployt ohnehin).
- Kein Realtime/WebSocket-Kanal. `supabase.channel(...)` läuft ins Leere.

### 5.5 Kein Supabase-CLI-Workflow

`supabase db push`, `supabase migration up`, `supabase link`, `supabase start`,
`config.toml` — nichts davon greift. Es gibt keinen Migrations-Läufer für
Tenant-DBs (§1, Ebene B). Migrations-Files sind reines SQL, das jemand einspielt.

### 5.6 Kein direkter Postgres-Zugang für die App

Supabase gibt eine `DATABASE_URL` heraus (Session- und Transaction-Pooler). Hier
gibt es keine — die App spricht ausschließlich PostgREST. Prisma/Drizzle/
TypeORM gegen die Tenant-DB sind nicht vorgesehen. (Über den SQL-Editor bzw.
`psql` auf der VPS kommt der Betreiber heran, nicht die App.)

### 5.7 PgBouncer im Transaction-Mode

`POOL_MODE=transaction` (`core-postgres/docker-compose.yml:88`), `DEFAULT_POOL_SIZE=5`.
Folgen:

- **Prepared Statements funktionieren nicht** (`PGRST_DB_PREPARED_STATEMENTS: "false"`
  im Tenant-Template, P1-10). Ein Client mit Prepared Statements bekommt
  sporadisch „prepared statement does not exist".
- **`LISTEN`/`NOTIFY` überlebt das Pooling nicht.** Deshalb `SIGUSR1` statt
  `NOTIFY pgrst, 'reload schema'` (`docs/OPERATIONS.md:113`).
- **`CREATE DATABASE` geht nicht über PgBouncer** — Provisioning nutzt dafür
  `ADMIN_DB_HOST=core-postgres` direkt (`.env.example:22-26`).

### 5.8 JWTs ohne `exp`, mit eigenem `iss`

`signTenantJwt()` (`lib/jwt.ts:29-36`) setzt `{ role: '<kind>_<slug>', iss:
'multitenant-platform' }`, HS256, **kein `exp`, kein `aud`**. Widerruf läuft
ausschließlich über Rotation des Tenant-Secrets
(`POST /secrets/<slug>/rotate/jwt`). Code, der `exp` oder `aud: 'authenticated'`
aus einem Supabase-Token erwartet, verwirft diese Tokens.

### 5.9 Postgres 16 statt 17

Der up2-site-Dump kam aus PostgreSQL 17.6, das Ziel ist `postgres:16.14-bookworm`.
`gen_random_uuid()` ist in beiden Kernbestandteil (kein `pgcrypto` nötig), aber
17er-Syntax kann in 16 fehlschlagen. Dumps entsprechend prüfen.

### 5.10 Kleinere, aber häufige

- **Öffentliche API ist opt-in.** Bei Supabase ist die REST-URL sofort
  erreichbar; hier braucht es `POST /tenants/<slug>/public-access`, sonst
  existiert `NEXT_PUBLIC_SUPABASE_URL` gar nicht (§3).
- **`search_path` des Authenticators ist `auth, public`**, nicht `public`
  (`tenantDatabase.ts:158`). Unqualifizierte Objektnamen können anders auflösen
  als erwartet — Migrationen deshalb immer `public.<name>` schreiben.
- **PostgREST bedient nur `public`** (`PGRST_DB_SCHEMA: "public"`). Tabellen in
  eigenen Schemata sind über die API unsichtbar.
- **`CREATE SCHEMA public`** aus einem `pg_dump` → harter Fehler.
- **`COPY ... FROM stdin`** aus einem `pg_dump` → läuft in keinem Web-SQL-Editor.

---

## 6. Offene Punkte

Nicht eindeutig aus dem Code belegbar, deshalb hier statt geraten:

1. **`graphify` ist auf dieser Maschine nicht installiert** (`command not found`),
   obwohl `CLAUDE.md` es als ersten Schritt vorschreibt. `graphify-out/graph.json`
   und `GRAPH_REPORT.md` existieren, sind aber ohne CLI nur als Rohdatei lesbar.
   Diese Review entstand deshalb aus direkter Codelektüre.
2. **Kein Migrations-Tracking für Tenant-Datenbanken.** `schema_migrations`
   existiert nur für die Plattform-Ebene (DB `postgres`). Ob für Tenants bewusst
   darauf verzichtet wurde oder es schlicht noch fehlt, geht aus dem Code nicht
   hervor. `cms.ts:337` filtert `relname NOT LIKE 'schema_migrations%'` aus der
   Collection-Liste — dort wird also mit der Möglichkeit gerechnet, dass so eine
   Tabelle in einer Tenant-DB auftaucht.
3. **`tenant-migrations/` ist Konvention, kein Contract.** Kein Code liest den
   Ordner; das README darin nennt ihn selbst wegwerfbar. Ob er der vorgesehene
   dauerhafte Ort für Projekt-Migrationen sein soll, ist eine Produktentscheidung
   — der Skill in `skills/multitenant-projekt/` empfiehlt stattdessen
   `supabase/migrations/` **im Projekt-Repo**, weil das Projekt-Repo mit dem
   Projekt reist und dieses Plattform-Repo nicht.
4. **Wie `GOTRUE_DISABLE_SIGNUP` pro Tenant umgestellt wird**, ist im Code nicht
   vorgesehen — der Wert steht fest im Template. Es gibt keinen Endpunkt und
   keine Dashboard-Option dafür. Praktisch bleibt: Wert in
   `kunden-instances/<slug>/docker-compose.yml` ändern und `docker compose up -d
   auth`; das nächste `writeTenantCompose()` (Tarifwechsel, DB-Reaktivierung)
   überschreibt die Änderung wieder.
5. **`resend_api_key_encrypted` in `kunden`** ist bewusst ungenutzt
   (`tenantDatabase.ts:70-76`) — SMTP läuft über die globale `RESEND_API_KEY`.
   Pro-Tenant-Absender ist damit derzeit nicht möglich.
6. **`$DASHBOARD_SRC/`** im Repo-Root ist offensichtlich ein Artefakt einer nicht
   expandierten Shell-Variable. Keine Referenz im Code gefunden; sieht nach
   Löschkandidat aus, wurde aber nicht angefasst (Leseauftrag).

---

## 7. Kurzfassung — Checkliste für ein neues Projekt

1. Slug wählen: `[a-z0-9-]+`.
2. Schema als **reines, idempotentes SQL** unter `supabase/migrations/NN_*.sql`
   im Projekt-Repo. Rollennamen über `current_database()` ableiten, GRANTs nicht
   vergessen, kein `auth.uid()`, kein `CREATE SCHEMA public`, kein `COPY`.
3. Storage: **ein** Bucket `kunde-<slug>-storage`, Supabase-Buckets werden zu
   Präfixen. Öffentliches nach `public/<YYYY>/<MM>/`, alles andere ist privat.
4. Auth: `role`-Claim ist `authenticated_<slug>`. Signup ist aus. Kein
   `auth.uid()` in Policies.
5. Env: nie `SUPABASE_*`/`MINIO_*`/`JWT_SECRET`/`S3_BUCKET_NAME` selbst setzen.
   Build-Zeit-Variablen brauchen ein `NEXT_PUBLIC_`-artiges Präfix.
6. Deploy: App im Repo-Root, `build`+`start` in `package.json`, Listen auf
   `0.0.0.0:3000`, Healthpfad antwortet in < 60 s mit < 500, unter 512 MB RAM,
   keine API-Zugriffe zur Build-Zeit.
7. Vor dem ersten Deploy `public-access` für PostgREST freischalten, wenn die App
   `NEXT_PUBLIC_SUPABASE_URL` braucht.
8. Nach jedem manuellen Schema-Einspielen: `docker kill -s SIGUSR1 api-<slug>`.

Ausführlich mit Referenz-Dateien: `skills/multitenant-projekt/SKILL.md`.
