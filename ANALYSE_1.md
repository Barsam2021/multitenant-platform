# ANALYSE 1 — Ist-Analyse & Risiko-Absicherung

**Stand:** 2026-08-26 · **Branch:** `claude/backup-prozedur-main-1ibs2q` · **Basis-Commit:** `0b0d3bb`
**Zweck:** Grundlage für den Testplan in Phase 3. Keine Tests ausgeführt, keine Last erzeugt, keine Änderung an laufenden Diensten.

**Methodik:** Statische Analyse der Compose-Files, des TypeScript-Codes (`provisioning-agent`, `dashboard`, `cms`), der SQL-Init-Skripte und der Backup-Skripte; abgeglichen mit `docker ps` / `docker network ls` / `docker volume ls` auf der Live-VPS (nur lesend).

---

## 0. Korrekturen an den Annahmen aus dem Auftrag

Drei Punkte der Aufgabenstellung stimmen mit dem Repo-Stand nicht überein. Sie ändern den Zuschnitt von Phase 3:

| Annahme im Auftrag | Tatsächlicher Stand |
|---|---|
| "keine CI/CD-Pipeline" | `.github/workflows/ci.yml` existiert und läuft bei Push/PR auf `main`: Typecheck + Lint + Build für alle drei Node-Dienste (Sprint 18, P3-4). Was fehlt, ist **CD** und jede Art von *Test*-Job — es gibt keine Testsuite, die ein Job ausführen könnte. |
| "kein Monitoring" | Kein Prometheus/Grafana/cAdvisor — korrekt. Aber: **Uptime Kuma 2.4.0** läuft (`status-vps.<domain>`), der Agent legt Monitore pro Projekt an (`lib/monitoring.ts`), Traefik exportiert bereits Prometheus-Metriken (`--metrics.prometheus=true`, **ungescrapt**), E-Mail-Alarme via Resend (`lib/alert.ts`), und ein Versionsinventar mit CVE-Abgleich (`lib/inventory.ts`, `docs/CVE-PLAN.md`). |
| "Starter-Tarif hat keine eigene DB/Auth" | **Nicht der Tarif entscheidet das.** Der Tarif steuert ausschließlich RAM/CPU-Limits. Ob ein Tenant DB + Auth bekommt, hängt an den davon unabhängigen Flags `kunden.db_enabled` / `db_provisioned` (Migration 19). Ein Starter-Tenant *mit* DB und ein Premium-Tenant *ohne* DB sind beide gültige Zustände. Siehe §5 — dieser Punkt ist testrelevant, weil er die Zahl der zu prüfenden Kombinationen von 3 auf 3×2 erhöht. |

"Keine dokumentierte Testabdeckung" ist korrekt und wird von `README.md` selbst so benannt: *"Es existiert keine Testsuite. Sieben der elf schwersten Audit-Befunde wären von vier Integrationstests gefunden worden."*

---

## 1. Service-Inventar

### 1.1 Plattform-Dienste (ein Container für alle Tenants)

Jeder Dienst hat sein eigenes Compose-File. Es gibt **kein** übergreifendes Compose — Start/Neustart läuft über `scripts/redeploy.sh` bzw. `bootstrap.sh`.

| Dienst | Container | Image | Compose | Zweck | Ports (Host) | Volumes | Netze |
|---|---|---|---|---|---|---|---|
| Traefik | `global-traefik` | `traefik:v3.7` | `traefik/` | Reverse Proxy, TLS (ACME DNS-01 über Cloudflare), Accesslog als Analytics-Quelle, Rate-Limiting | **80, 443 (öffentlich)** | `./letsencrypt`, `./dynamic`, `./logs`, `docker.sock:ro` | traefik-net + alle `app-*-net` (dynamisch) |
| Cloudflare Tunnel | `cloudflared` | `cloudflare/cloudflared:2025.8.1` | `cloudflared/` | Einziger Zugang zum Admin-Dashboard (kein offener Port) | — | — | traefik-net |
| PostgreSQL | `core-postgres` | `postgres:16.14-bookworm` | `core-postgres/` | Alle Daten: `admin_dashboard` + je `kunde_<slug>` | keiner (nur intern) | `core-postgres_pgdata`, `./init-scripts:ro` | traefik-net |
| PgBouncer | `pgbouncer` | `edoburu/pgbouncer:v1.25.2-p0` | `core-postgres/` | Connection-Pooling, `POOL_MODE=transaction`, AUTH_QUERY gegen `pgbouncer_auth.user_lookup` | **127.0.0.1:6432** (nur Loopback) | — | traefik-net |
| MinIO | `core-minio` | `minio/minio:RELEASE.2025-09-07T16-13-09Z-cpuv1` | `minio/` | S3-Storage, ein Bucket pro Tenant | keiner | `minio_minio-data` | traefik-net |
| Provisioning Agent | `provisioning-agent` | lokal gebaut | `provisioning-agent/` | Steuerzentrale, siehe §4 | keiner; via Traefik nur `webhooks.<domain>/webhooks/*` | `/opt/multitenant-platform` (**komplett, rw**), `docker.sock:ro` | traefik-net **+ docker-proxy-net** |
| Docker-Socket-Proxy | `docker-socket-proxy` | `tecnativa/docker-socket-proxy:v0.4.2` | `provisioning-agent/` | gefilterter Docker-API-Zugang | keiner | `docker.sock:ro` | **nur docker-proxy-net (`internal: true`)** |
| Admin-Dashboard | `admin-dashboard` | lokal gebaut (Next.js 15) | `dashboard/` | Admin-UI | **127.0.0.1:3000** (nur Loopback) | — | traefik-net |
| CMS | `cms` | lokal gebaut (Next.js 15) | `cms/` | Redaktions-UI für Endkunden, **öffentlich** unter `cms.<domain>` | keiner; via Traefik | — | traefik-net |
| Uptime Kuma | `uptime-kuma` | `louislam/uptime-kuma:2.4.0` | `monitoring/uptime-kuma/` | Erreichbarkeitsprüfung, `status-vps.<domain>` | keiner; via Traefik | `uptime-kuma_uptime-kuma-data` | traefik-net |
| BuildKit (×2) | `buildx_buildkit_*` | `moby/buildkit:buildx-stable-1` | von buildx erzeugt | Nixpacks-Builds | keiner | eigene State-Volumes | — |

### 1.2 Tenant-Dienste (pro Kunde, nur bei `db_enabled=true`)

Erzeugt aus `provisioning-agent/templates/tenant-compose.yml` nach `kunden-instances/<slug>/docker-compose.yml`:

| Container | Image | Zweck | Limits |
|---|---|---|---|
| `api-<slug>` | `postgrest/postgrest:v14.15` | REST-API auf `kunde_<slug>`, verbindet als `authenticator_<slug>`, Anon-Rolle `anon_<slug>`, `PGRST_DB_POOL=5`, Prepared Statements **aus** (PgBouncer-Transaction-Mode) | tarifabhängig, Default 64m / 0.25 CPU |
| `auth-<slug>` | `supabase/gotrue:v2.193.1` | GoTrue im Schema `auth` derselben DB, Signup deaktiviert, SMTP über Resend | tarifabhängig, Default 128m / 0.25 CPU |

### 1.3 Kunden-App-Container (pro Projekt)

`app-<slug>` — aus dem Kunden-Repo per Nixpacks gebaut, gestartet mit `--memory`/`--cpus` nach Tarif und `--pids-limit 512`. Läuft **nicht** in traefik-net, sondern in einem eigenen Netz `app-<slug>-net`.

### 1.4 Netzwerkmodell

- **`traefik-net`** (extern, bridge) — alle Plattform- und Tenant-Dienste.
- **`docker-proxy-net`** (`internal: true`) — nur Agent ↔ Socket-Proxy. Kein Gateway, kein Egress. Das ist die eigentliche Grenze: `CONTAINERS=1 + POST=1` am Proxy ist root-äquivalent (der Proxy filtert Pfad und Methode, **nicht den Request-Body**), deshalb schützt nur die Netz-Isolation, nicht die API-Flags.
- **`app-<slug>-net`** (pro Projekt) — App-Container + `global-traefik` + `provisioning-agent` + `api-<slug>` + `auth-<slug>` + `core-minio`. Bewusst **nicht** `--internal`, weil Kunden-Apps Internet-Egress brauchen (Stripe, Resend, Fonts).

**Fragiler Punkt (testrelevant):** Die Zuordnung "Traefik hängt in `app-<slug>-net`" ist reiner Laufzeit-Zustand des Docker-Daemons und steht in **keiner** Compose-Datei. Ein `--force-recreate` von Traefik löscht sie → 504 auf jeder Kundenseite ohne eine einzige Fehlermeldung. Gegenmaßnahme ist `reattachProjectNetworks()` beim Agent-Start (`index.ts`) — d.h. die Reparatur hängt davon ab, dass der Agent nach Traefik startet.

### 1.5 Abhängigkeitskette

```
Cloudflare → cloudflared → admin-dashboard ─┐
Cloudflare → Traefik :443 → cms ────────────┼→ PgBouncer → core-postgres
                          → app-<slug> ─────┤              (admin_dashboard + kunde_*)
                          → api/auth-<slug> ┘
                          → provisioning-agent (/webhooks/*)
                                    │
                                    ├→ docker-socket-proxy → dockerd
                                    ├→ /var/run/docker.sock (nur BuildKit/nixpacks)
                                    └→ mc → core-minio
```

Harte `depends_on`-Bedingungen gibt es nur zwei: `pgbouncer` → `core-postgres` (healthy) und `provisioning-agent` → `docker-socket-proxy`. Alles andere ist über `restart: always` + Healthchecks lose gekoppelt. **Single Point of Failure:** `core-postgres` — alle Tenants, alle Admin-Daten, alle CMS-Konfigurationen liegen in einem Cluster mit `max_connections=60` und `mem_limit=2g`.

---

## 2. Tenant-Architektur — wie Mandantentrennung technisch umgesetzt ist

Die Trennung läuft auf **vier voneinander unabhängigen Ebenen**. Ein Test muss jede einzeln prüfen; ein Durchbruch auf einer Ebene wird von den anderen nicht aufgefangen.

### Ebene 1 — Datenbank pro Tenant (nicht RLS, nicht Schema)

Jeder Tenant bekommt eine **eigene Postgres-Datenbank** `kunde_<slug>`. Keine geteilte Tabelle mit `tenant_id`-Spalte, kein Schema-per-Tenant.
`provisioning-agent/src/lib/tenantDatabase.ts:120-165`:

```
CREATE DATABASE kunde_<slug>;
REVOKE ALL ON DATABASE kunde_<slug> FROM PUBLIC;      -- P0-2a
GRANT CONNECT, TEMPORARY ON DATABASE kunde_<slug> TO authenticator_<slug>;
```

Das `REVOKE` ist der Kern: Postgres vergibt `CONNECT` auf jede neue DB standardmäßig an `PUBLIC`. Ohne diese Zeile könnte sich **jede** Login-Rolle im Cluster — also jeder `authenticator_<fremder-slug>` — auf jede fremde Tenant-DB verbinden.

### Ebene 2 — Rollen pro Tenant

`core-postgres/templates/authenticator-role.sql.template`, ausgeführt einmal pro Tenant in der Tenant-DB:

| Rolle | Attribute |
|---|---|
| `authenticator_<slug>` | LOGIN, NOINHERIT — der einzige DB-Login der Tenant-Dienste |
| `anon_<slug>` | NOLOGIN, NOINHERIT |
| `authenticated_<slug>` | NOLOGIN, NOINHERIT |
| `service_role_<slug>` | NOLOGIN, NOINHERIT, **BYPASSRLS** |
| `cms_<slug>` | LOGIN, eingeschränkt auf freigegebene Tabellen (Migration 21) |

Vorher (vor P0-2b) waren `anon`/`authenticated`/`service_role` **clusterweit** und jeder Authenticator Mitglied aller drei — ein Tenant, der nach Supabase-Konvention `GRANT ALL ... TO service_role` ausführte, gab damit jedem anderen Tenant Zugriff, unter Umgehung aller RLS-Policies.

**Restrisiko:** Die alten clusterweiten Rollen `anon`/`authenticated`/`service_role` existieren weiterhin (`core-postgres/init-scripts/01_roles.sql`) und `service_role` hat weiterhin `BYPASSRLS`. Sie werden nur nicht mehr *vergeben*. Ein Tenant-Schema, das aus einem Supabase-Export übernommen wird und `GRANT ... TO service_role` enthält, greift damit ins Leere statt zu scheitern — der Effekt fällt still aus.

### Ebene 3 — Authentifizierung an PgBouncer

PgBouncer läuft mit `AUTH_QUERY` gegen eine SECURITY-DEFINER-Funktion (`18_pgbouncer_auth.sql`) plus `AUTH_DBNAME=postgres`. Ohne das würde das Image `userlist.txt` nur aus `DB_USER`/`DB_PASSWORD` erzeugen — also nur `postgres` — und alle `authenticator_<slug>` stillschweigend auf `postgres` mappen. **Das würde PostgREST in jeder Tenant-DB zum Superuser machen und RLS überall aushebeln.** Diese Konfiguration ist die stillste und gefährlichste Einzelstelle der ganzen Isolation: ein Fehler hier produziert keinen Fehler, sondern Zugriff.

### Ebene 4 — Netz- und Container-Trennung

Ein Projektnetz pro Projekt (`app-<slug>-net`). Kunden-Apps hängen **nicht** in `traefik-net` und erreichen weder PgBouncer noch den Socket-Proxy noch fremde App-Container.

### Row-Level Security

RLS wird **nicht** von der Plattform erzwungen, sondern nur im Tenant-Schema angelegt, wo der Kunde es mitbringt — beispielhaft `tenant-migrations/up2-site/01_schema.sql:288-386` (9 Tabellen, Policies je `anon_<slug>`/`authenticated_<slug>`/`service_role_<slug>`). Bei aktivierter öffentlicher PostgREST-Freigabe **ohne** RLS-Policies ist die Tenant-DB für jeden mit dem Anon-Key les- und schreibbar; der Code warnt an der Stelle (`routes/tenants.ts`, POST `/tenants/:slug/public-access`), verhindert es aber nicht.

### Wo im Code

| Aspekt | Ort |
|---|---|
| DB + Rollen anlegen | `provisioning-agent/src/lib/tenantDatabase.ts` |
| Rollen-Template | `core-postgres/templates/authenticator-role.sql.template` |
| Compose je Tenant | `provisioning-agent/templates/tenant-compose.yml` → `writeTenantCompose()` |
| Netz je Projekt | `provisioning-agent/src/lib/deploy.ts:190` `ensureProjectNetwork()` |
| CMS-Mandantengrenze | `cms/src/lib/session.ts:requireSession()` + `tenant_slug` im WHERE jeder Query in `cms/src/lib/configDb.ts` |
| CMS-DB-Rolle | `cms/src/lib/tenantDb.ts` (verbindet als `cms_<slug>`, **nicht** als Superuser) |
| Slug-Validierung | überall `/^[a-z0-9-]+$/`, DB-seitig `CHECK (slug ~ '^[a-z0-9-]+$')` in `01a_kunden.sql` |

---

## 3. Auth-Flow

Es gibt **drei getrennte Auth-Ebenen** mit unterschiedlichen Mechanismen. Sie teilen sich keine Session und kein Secret.

### 3.1 Admin-Dashboard — NextAuth v5 (Credentials) + Cloudflare Zero Trust

- Genau **ein** Admin, aus der `.env`: `ADMIN_EMAIL` + `ADMIN_PASSWORD_HASH` (bcrypt). Keine Nutzertabelle.
- Session: JWT (`strategy: "jwt"`), Cookie.
- `dashboard/src/middleware.ts` matcht **nur** `/dashboard/:path*` und `/api/tenants/:path*`.
- **Verifiziert:** Trotz dieser Lücke im Matcher ruft **jede** API-Route ihren eigenen Guard auf (`const session = await auth(); if (!session) → 401`). Geprüft für alle 49 Route-Dateien — nur `api/auth/[...nextauth]` hat keinen, korrekterweise. Die Middleware ist hier also Defense-in-Depth, nicht die einzige Verteidigung.
- Login-Erfolge und -Fehlschläge werden auditiert (`auth.login_success` / `auth.login_failure` mit Grund, IP, User-Agent).
- Erreichbar **nur** über den Cloudflare Tunnel — kein Traefik-Router, Port nur auf `127.0.0.1`.

### 3.2 Dashboard → Provisioning Agent — Shared Secret

`dashboard/src/lib/agent.ts` → Header `X-Agent-Secret` (+ `X-Actor`, `X-Actor-Ip`, `X-Actor-Ua` für Audit und Rate-Limit-Key).
Der Agent prüft in `index.ts` mit `crypto.timingSafeEqual()` (zeitkonstant, P2-19). `/health` und `/webhooks/*` stehen bewusst **vor** dieser Middleware.

### 3.3 Endkunden-CMS — eigene JWT-Session (jose)

`cms/src/lib/session.ts`. Bewusst nicht NextAuth: beliebig viele Redakteure aus `cms_users`, jeder an genau einen Tenant gebunden.
- Cookie `cms_session`, HS256, 8h, `httpOnly`, `sameSite: lax`, `secure` nur in Produktion.
- **Der Tenant kommt ausschließlich aus der Session, nie aus der URL.** `requireSession(tenantSlug)` gibt `null` zurück, wenn `session.tenantSlug !== tenantSlug` — die Mandantengrenze liegt an genau dieser einen Stelle.
- Zusätzlich **DB-Revalidierung bei jedem Aufruf** (`getSessionUser`): gelöschte/gesperrte Redakteure verlieren die Session sofort statt erst nach 8h.
- Login-Bremse im Prozessspeicher (`cms/src/lib/rateLimit.ts`), Schlüssel aus `cf-connecting-ip` bzw. erstem `x-forwarded-for`-Eintrag.

### 3.4 Tenant-Endnutzer — GoTrue pro Tenant

Eigenes `GOTRUE_JWT_SECRET` je Tenant (32 Byte Zufall). `role`-Claim = `authenticated_<slug>`, Admin-Rolle `service_role_<slug>`. `GOTRUE_DISABLE_SIGNUP=true` als Default (P2-11). PostgREST macht `SET ROLE` auf den `role`-Claim — passt der Claim nicht zur tenant-eigenen Rolle, schlägt der Zugriff fehl, statt still auf eine clusterweite Rolle auszuweichen.

### 3.5 GitHub-Webhooks

`POST /webhooks/github/:projectId` — HMAC-SHA256 über den **rohen** Body (`express.raw()`, nicht `express.json()`), Secret pro Projekt aus `projects.webhook_secret`. Zusätzlich: nur `push`-Events, nur auf `default_branch`, und `423` wenn `kunden.status = 'suspended'` (P1-11).

### 3.6 Bekannte Schwachstellen / Prüfpunkte für Phase 3

| # | Befund | Bewertung |
|---|---|---|
| A1 | `kunden.gotrue_jwt_secret`, `kunden.authenticator_password`, `projects.webhook_secret` liegen **im Klartext** in `admin_dashboard`. Verschlüsselt sind nur `minio_secret_key_encrypted`, `project_env_vars.value_encrypted`, `cms_db_password_encrypted`. | Bekannt und in README dokumentiert. Wer DB-Lesezugriff hat, kann jedes Tenant-JWT signieren. |
| A2 | Dieselben Secrets stehen **im Klartext in den generierten** `kunden-instances/<slug>/docker-compose.yml` — die im Repo-Baum liegen und vom Backup miterfasst werden. | Verzeichnis ist im Agent-Mount `rw`. Prüfen, ob `.gitignore` greift (aktuell: ja, aber `up2web-schema.sql` und `dashboard/up2site-data.sql` liegen ungetrackt im Working Tree). |
| A3 | Der SQL-Editor erlaubt **freie Queries als Superuser `postgres`** auf jede Tenant-DB (`dashboard/src/lib/tenantDb.ts:runSql`). Nur `statement_timeout=30s` + Row-Limit, keine Statement-Whitelist. | Bewusste Entscheidung (Supabase-Studio-Analogie), gilt nur solange es genau einen Admin gibt. |
| A4 | `dashboard/src/lib/tenantDb.ts` verbindet grundsätzlich als **Superuser** — der Table-Editor umgeht damit jede RLS des Tenants. | By design; testrelevant als Kontrast zum CMS, das als `cms_<slug>` verbindet. |
| A5 | Middleware-Matcher deckt die meisten API-Pfade nicht ab. Aktuell folgenlos (§3.1), aber **keine Regel und kein Test erzwingt**, dass eine *neue* Route ihren Guard mitbringt. | Kandidat für einen billigen Struktur-Test in Phase 3. |
| A6 | Rate-Limiting des Agents ist **In-Memory**, Key ist der vom Dashboard gesetzte `X-Actor`-Header — also ein clientseitig gesetzter Wert. | Nur hinter dem Secret erreichbar, deshalb kein Eskalationspfad; aber ein Angreifer mit Secret umgeht damit trivial das Limit. |
| A7 | Rate-Limits gegen Cloudflare: Traefik sieht als Gegenstelle immer eine Edge-IP. Behoben über `Cf-Connecting-Ip` — **findet aber nur ein Lasttest**, keine statische Prüfung. | Explizit in README dokumentiert (600 Requests → 463× `429`, vorher 24×). Muss in Phase 3 als Lasttest zurückkommen. |
| A8 | CMS-Speicherkontingent wird **vor** dem Upload geprüft, nicht atomar. Zwei gleichzeitige Uploads passieren beide. | Bekannt, dokumentiert. |

---

## 4. Provisioning-Agent — Aktionen und ihre Reversibilität

TypeScript/Express, Port 3001, **nicht** öffentlich (nur `/webhooks/*` via Traefik). Alle anderen Routen brauchen `X-Agent-Secret`. ~7.600 Zeilen in 38 Dateien.

### 4.1 Vollständiges Routen-Inventar (39 Endpunkte)

| Bereich | Endpunkte |
|---|---|
| Tenants | `POST /tenants` · `DELETE /tenants/:slug` · `GET/PATCH /tenants/:slug` · `POST /tenants/:slug/status` · `POST /tenants/:slug/database` · `POST /tenants/:slug/public-access` · `GET /tenants/:slug/api-keys` · `POST /tenants/:slug/postgrest/reload` |
| Projekte | `POST/GET /projects` · `GET/PATCH/DELETE /projects/:id` · `PUT /projects/:id/env` · `PUT /projects/:id/env/bulk` · `GET /projects/:id/env` · `DELETE /projects/:id/env/:key` · `GET /projects/:id/webhook` · `POST /projects/:id/webhook/repair` |
| Deployments | `POST /deployments` · `GET /deployments/:projectId` · `GET /deployments/single/:id` · `POST /deployments/:id/rollback` · `POST /deployments/:id/cancel` |
| Domains | `POST /domains` · `GET /domains/:projectId` · `DELETE /domains/:id` · `POST /domains/:id/verify` · `POST /domains/:id/primary` |
| CMS | `POST /tenants/:slug/cms` · `GET /tenants/:slug/cms/tables` · `GET /tenants/:slug/cms/tables/:table/columns` · `POST /tenants/:slug/cms/grant` · `POST /tenants/:slug/cms/revoke` |
| Secrets | `POST /tenants/:slug/rotate-secret` |
| Backups | `GET /backups` · `POST /backups/run` · `POST /backups/restore-test` |
| Betrieb | `GET /stats` · `GET /stats/overview` · `GET /stats/disk` · `GET /stats/storage` · `DELETE /containers/orphan/:name` · `POST /cleanup/run` · `GET /audit-logs` · `GET /security/components` · `POST /security/inventory` · `GET/POST /analytics/*` · `GET /github/repos` · `GET /health` |
| Webhooks | `POST /webhooks/github/:projectId` (**einziger öffentlicher Endpunkt**) |

### 4.2 Destruktive und irreversible Aktionen

**Klasse 1 — irreversibel, Datenverlust ohne Backup:**

| Aktion | Endpunkt | Was genau passiert |
|---|---|---|
| **Tenant löschen** | `DELETE /tenants/:slug` → `cleanupTenantResources()` (`index.ts:145-241`) | In dieser Reihenfolge: alle Projekt-Ressourcen (Container, Router, Netz, Images, Build-Cache, GitHub-Webhook, Kuma-Monitor) → `docker compose down` → `pg_terminate_backend` → **`DROP DATABASE kunde_<slug>`** → `DROP ROLE authenticator_<slug>`, `cms_<slug>` → **`mc rb --force`** auf den MinIO-Bucket → `mc admin user remove` → `mc admin policy remove` → **`rm -rf kunden-instances/<slug>`** → `DELETE FROM projects` + `DELETE FROM kunden`. **Keine Bestätigung im Agent, kein Soft-Delete, keine Karenzzeit.** Jeder Schritt ist einzeln fehlertolerant (sammelt Warnungen statt abzubrechen) — das ist gut für teilprovisionierte Tenants und schlecht dafür, einen halb fehlgeschlagenen Löschvorgang zu bemerken. |
| **Projekt löschen** | `DELETE /projects/:id` | Container `docker rm -f`, Projektnetz `docker network rm`, `rm -rf` auf den Build-Cache, `DELETE FROM projects`. |
| **Automatisches Rollback** | `POST /tenants` im Fehlerfall | Ruft dieselbe `cleanupTenantResources()` auf. **Das ist der historisch gefährlichste Pfad der Codebasis** — siehe 4.3. |
| **CMS deaktivieren** | `POST /tenants/:slug/cms` (`enabled=false`) | `DROP OWNED BY cms_<slug>` + `DROP ROLE`. Rechte weg; Reaktivierung erzeugt neues Passwort (alte Pools werden ungültig, `dropTenantPool()`). |
| **Cleanup-Lauf** | `POST /cleanup/run` + **automatisch täglich** und 5 Min nach jedem Agent-Start | Build-Snapshots löschen, Docker-Images prunen, Analytics-Retention (`DELETE FROM ... WHERE day < ...`). Läuft **ohne menschliche Auslösung**. |
| **Verwaisten Container löschen** | `DELETE /containers/orphan/:name` | `docker rm -f` auf einen aus der UI gewählten Namen. |

**Klasse 2 — Betriebsunterbrechung, umkehrbar:**

| Aktion | Wirkung |
|---|---|
| `POST /tenants/:slug/status` (`suspended`) | Stoppt Tenant- und App-Container, entfernt Traefik-Router. Kunde ist offline. |
| `POST /tenants/:slug/database` (`false`) | `docker compose down` — **Datenbank bleibt** (`db_provisioned` wird nie wieder false). |
| `POST /deployments` / Webhook | Blue-Green-Swap: `docker rename` alt → Backup, neuer Container übernimmt den öffentlichen Namen. **Zwischen `rename` und `run` ist die Kundenseite offline.** Fällt der Agent genau dort aus, bleibt sie es. |
| `POST /deployments/:id/rollback` | Umgekehrter Swap auf ein altes Image. Scheitert, wenn `pruneOldDockerImages()` das Image bereits entfernt hat (behält die letzten 5). |
| `POST /tenants/:slug/rotate-secret` | Neues JWT-Secret + `--force-recreate` von `auth`/`api`. **Alle bereits ausgelieferten Anon-/Service-Keys werden ungültig** — bricht jede Kunden-App, die den alten Key hartkodiert hat. |
| `PUT /projects/:id/env` (bulk) | Env-Variablen überschreiben; wirkt erst beim nächsten Deploy (`env_dirty`-Flag). |
| `DELETE /domains/:id` | Traefik-Router weg, Domain nicht mehr erreichbar. |

**Klasse 3 — lesend/unkritisch:** alle `GET`-Routen, `/health`, `/security/*`, `/analytics/*`, `/stats/*`, `POST /backups/restore-test` (arbeitet in einer Wegwerf-DB).

### 4.3 Der kritische Pfad: `POST /tenants` und sein Rollback

Historisch der destruktivste Bug der Plattform. Zwei Schutzschichten, beide testrelevant:

1. **Advisory Lock** (P0-3): `pg_try_advisory_lock` auf `sha256("tenant:"+slug)`. Nicht-blockierend → zweiter Request bekommt sofort `409`. Vorher: Ein Doppelklick auf "Tenant anlegen" ließ Request 2 durch den Existenz-Check laufen (Provisioning dauert >8s), scheiterte an `CREATE DATABASE ... already exists`, und **das Rollback von Request 2 löschte den gerade fertig gebauten Tenant von Request 1 vollständig** — DB, Rollen, MinIO-Bucket, Verzeichnis, DB-Zeile.
2. **`already exists`-Guard** (P0-3, zweite Schicht): Enthält die Fehlermeldung `already exists`, wird **kein** Rollback ausgeführt, sondern `409` mit einer Liste der manuell zu prüfenden Ressourcen zurückgegeben.

Beide Schutzmaßnahmen hängen an **String-Matching auf Fehlermeldungen** (`/already exists/i`). Eine geänderte Postgres-Fehlermeldung, ein Fehler aus `mc` statt aus `pg`, oder ein Fehler ohne dieses Textfragment führt zurück in den destruktiven Pfad. **Das ist der wichtigste Kandidat für einen Integrationstest in Phase 3.**

### 4.4 Effektive Rechte des Agents

Der Agent ist faktisch root auf der VPS:
- `CONTAINERS=1 + POST=1` am Socket-Proxy ist root-äquivalent (Body wird nicht gefiltert).
- Zusätzlich hat er den **rohen** `/var/run/docker.sock` gemountet (nötig für BuildKit-Session-Upgrade, das der Proxy mit 403 abweist).
- `/opt/multitenant-platform` ist **schreibbar** gemountet — inklusive `.env`, `traefik/dynamic/`, `backups/`.
- Er hält `MASTER_DB_PASSWORD` (Postgres-Superuser), `MINIO_ROOT_*`, `ENCRYPTION_MASTER_KEY`, `CMS_ENCRYPTION_KEY`, `GITHUB_PAT`, `CF_DNS_API_TOKEN`, `GODADDY_API_*`, `RESEND_API_KEY`.

**Konsequenz für Phase 3:** Jeder Test, der den Agent mit echten Credentials anspricht, spricht damit die Produktivumgebung an. Tests gegen den Agent brauchen entweder eine isolierte Instanz oder müssen sich strikt auf die Klasse-3-Routen beschränken.

### 4.5 Hintergrundprozesse (laufen ohne Auslösung)

| Job | Intervall | Erster Lauf | Risiko |
|---|---|---|---|
| `runCleanup()` | 24h | 5 Min nach Start | **destruktiv** (Images, Snapshots, Analytics-Retention) |
| `runInventoryOnce()` | 1h (`INVENTORY_INTERVAL_MS`) | 2 Min nach Start | lesend |
| `ingestAccessLog()` | 60s (`ANALYTICS_INTERVAL_MS`) | 30s nach Start | schreibend in Analytics-Tabellen; Überlappungsschutz vorhanden |
| `reattachProjectNetworks()` | bei Start | — | repariert Netzanbindungen |
| `healMissingRouters()` + `resumePendingDomainChecks()` | bei Start | — | schreibt `traefik/dynamic/` |
| `ensureRateLimitMiddlewares()` + Router-Resync | bei Start | — | schreibt `traefik/dynamic/` |

**Jeder Agent-Neustart löst also innerhalb von 5 Minuten einen destruktiven Cleanup-Lauf aus.** Für einen Testplan, der den Agent neu startet, ist das ein Nebeneffekt, den man kennen muss.

Es gibt außerdem einen **Cron auf dem Host** (`/etc/cron.d/multitenant-backup`): täglich 03:00 `backups/backup-script.sh` — Postgres-Globals + alle DBs (`-Fc`) + alle MinIO-Buckets + Config (`.env`, `letsencrypt`, `dynamic`, `kunden-instances`), age-verschlüsselt, per rclone nach Backblaze B2, Retention `BACKUP_RETENTION_DAYS` (Default 3).

---

## 5. Tarif- und flag-abhängige Verzweigungen

### 5.1 Was der Tarif tatsächlich steuert

Werte: `starter` | `business` | `premium`, validiert an drei Stellen (`index.ts:249`, `routes/tenants.ts:268`, `lib/tenantDatabase.ts:52`), Fallback überall `starter`. **Kein DB-CHECK-Constraint** — der Wert ist nur applikationsseitig validiert.

| Verzweigung | Ort | Wirkung |
|---|---|---|
| App-Container-Limits | `lib/deploy.ts:31-39` `TARIFF_LIMITS` | starter `512m`/`0.5` · business `512m`/`1` · premium `1g`/`2`. Zusätzlich immer `--pids-limit 512`. |
| Tenant-Dienst-Limits | `lib/tenantDatabase.ts:52-56` | Liest `${TARIFF}_POSTGREST_MEM/CPUS` und `${TARIFF}_GOTRUE_MEM/CPUS` aus der `.env`. **Fallback bei fehlender Variable: `64m`/`0.25` bzw. `128m`/`0.25`** — d.h. ein Tippfehler in der `.env` degradiert einen Premium-Tenant still auf Starter-Werte. |
| Rollback | `lib/deploy.ts:454` | Nutzt dieselben `TARIFF_LIMITS`. Der Tarif wird beim Rollback **neu** aus `kunden` gelesen — ein zwischenzeitliches Downgrade wirkt rückwirkend auf einen alten Deployment-Stand. |
| Anzeige | `dashboard/.../projects/page.tsx`, `stats.ts:375` | reine Badges/Sortierung |

**Der Tarif steuert nichts weiter.** Keine Feature-Gates, keine Kontingente, keine Domain-Limits, keine Backup-Unterschiede.

### 5.2 Die eigentliche Verzweigung: `db_enabled` / `db_provisioned`

Migration 19 (`19_optional_database.sql`) — **unabhängig vom Tarif**:

| Flag | Bedeutung | Wird wieder false? |
|---|---|---|
| `db_provisioned` | DB + Rollen + `docker-compose.yml` existieren | **Nie**, außer der Tenant wird komplett gelöscht |
| `db_enabled` | `api-<slug>`/`auth-<slug>` sollen laufen | Ja — `down`, RAM frei, **DB bleibt** |

Betroffene Codepfade:

| Ort | Verhalten bei `db_enabled=false` |
|---|---|
| `index.ts:326` `wantsDatabase = withDatabase !== false` | Default ist **true** — ein Aufrufer, der das Feld nicht kennt (altes Dashboard, Skript), bekommt weiterhin eine DB |
| `index.ts:333-345` | JWT-Secret, Anon-/Service-JWT und Authenticator-Passwort werden **trotzdem immer** erzeugt und gespeichert, damit ein späteres Nachprovisionieren dieselben Werte benutzt |
| MinIO-Bucket | wird **immer** angelegt, unabhängig von der DB-Entscheidung |
| `lib/secrets.ts:118` `buildEnvVars()` | **Keine** der DB-/Auth-Env-Variablen wird gesetzt (`GOTRUE_URL`, `JWT_SECRET`, `POSTGREST_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`). Bewusst kein Fallback auf die interne URL. |
| `lib/secrets.ts:107` | `NEXT_PUBLIC_SUPABASE_URL`/`_ANON_KEY` nur wenn **zusätzlich** `postgrest_public_enabled` **und** `PLATFORM_DOMAIN` gesetzt sind |
| `routes/cms.ts:66,139,165` | CMS-Aktivierung braucht `db_provisioned=true` → `409` / leere Tabellenliste |
| `routes/tenants.ts:169-223` | Ein-/Ausschalten: bei erstmaligem Einschalten volles Provisioning, danach nur `up -d` |
| `routes/tenants.ts:355` | Beim **Entsperren** eines Tenants werden Tenant-Dienste nur gestartet, wenn `db_enabled` — sonst bleiben sie bewusst aus |
| `routes/stats.ts:173` | DB-Größe wird nur für `db_provisioned` erhoben |

### 5.3 Weitere zustandsabhängige Verzweigungen (testrelevant)

| Flag / Zustand | Wirkung |
|---|---|
| `kunden.status = 'suspended'` | Webhook antwortet `423`; Container gestoppt; Router entfernt. **Prüft `runDeployment()` selbst nicht** — nur der Webhook-Handler und die Status-Route prüfen es. Ein manuelles `POST /deployments` auf einen gesperrten Tenant ist damit ein offener Prüfpunkt. |
| `postgrest_public_enabled` / `auth_public_enabled` | Steuern die Traefik-Router `<slug>-api.<domain>` / `<slug>-auth.<domain>` und die `NEXT_PUBLIC_*`-Injection. Ohne RLS-Policies = offene DB. |
| `cms_enabled` + `cms_db_password_encrypted` | CMS-Zugriff; Rolle `cms_<slug>` mit Rechten nur auf freigegebene Tabellen |
| `projects.env_dirty` | Env geändert, aber noch nicht deployt |
| Domain `kind = 'custom'` vs. Plattform-Subdomain | Zweiter ACME-Resolver (HTTP-01 statt DNS-01) |
| `hasPrimaryKey` (Table-Editor) | Fällt auf `ctid` zurück. **Zusammengesetzte PKs sind nicht korrekt behandelt (offener Punkt P1-2)**; das CMS lehnt sie explizit ab. |

### 5.4 Testmatrix-Konsequenz

Statt "3 Tarife" ergibt sich mindestens: **3 Tarife × {DB an, DB aus} × {aktiv, suspended} × {PostgREST öffentlich, intern} × {CMS an, aus}**. Für Phase 3 realistisch sind die Kombinationen, die im Betrieb vorkommen:

1. Starter ohne DB, aktiv — reine Landingpage (der Sparfall, für den Migration 19 gebaut wurde)
2. Starter mit DB, aktiv, PostgREST intern — Standardfall
3. Business/Premium mit DB, PostgREST öffentlich, CMS an — Vollausbau (entspricht `up2-site`)
4. Beliebiger Tarif, `suspended` — Sperr-Verhalten
5. Tenant mit DB, `db_enabled=false` — der "abgeschaltet, aber Daten da"-Fall

---

## 6. Stand der Sprint-Fixes (P0–P3)

### 6.1 Wie der Stand rekonstruiert wurde

Die Sprint-Skripte waren einmalig ausgeführte Shell-Skripte, die sich nach Anwendung selbst aus dem Repo entfernt haben (z.B. `sprint20-p3-6-disk-cleanup.sh`, 1.666 Zeilen, in `e53ed68` gelöscht). Im Working Tree existiert **keines** mehr. In der Git-Historie nachweisbar sind sieben: `sprint14-p2-6` … `sprint20-p3-6`.

Der belastbare Nachweis, was umgesetzt ist, sind daher die **`P<n>-<m>`-Marker in den Code-Kommentaren** — die Autoren haben jeden Fix an der Codestelle vermerkt. Gefunden wurden **38 eindeutige Marker** plus drei Audit-Paragraphen (`Audit §5`, `§11`, `§15`).

### 6.2 Umgesetzt (im Code nachweisbar)

**P0 — alle fünf behoben:**

| ID | Fix | Ort |
|---|---|---|
| P0-1 | Socket-Proxy raus aus `traefik-net`, eigenes `internal`-Netz; `EXEC=0`, `VOLUMES=0` | `provisioning-agent/docker-compose.yml` |
| P0-2a | `REVOKE ALL ON DATABASE ... FROM PUBLIC` direkt nach `CREATE DATABASE` | `lib/tenantDatabase.ts:135` |
| P0-2b | Rollen pro Tenant statt clusterweit; `role`-Claim + `PGRST_DB_ANON_ROLE` angepasst | `authenticator-role.sql.template`, `templates/tenant-compose.yml` |
| P0-3 | Advisory Lock + `already exists`-Guard gegen destruktives Rollback | `index.ts:262-320`, `index.ts:405-420` |
| P0-4 | Geteilte `cleanupTenantResources()`, jeder Schritt fehlertolerant; Existenz-Check vor jeder Ressourcenerstellung; `secretValues` für `maskSecrets` | `index.ts:145`, `lib/deploy.ts:261` |
| P0-5 | Backups wiederherstellbar: Globals mitsichern, Cron-Scheduler, Alarm bei Fehlschlag | `backups/backup-script.sh`, `backups/cron.d-multitenant-backup` |

**P1 — 11 von 11 Markern im Code, einer davon offen:**

`P1-1` (+ Varianten `b,c,f,h,i,j`) Domain-Flow/Verifikation · `P1-3` · `P1-4` async-Router-Wrapper + `pg`-Error-Listener + `unhandledRejection`/`uncaughtException`-Handler · `P1-5` Connection-Leaks (+ `idle_session_timeout` in Postgres) · `P1-6` · `P1-7` GoTrue-Port explizit + `RESEND_API_KEY` wirklich durchgereicht · `P1-8` `/stats`-Routen · `P1-9` · `P1-10` `PGRST_DB_PREPARED_STATEMENTS=false` · `P1-11` `suspended`-Prüfung im Webhook.
**`P1-2` ist offen** — zusammengesetzte Primärschlüssel im Table-Editor, explizit im README als offener Punkt genannt.

**P2 — umgesetzt:** `P2-1` GoTrue-Readiness-Poll statt `sleep 8000` · `P2-2` Table-Editor (ctid-Fallback, Filter) · `P2-3` SQL-Editor (Limit-Wrapping gegen OOM) · `P2-4` Deployments/Cancel · `P2-6` Kundenstamm + Fallback `display_name` · `P2-7` verwaiste Projekte + `schema_migrations` mit Checksumme · `P2-11` `GOTRUE_DISABLE_SIGNUP=true` · `P2-12` · `P2-17` MinIO-Policy-Datei nach Gebrauch löschen · `P2-19` zeitkonstanter Secret-Vergleich.
Nicht als Marker auffindbar: `P2-5`, `P2-8`, `P2-9`, `P2-10`, `P2-13`–`P2-16`, `P2-18` — vermutlich nie vergeben oder in Sammel-Commits ohne Marker aufgegangen. **Nicht rekonstruierbar, ob umgesetzt.**

**P3 — umgesetzt:** `P3-1` cloudflared gepinnt · `P3-2` Rate-Limiting mit Actor-Key, GET ausgenommen · `P3-3` Doku-Korrekturen · `P3-4` CI-Workflow · `P3-5` Audit-Log vervollständigt (Login, SQL-Editor, Tabellen-Edits, Backups, echter Actor + IP) · `P3-6` täglicher Disk-Cleanup.

**Audit-Paragraphen:** `§5` PgBouncer-Pooling · `§9` Restore-Test prüft Zeilen-Counts · `§10` Deploy-Rename-Fenster · `§11` `mem_limit` überall + Postgres-Tuning für 8 GB · `§15` Alarmierung + `log_connections`.

**Zweiter Durchgang 18.08.2026** (fünf Befunde, alle behoben): CMS-Feldprüfung übersprang Grenzen bei optionalen Feldern · CMS-Login ohne Bremse (bcrypt-DoS) · Uploads nur nach Dateigröße, nicht nach dekodierter Bildfläche begrenzt · Postgres-Rohmeldungen an Endnutzer · `!==` statt `timingSafeEqual`.

### 6.3 Offen (aus README "Ehrlicher Sicherheitsstand" + eigener Analyse)

| # | Offener Punkt | Quelle |
|---|---|---|
| 1 | **Keine Testsuite.** 7 von 11 der schwersten Audit-Befunde wären von 4 Integrationstests gefunden worden: Tenant-Isolation, Backup-Restore, Deploy-Concurrency, Route-Vertrag | README |
| 2 | `gotrue_jwt_secret`, `authenticator_password`, `webhook_secret` im Klartext in der DB | README |
| 3 | **P1-2**: zusammengesetzte Primärschlüssel im Table-Editor | README |
| 4 | CMS-Speicherkontingent nicht atomar geprüft | README |
| 5 | CMS-Rate-Limit-Zähler im Prozessspeicher (bei >1 Instanz nach Redis) | README |
| 6 | Skalierungsgrenze: 5–10 Tenants auf 8 GB | README |
| 7 | `next-auth` als Beta mit Caret-Range | README |
| 8 | Traefik exportiert Prometheus-Metriken, **niemand scrapt sie** | eigene Analyse |
| 9 | Rollback-Guards hängen an String-Matching (`/already exists/i`) auf Fehlermeldungen | eigene Analyse (§4.3) |
| 10 | Kein Test/keine Regel erzwingt den `auth()`-Guard in neuen Dashboard-Routen | eigene Analyse (A5) |
| 11 | Clusterweite Alt-Rollen `anon`/`authenticated`/`service_role` existieren weiterhin, `service_role` mit `BYPASSRLS` | eigene Analyse (§2, Ebene 2) |
| 12 | `P2-5`, `P2-8`–`P2-10`, `P2-13`–`P2-16`, `P2-18` nicht im Code nachweisbar | eigene Analyse |

---

## 7. Risiko-Absicherung für die folgenden Phasen

Alles läuft auf **einer** Live-VPS mit echten Kunden (aktuell 2 Tenants: `sofre`, `up2-site`; 17 Container). Es gibt kein Staging. Daraus folgt für Phase 2/3:

**Absolut nicht ohne separate Umgebung testen:**
- `DELETE /tenants/:slug` und jeder Pfad, der `cleanupTenantResources()` erreicht — inklusive **fehlgeschlagenem** `POST /tenants`
- `DELETE /projects/:id`, `DELETE /containers/orphan/:name`
- `POST /tenants/:slug/rotate-secret` (invalidiert ausgelieferte Kunden-Keys)
- `POST /cleanup/run` und alles, was einen **Agent-Neustart** auslöst (zieht binnen 5 Min einen Cleanup-Lauf nach sich)
- Jeder Lasttest gegen `core-postgres` — `max_connections=60` ist das Budget für **alle** Tenants; PgBouncer `QUERY_WAIT_TIMEOUT=15s`
- Jeder Nixpacks-Build unter Last — ein Build fordert 1–2 GB an; der Kernel-OOM-Killer nimmt nach `oom_score` typischerweise Postgres, also die DB **aller** Kunden

**Vorbedingungen, bevor Phase 2 beginnt:**
1. Verifiziertes, frisches Backup + **durchgeführter** `restore-test` (nicht nur der geplante Cron-Lauf)
2. Ein Wegwerf-Tenant (`test-<datum>`) für alle destruktiven Pfade — **niemals** `sofre` oder `up2-site`
3. Geklärt, wo eine zweite Umgebung herkommt: zweite VPS, lokales Compose-Setup oder Docker-in-Docker. Ohne das sind die vier vom README selbst benannten Integrationstests (Tenant-Isolation, Backup-Restore, Deploy-Concurrency, Route-Vertrag) auf dieser Maschine nicht durchführbar.
4. Der Lasttest-Befund aus dem Audit (Cloudflare/`Cf-Connecting-Ip`) zeigt: der wertvollste Test dieser Plattform ist ein Lasttest gegen die **echte Kette** inklusive Cloudflare. Genau der ist auf der Live-VPS am gefährlichsten. Diesen Zielkonflikt muss Phase 2 auflösen, nicht Phase 3.

**Sofort und gefahrlos machbar (Klasse 3):** alle `GET`-Routen, `/health`, `/stats/*`, `/security/components`, `/audit-logs`, `POST /backups/restore-test` (Wegwerf-DB), sowie jede rein statische Prüfung (Typecheck, Lint, Struktur-Tests gegen den Auth-Guard).
