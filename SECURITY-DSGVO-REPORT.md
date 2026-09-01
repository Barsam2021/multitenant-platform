# SECURITY- & DSGVO-REPORT

**Stand:** 2026-08-27 · **Branch:** `claude/backup-prozedur-main-1ibs2q` · **Basis-Commit:** `0b0d3bb`
**Grundlage:** `ANALYSE_1.md` (Ist-Analyse), `TESTPLAN.md` §2/§3 (Testkategorien, DSGVO-Prüfpunkte), `CI-SETUP.md` (Pipeline-Zuschnitt).
**Zweck:** Vertiefung der groben Prüfpunkte aus `TESTPLAN.md` zu konkret reproduzierbaren Testfällen und benannten Lücken.
**Es wurde in diesem Schritt nichts behoben.** Jede Empfehlung ist ein Vorschlag, keine Änderung.

---

## 0. Ausführungsrahmen — was tatsächlich getestet werden konnte

Dieser Abschnitt steht vorne, weil er den Beweiswert jeder folgenden Zeile bestimmt.

### 0.1 Blocker B-1 (P0): es gibt keine dauerhaft nutzbare isolierte Testumgebung

`TESTPLAN.md` §0 nennt die fehlende SBX-Umgebung als Blocker OQ-09. Seitdem ist ein isolierter Stack entstanden (`docker-compose.ci.yml`, `scripts/ci/`, zwei Dummy-Tenants `ci-alpha`/`ci-beta` aus `scripts/ci/env.sh`). **Der Blocker ist damit aber nur zur Hälfte aufgelöst:**

| | Zustand |
|---|---|
| **Existiert** | Ein vollständiger Zwei-Tenant-Stack mit echtem Agent-Code (`scripts/ci/provision-test-tenants.js` ruft `provisionTenantDatabaseSchema()`, nicht eine Nachbildung) |
| **Läuft aber ausschließlich** | im GitHub-Actions-Runner. `scripts/ci/assert-not-production.sh` bricht bei `CI != true`, bei vorhandener `.env` und bei laufenden Plattform-Containern ab — alle drei Merkmale treffen auf diese Maschine zu |
| **Konsequenz** | Auf der VPS ist **kein aktiver Zugriffstest ausführbar**, ohne die Produktion anzufassen. Der Abbruch ist korrekt und darf nicht umgangen werden: der CI-Stack benutzt dieselben Container-Namen (`core-postgres`, `pgbouncer`, `core-minio`) und würde die laufenden Kundendienste überschreiben |
| **Zusätzlich** | `CI-SETUP.md` OP-8: die Jobs `integration` und `security` sind **noch nie in einem echten Runner gelaufen**, nur statisch geprüft |

**Was das für diesen Bericht heißt:** Teil 1 ist zu ~85 % **Code-Analyse plus Lektüre der bestehenden CI-Suite**, ergänzt um lesende Klasse-3-Prüfungen auf der Live-VPS (`ANALYSE_1.md` §4.2). Kein Testfall unten wurde gegen einen echten Kundenmandanten aktiv ausgeführt. Die Testfälle sind so formuliert, dass sie **ausführbar sind, sobald** entweder (a) die Pipeline auf GitHub das erste Mal grün läuft, oder (b) eine dauerhafte SBX-Umgebung existiert.

### 0.2 Was der CI-Stack heute abdeckt — und was nicht

| Prüfebene | Abgedeckt durch | Status |
|---|---|---|
| DB-Isolation Ebene 1–3 | `scripts/ci/security/isolation.test.js` (10 Negativtests) | **Code vorhanden, Erstlauf ausstehend** |
| Auth-Guard aller Dashboard-Routen | `scripts/ci/unit/structure.test.js` TC-ADM-01 | vorhanden, lokal grün |
| MinIO-Policy-**Form** | `structure.test.js` TC-STOR-01 (Teilabdeckung) | vorhanden |
| MinIO-Cross-Tenant-**Zugriff** | — | **Lücke, siehe S-05** |
| Netz-Isolation Ebene 4 | — | **Lücke, siehe S-04** |
| Parallelität / Race Conditions | — | **Lücke, siehe S-06** |
| JWT-Ablauf/Manipulation | `scripts/ci/integration/tenant-api.test.js` (teilweise) | teilweise |
| Rate-Limiting Auth-Endpunkte | — | **Lücke, siehe S-08/S-09** |

### 0.3 Klasse-3-Prüfungen, die für diesen Bericht auf der Live-VPS ausgeführt wurden

Ausschließlich lesend, keine Kundendaten-Inhalte gelesen:

- `information_schema.columns` für das `auth`-Schema von `kunde_up2-site` (Spaltennamen, keine Werte) → DS-07
- `SELECT count(*)` auf `auth.users` / `auth.audit_log_entries` → DS-07
- `ls -la` auf `traefik/logs/`, `backups/age-identity.txt`, `/etc/logrotate.d/` → DS-01, DS-11
- Feldnamen und Zeitstempel der ersten/letzten Zeile von `access.log` (keine IP-Werte protokolliert) → DS-01
- `rclone lsd --dump headers` gegen den eigenen B2-Bucket (nur der API-Hostname wurde ausgewertet) → DS-23

---

# TEIL 1 — Auth- und Zugriffs-Sicherheit

## 1.1 Endpunkt-Inventar (Auftragspunkt 1.3)

Vollständige Liste aller HTTP-Oberflächen. Spalte „Erreichbar von" ist die entscheidende: ein Endpunkt mit schwacher Prüfung, der nur containerintern erreichbar ist, hat ein anderes Risiko als einer im offenen Internet.

### A. Provisioning-Agent (`provisioning-agent`, Port 3001)

Schutzmechanismus: eine einzige `app.use`-Middleware auf `X-Agent-Secret`, zeitkonstant verglichen (`index.ts:93` `secretMatches()`, `index.ts:115`). **Kein Rollenmodell** — wer das Secret hat, darf alles.

| Pfad | Auth | Erreichbar von | Anmerkung |
|---|---|---|---|
| `GET /health` | **keine** | nur `traefik-net` intern | Bewusst vor der Middleware (`index.ts:110`). Antwort ist eine Konstante. **Kein Befund** |
| `POST /webhooks/github/:projectId` | HMAC-SHA256 über Rohbody | **öffentliches Internet** (`webhooks.<PLATFORM_DOMAIN>`) | Eigener Limiter (120/5min, **ohne** `keyGenerator` → pro IP). Siehe S-10 |
| `POST /tenants`, `DELETE /tenants/:slug` | `X-Agent-Secret` | intern | `sensitiveOpLimiter` (30/h) |
| `GET/PATCH /tenants/:slug`, `/tenants/:slug/api-keys`, `/status`, `/database`, `/public-access`, `/rotate-secret`, `/postgrest/reload`, `/cms*` | `X-Agent-Secret` | intern | **kein** `sensitiveOpLimiter`, nur `globalLimiter` |
| `/projects*`, `/deployments*`, `/domains*`, `/github*`, `/backups*`, `/secrets*`, `/audit-logs`, `/stats*`, `/cleanup/run`, `/analytics*`, `/security/*` | `X-Agent-Secret` | intern | 51 Routen gesamt |

**Befund S-01 (P1) — `globalLimiter` überspringt jeden GET.** `index.ts:63` `skip: (req) => req.method === 'GET'`. Die Begründung im Kommentar (Dashboard-Polling verbrauchte das Budget) ist nachvollziehbar, die Folge ist aber, dass **jede lesende Route des Agents unbegrenzt aufrufbar** ist, sobald das Secret bekannt ist — einschließlich `GET /tenants/:slug/api-keys`, die `anon_jwt` und `service_role_jwt` im Klartext zurückgibt (`routes/tenants.ts:63-87`). Ein Angreifer mit Secret braucht kein Rate-Limit-Budget, um alle Tenant-Schlüssel abzuziehen.

**Befund S-02 (P2) — der Rate-Limit-Schlüssel ist vom Aufrufer wählbar.** `actorKey()` (`index.ts:54`) liest `X-Actor` aus dem Request. Wer das Secret hat, umgeht damit jeden Zähler durch Variation des Headers. In `TESTPLAN.md` bereits als TC-RATE-03/TC-AUD-04 als bekannter Zustand vermerkt; hier ergänzt um die Feststellung, dass derselbe Header auch das Audit-Log füllt (`index.ts:120-127`) — ein kompromittiertes Secret kann seine Spuren also frei beschriften.

### B. Admin-Dashboard (`admin-dashboard`, `127.0.0.1:3000`)

| Pfad | Auth | Anmerkung |
|---|---|---|
| 49 Dateien unter `app/api/**/route.ts` | `auth()` je Handler | **Vollständig verifiziert** (siehe unten) |
| `/api/auth/[...nextauth]` | — (ist der Login) | einzige Ausnahme, in `structure.test.js` GUARD_EXEMPT festgeschrieben |
| `/dashboard/*` | NextAuth-Middleware | `middleware.ts` matcher |

**Verifiziert, kein Befund:** Ein Scan über alle 49 Route-Dateien zeigt in **jeder** einen `auth()`-Aufruf. `structure.test.js` prüft das zusätzlich pro exportiertem HTTP-Handler (nicht nur pro Datei) und sichert sich mit `routeFiles.length >= 40` gegen den stillen Fehlfall eines umbenannten Verzeichnisses ab. Das ist die sauberste Stelle der ganzen Codebasis.

**Befund S-03 (P2) — der `middleware.ts`-Matcher deckt nur einen Teil der API ab.** `matcher: ["/dashboard/:path*", "/api/tenants/:path*"]`. Die übrigen ~30 API-Pfade (`/api/projects`, `/api/backups`, `/api/deployments`, `/api/provision-tenant`, …) laufen **nicht** durch die Middleware und hängen allein am Per-Route-`auth()`. Heute ist das lückenlos; die Middleware wäre die zweite, strukturelle Schicht. Der Struktur-Test ersetzt sie funktional, aber erst nach dem Commit statt zur Laufzeit.

### C. PostgREST / GoTrue je Tenant

Standardmäßig **nicht** öffentlich (`api-<slug>:3000` / `auth-<slug>:9999` nur in `traefik-net`). Öffentlich erst nach `POST /tenants/:slug/public-access` — opt-in, dokumentiert, mit `api-ratelimit`-Middleware (20 req/s, `sourceCriterion: Cf-Connecting-Ip`). **Korrekt gelöst.**

### D. CMS (`cms`, Port 3002) — der einzige dauerhaft öffentliche Dienst mit Login

`/api/[tenant]/login`, `/logout`, `/collections/*/rows`, `/media`. Mandantengrenze an genau einer Stelle: `requireSession(tenantSlug)` (`cms/src/lib/session.ts:94`), Tenant kommt aus dem Cookie, nie aus der URL, plus DB-Revalidierung bei **jedem** Aufruf.

### E. MinIO über `media.up2-web.com`

Traefik-Router auf `core-minio:9000` (`traefik/dynamic/media.yml`), **ohne Rate-Limit-Middleware**. Anonym lesbar ist ausschließlich das Präfix `public/` je Bucket (`mc anonymous set download`, `lib/cms.ts:365`).

**Befund S-11 (P2) — `media.yml` hat keine `public-ratelimit`-Middleware,** anders als die vom Agent erzeugten Tenant-Router. Kein Vertraulichkeitsproblem (nur `public/` ist lesbar), aber der Bucket ist über diesen Router unbegrenzt abrufbar → Traffic-/Kostenhebel.

---

## 1.2 Tenant-Isolation — konkrete Testfälle (Auftragspunkt 1.1)

### Ebene DB: bestehende Abdeckung ist gut

`scripts/ci/security/isolation.test.js` deckt bereits ab, mit jeweils **Negativtest**:
`authenticator_A` → `kunde_B` verweigert · keine Tenant-DB mit `PUBLIC CONNECT` · Tenant-Rollen ohne `CONNECT` auf fremde DB · `authenticator` ist `NOINHERIT` und nur Mitglied eigener Rollen · keine `BYPASSRLS`-Rolle an einen Authenticator vergeben · PgBouncer weist falsches Passwort ab (statt still auf `postgres` zu mappen) · `current_user` ist der Authenticator, nicht `postgres`.

Codeseitig bestätigt: `tenantDatabase.ts:159` `REVOKE ALL ON DATABASE ... FROM PUBLIC` direkt nach `CREATE DATABASE`, `:187` `GRANT CONNECT` nur an die eine Rolle. Das Rollen-Template (`core-postgres/templates/authenticator-role.sql.template`) legt `service_role_<slug>` mit `BYPASSRLS` an — als **Rollen-Attribut**, das über Mitgliedschaft nicht vererbt wird, und `authenticator_<slug>` ist `NOINHERIT`, muss also explizit `SET ROLE` machen. Sauber.

### Neue Testfälle — was heute fehlt

| ID | P | Testfall | Erwartet | Umg |
|---|---|---|---|---|
| **S-04** | **P0** | **Netz-Isolation (Ebene 4).** Aus `app-A` heraus: `getent hosts api-B`, `nc -z pgbouncer 5432`, `nc -z docker-socket-proxy 2375`, `nc -z core-minio 9000` | Alle vier nicht auflösbar bzw. nicht erreichbar; nur Egress ins Internet funktioniert | SBX |
| **S-05** | **P0** | **MinIO Cross-Tenant.** Mit den IAM-Credentials von A: `mc ls`, `mc cp`, `mc rm`, `mc stat` gegen `kunde-B-storage` — alle vier Verben einzeln | Jeweils `AccessDenied`. Die Policy nennt nur zwei ARNs (`index.ts` Policy-Doc), aber **kein Test führt den Zugriff aus** | SBX |
| **S-05b** | **P1** | Mit A-Credentials `mc admin user list` / `mc admin policy list` gegen MinIO | `AccessDenied` — der Tenant-User darf keine Admin-API sehen (die Policy vergibt nur `s3:*`-Actions, aber das ist nie geprüft) | SBX |
| **S-06** | **P0** | **Race Condition Tenant-Kontext.** 50 parallele Requests gegen `api-A` mit A-JWT und gleichzeitig 50 gegen `api-B` mit B-JWT, jeweils `SELECT current_database(), current_user`, über PgBouncer im `transaction`-Modus | Jede Antwort nennt die eigene DB und die eigene Rolle. Der kritische Punkt: PostgREST setzt `SET ROLE` pro Transaktion, PgBouncer recycelt Server-Verbindungen zwischen Transaktionen — bleibt ein `SET ROLE` hängen, sieht Tenant B die Rolle von A | SBX |
| **S-06b** | **P1** | Gleicher Aufbau, aber `SHOW search_path` prüfen | `authenticator_<slug>` hat `ALTER ROLE ... IN DATABASE ... SET search_path = auth, public` (`tenantDatabase.ts:186`). Zu prüfen ist, ob ein `SET search_path` aus einer Anwendungstransaktion über die gepoolte Verbindung überlebt | SBX |
| **S-07** | **P1** | **CMS-Mandantengrenze über alle Routen.** Als Redakteur von A jede der 5 CMS-API-Routen mit dem Slug von B aufrufen | Überall 401/403 durch `requireSession()`. Heute nur durch Disziplin gesichert — es gibt keinen Struktur-Test analog TC-ADM-01, der prüft, dass **jede** CMS-Route `requireSession(tenantSlug)` aufruft | SBX / CI (Strukturtest) |

**Empfehlung zu S-07:** Der billigste Gewinn im ganzen Teil 1 ist ein zweiter Struktur-Test in `scripts/ci/unit/structure.test.js`, der `cms/src/app/api/**/route.ts` genauso scannt wie heute die Dashboard-Routen — Aufwand ~20 Zeilen, läuft in Millisekunden, schließt dieselbe Klasse von Lücke (neue Route ohne Guard) für den einzigen öffentlich erreichbaren Dienst mit Login.

**Empfehlung zu S-05:** `CI-SETUP.md` OP-1 benennt die Ursache bereits korrekt — die MinIO-Provisionierung liegt inline im Request-Handler von `POST /tenants` (`index.ts:340-375`) und ist ohne Serverstart nicht aufrufbar. Herauslösen nach `lib/minio.ts` (analog `provisionTenantDatabaseSchema()`), danach ist der Negativtest ein Zehnzeiler. Das ist derzeit die **größte einzelne Testlücke auf P0-Ebene**.

---

## 1.3 Auth-Schwachstellen (Auftragspunkt 1.2)

### JWT-Validierung

| Befund | P | Details |
|---|---|---|
| **S-08 — Tenant-API-Keys haben kein `exp` und laufen nie ab** | **P1** | `lib/jwt.ts:signTenantJwt()` signiert `{ role, iss }` mit HS256 — **ohne `exp`, ohne `aud`, ohne `iat`**. Das ist die Supabase-Konvention für API-Keys und im Code bewusst begründet. Die Konsequenz muss trotzdem benannt sein: `service_role_<slug>` ist ein **unbefristeter Schlüssel mit `BYPASSRLS`** auf die komplette Tenant-DB. Ein Leak (Git-Commit, Browser-DevTools, Screenshot, Logdatei) ist dauerhaft wirksam. Widerruf **nur** über `POST /tenants/:slug/rotate-secret` — was jeden hartkodierten Kundenschlüssel gleichzeitig bricht, also praktisch eine Ausfallzeit-Entscheidung ist |
| **S-08b — abgelaufene Tokens: nicht anwendbar für API-Keys, ungeprüft für GoTrue-Tokens** | P1 | GoTrue-Nutzertokens haben ein `exp`. Ob PostgREST ein abgelaufenes Token zuverlässig ablehnt, ist **nicht getestet** — `scripts/ci/integration/tenant-api.test.js` prüft Signaturen, aber der Ablauf-Pfad fehlt |
| **Manipulierte Tokens** | — | Konzeptionell abgedeckt: Secrets sind je Tenant verschieden (`crypto.randomBytes(32)` pro Tenant, `index.ts:295`), ein A-Token gegen `api-B` scheitert an der Signatur. TC-ISO-05/TC-AUTH-03 sind im Testplan benannt; ein Testfall dafür gehört in `scripts/ci/integration/` |

**Konkrete Testfälle:**

| ID | P | Testfall | Erwartet |
|---|---|---|---|
| S-08-T1 | P1 | JWT mit `{ role: 'service_role_A' }`, signiert mit dem Secret von **B**, gegen `api-B` | 401 `JWSError` |
| S-08-T2 | P1 | Gültiges A-Token, `role`-Claim per Editor auf `service_role_B` geändert, Signatur unverändert | 401 — Signatur bricht |
| S-08-T3 | P1 | GoTrue-Nutzertoken mit `exp` in der Vergangenheit gegen `api-A` | 401 `JWTExpired`. **Prüft, ob PostgREST `exp` überhaupt auswertet, wenn andere Tokens keins haben** |
| S-08-T4 | P1 | Token mit `alg: none` bzw. mit `alg: RS256` und selbst erzeugtem Schlüssel | 401 — kein Algorithm-Confusion |

### Privilege Escalation

| Befund | P | Details |
|---|---|---|
| **S-12 — es gibt kein Rollenmodell, das eskaliert werden könnte** | — | Dashboard: genau **ein** Admin aus `ADMIN_EMAIL`/`ADMIN_PASSWORD_HASH`. Agent: genau **ein** Secret. Damit ist „normaler User erreicht Admin-Endpunkt" strukturell nicht anwendbar. **Das ist kein Freibrief, sondern eine Umkehrung des Risikos**: ein einziger kompromittierter Anmeldedatensatz ist sofort Vollzugriff auf alle Tenants, ohne Zwischenstufe |
| **S-13 — CMS-Rollen `editor`/`admin` werden nicht durchgesetzt** | **P1** | `cms_users.role` hat einen CHECK auf `('editor','admin')` (`21_cms.sql:78`) und wird in die Session geschrieben (`session.ts`), aber **keine CMS-Route wertet `session.role` aus**. Ein `editor` kann alles, was ein `admin` kann. Entweder ist die Spalte Zierde — dann gehört sie dokumentiert oder entfernt — oder die Durchsetzung fehlt |
| **S-14 — SQL-Editor läuft als Superuser** | **P0 (bekannt)** | `ANALYSE_1.md` A3/A4. Bewusste Entscheidung, aber sie bedeutet: der Betreiber kann technisch **jede** Kundendatenbank vollständig lesen und ändern. Für die DSGVO ist das kein Security-Befund, sondern eine AVV-Pflicht (siehe DS-08/D-11 unten) |

**Testfall S-13-T1 (P1, CI-tauglich):** Struktur-Test über `cms/src/app/api/**/route.ts` — jede schreibende Route (`POST`/`PATCH`/`DELETE`) referenziert `session.role`. Schlägt heute fehl; das ist die Absicht (dokumentiert den Ist-Zustand, bis die Produktentscheidung fällt).

### Rate-Limiting und Brute-Force

| Endpunkt | Bremse | Bewertung |
|---|---|---|
| **CMS-Login** `/api/[tenant]/login` | 10 Versuche/IP/Minute **vor** dem `bcrypt`-Aufruf (`login/route.ts:29`), zusätzlich `cms_users.failed_logins` + `locked_until` pro Konto, generische Fehlermeldung für alle Fälle | **Vorbildlich.** Der Kommentar benennt exakt den richtigen Grund (bcrypt-DoS vor Kontosperre) |
| **Dashboard-Login** `/api/auth/[...nextauth]` | **keine** | **Befund S-09 (P1)** — siehe unten |
| **GoTrue** `auth-<slug>:9999` | Traefik `api-ratelimit`, 20 req/s per `Cf-Connecting-Ip`, **nur wenn** `auth_public_enabled` | **Befund S-10 (P1)** — siehe unten |
| **Agent-Webhooks** | 120/5 Min, **pro IP** (kein `keyGenerator`) | GitHub-Hooks kommen aus einem festen IP-Bereich → ein einzelnes Budget für alle Projekte. Bei vielen Projekten ein Selbst-DoS-Risiko, kein Sicherheitsbefund. **P3** |

**Befund S-09 (P1) — Dashboard-Login ohne Bremse.**
`dashboard/src/auth.ts` `authorize()` ruft `bcrypt.compare()` bei jedem Versuch, ohne jede Zählung. Kein `hit()`, kein `locked_until`, kein Delay. Zwei Folgen: (a) Passwort-Raten ist unbegrenzt, (b) jeder Versuch kostet eine bcrypt-Runde, das ist ein billiger CPU-DoS gegen das Dashboard.
**Entlastend:** Das Dashboard lauscht auf `127.0.0.1:3000` und hat keinen Traefik-Router — erreichbar nur über den Cloudflare-Tunnel. **Offene Frage OQ-S1:** Ist auf dem Tunnel **Cloudflare Access** (Zero-Trust-Policy) aktiv? Steht in der Cloudflare-Konsole, nicht im Repo. Mit Access davor ist S-09 P3; ohne Access ist der Login-Endpunkt aus dem offenen Internet erreichbar und S-09 ist **P0**. Das ist die wichtigste zu klärende Einzelfrage dieses Berichts.
**Empfehlung:** `cms/src/lib/rateLimit.ts` existiert bereits und ist dependency-frei. Dieselben ~5 Zeilen in `authorize()` (Schlüssel: `cf-connecting-ip`, 10/Minute, **vor** `bcrypt.compare`) schließen den Befund unabhängig davon, wie OQ-S1 ausgeht.

**Befund S-10 (P1) — GoTrue ohne eigenes Rate-Limit.**
Das Compose-Template (`provisioning-agent/templates/tenant-compose.yml`) setzt `GOTRUE_DISABLE_SIGNUP=true` und `GOTRUE_MAILER_AUTOCONFIRM=false` — beides richtig. Es setzt **keine** `GOTRUE_RATE_LIMIT_*`-Variablen (GoTrue kennt u. a. `GOTRUE_RATE_LIMIT_EMAIL_SENT`, `..._TOKEN_REFRESH`, `..._VERIFY`). Der einzige Schutz ist die Traefik-Middleware mit **20 req/s pro IP** — das sind 72.000 Login-Versuche pro Stunde und IP. Zusätzlich: `GOTRUE_SMTP_PASS` ist der **plattformweite** `RESEND_API_KEY`; ein Angreifer, der `/recover` gegen einen öffentlich geschalteten Tenant flutet, verbrennt das Mail-Kontingent **aller** Tenants.
**Testfälle:** S-10-T1 (P1, SBX) 200 `POST /token?grant_type=password` in 10 s gegen `auth-A` mit falschen Daten → wie viele kommen durch? · S-10-T2 (P1, SBX) 100 `POST /recover` → wie viele Mails gehen tatsächlich raus?

---

## 1.4 Priorisierte Lückenliste Teil 1

| ID | P | Lücke | Empfehlung |
|---|---|---|---|
| **B-1** | **P0** | Kein dauerhaft nutzbarer isolierter Test-Tenant; CI-Stack nur im GitHub-Runner, Erstlauf ausstehend | Pipeline auf GitHub laufen lassen (`CI-SETUP.md` OP-8). Danach entscheiden, ob eine dauerhafte SBX nötig ist oder der Runner-Stack reicht |
| **S-05** | **P0** | MinIO-Cross-Tenant-Zugriff nie aktiv getestet, nur die Policy-**Form** | MinIO-Provisionierung aus `index.ts` nach `lib/minio.ts` herauslösen, dann Negativtest |
| **S-04** | **P0** | Netz-Isolation (Ebene 4) nicht getestet | Braucht Traefik + Dummy-App im CI-Stack (`CI-SETUP.md` OP-7) |
| **S-06** | **P0** | Parallelität / Tenant-Kontext unter PgBouncer-Transaction-Pooling nie geprüft | Parallel-Test gegen den CI-Stack; braucht keinen neuen Dienst, nur ein Testskript |
| **S-09** | **P1**/P0 | Dashboard-Login ohne Rate-Limit. **Priorität hängt an OQ-S1** (Cloudflare Access aktiv?) | OQ-S1 klären; unabhängig davon `rateLimit.ts` in `authorize()` einsetzen |
| **S-10** | **P1** | GoTrue ohne `GOTRUE_RATE_LIMIT_*`; geteilter Resend-Key als Kollateralrisiko | Rate-Limit-Variablen ins Template; `resend_api_key_encrypted` je Tenant ist bereits vorgesehen, aber ungenutzt |
| **S-08** | **P1** | Unbefristete `service_role`-Schlüssel mit `BYPASSRLS`, Widerruf nur global | Als bewusste Entscheidung dokumentieren **oder** `exp` + Refresh einführen. Mindestens: Testfälle S-08-T1..T4 |
| **S-13** | **P1** | CMS-Rollen `editor`/`admin` existieren im Schema, werden nirgends durchgesetzt | Entscheiden: durchsetzen oder Spalte als ungenutzt kennzeichnen |
| **S-07** | **P1** | Kein Struktur-Test für CMS-Routen-Guards (analog TC-ADM-01) | ~20 Zeilen in `structure.test.js`. **Bestes Aufwand/Nutzen-Verhältnis im Bericht** |
| **S-01** | **P1** | Alle GET-Routen des Agents unlimitiert, inkl. Schlüssel-Ausgabe | `/tenants/:slug/api-keys` vom GET-Skip ausnehmen |
| **S-03** | P2 | Middleware-Matcher deckt nur `/api/tenants/*` ab | Matcher auf `/api/:path*` erweitern, `[...nextauth]` ausnehmen |
| **S-02** | P2 | `X-Actor` frei wählbar → Rate-Limit- und Audit-Umgehung | Bekannter Zustand (TC-RATE-03). Festhalten, nicht stillschweigend lassen |
| **S-11** | P2 | `media.yml` ohne Rate-Limit-Middleware | `public-ratelimit` ergänzen |
| **S-05b** | P1 | Tenant-IAM-User gegen MinIO-Admin-API nicht getestet | Mit S-05 zusammen |

---

# TEIL 2 — DSGVO-Konkretisierung

Rollenverteilung wie in `TESTPLAN.md` §3 vorbemerkt: **Verantwortlicher** für Plattformdaten, **Auftragsverarbeiter** für Tenant-Anwendungsdaten. Dieser Teil ergänzt die dort begonnene Inventur um die Felder-Ebene und beantwortet drei der offenen Prüfaufträge mit Messwerten.

## 2.1 Datenkategorisierung — Feldebene (Auftragspunkt 2.1)

### A. Plattformdaten (UP2 Web Solutions ist **Verantwortlicher**)

| Ort | Konkrete Felder | Betroffene | Frist heute |
|---|---|---|---|
| `admin_dashboard.kunden` | `contact_email`, `display_name`, `notes` (Freitext) | Auftraggeber / deren Ansprechpartner | keine — bleibt bis Tenant-Löschung |
| `admin_dashboard.audit_logs` | `actor` (E-Mail des Admins), `ip_address`, `user_agent`, `meta` (JSONB, Aktionsdetails), `target` | Admin, indirekt Tenants | **keine Retention** — siehe D-03 |
| `admin_dashboard.cms_users` | `email`, `password_hash` (bcrypt), `display_name`, `last_login_at`, `failed_logins`, `locked_until` | Redakteure der Kunden (Beschäftigtendaten) | keine; `ON DELETE CASCADE` an `kunden.slug` |
| `admin_dashboard.cms_audit` | `user_email`, `user_id`, `ip`, `action`, `collection`, `row_pk`, `detail` (JSONB) | Redakteure | **keine Retention, kein FK** — siehe D-01 |
| `admin_dashboard.cms_media` | `original_name` (kann Personennamen enthalten), `uploaded_by` | Redakteure | `uploaded_by` ist `ON DELETE SET NULL` — korrekt |
| `admin_dashboard.analytics_visitors` | `visitor_hash` (salted, Salt rotiert täglich) | Website-Besucher | 90 Tage (`cleanup.ts:199`) |
| `admin_dashboard.analytics_daily/_page_views/_referrers` | nur Aggregate, `referrer` nur Schema+Host | — | 730 / 180 / 180 Tage |
| **`traefik/logs/access.log`** | **`request_Cf-Connecting-Ip` (echte Besucher-IP, Klartext)**, `request_User-Agent`, `RequestHost`, `RequestPath`, `ClientHost` (Cloudflare-Edge-IP) | **alle Besucher aller Kundenseiten** | **de facto ~5 Monate** — siehe D-02 |
| `.env` + `admin_dashboard` (Klartext-Secrets) | `gotrue_jwt_secret`, `authenticator_password`, `webhook_secret` | — (kein Personenbezug, aber Art.-32-relevant) | dauerhaft |

### B. Tenant-Anwendungsdaten (UP2 Web Solutions ist **Auftragsverarbeiter**)

| Ort | Konkrete Felder | Betroffene |
|---|---|---|
| `kunde_<slug>.auth.users` (GoTrue) | `email`, `encrypted_password`, `phone`, `confirmation_token`, `recovery_token`, `last_sign_in_at`, `banned_until`, `raw_user_meta_data` (JSONB, beliebig) | Endnutzer der Kunden |
| **`kunde_<slug>.auth.sessions`** | **`ip`, `user_agent`** | Endnutzer |
| **`kunde_<slug>.auth.audit_log_entries`** | **`ip_address`, `payload` (JSONB)** | Endnutzer |
| `kunde_<slug>.public.*` | anwendungsabhängig | Endnutzer der Kunden |
| MinIO `kunde-<slug>-storage` | Dateiinhalte; `public/`-Präfix **anonym lesbar** | beliebig |

**Referenzfall `up2-site` (`up2web-schema.sql`) — was dort konkret liegt:**

| Tabelle | Personenbezogene Felder | RLS-Status |
|---|---|---|
| `clients` | `name`, `email`, `phone`, `company`, `pain_point`, `notes`, `consent`, `consent_at` | RLS an, nur `service_role` (`:362`) — **korrekt** |
| `quiz_leads` | `name`, `email`, `phone`, `company`, `answers` (JSONB) | RLS an; `anon` darf INSERT, SELECT `USING (false)` (`:376-378`) — **korrekt** |
| `roi_leads` | `name`, `email`, `branche`, Umsatzangaben | RLS an, **keine Policy** → nur `service_role` (BYPASSRLS). Im Schema als Absicht vermerkt — **korrekt** |
| `submissions` | `name`, `email`, `phone`, `message` | RLS an; `anon` INSERT-only — **korrekt** |
| `website_checks` | `name`, `email`, `phone`, `company`, `domain` | RLS an; `anon` INSERT-only — **korrekt** |
| `subscribers` | `email` | RLS an; `anon` INSERT-only — **korrekt** |
| **`client_public`** | `name`, `company`, `salutation`, `industry`, `tier`, `package` | **RLS an, aber `anon` hat SELECT `USING (true)` UND UPDATE `USING (true) WITH CHECK (true)`** (`:365`, `:367`) + `GRANT UPDATE` (`:326`) |

**Befund D-09 (P1, kundenseitig) — `client_public` ist für `anon` frei les- und beschreibbar.**
Der Zweck ist ausweislich des Policy-Namens, dass ein Besucher `visited_at` markiert. Die Policy erlaubt aber `UPDATE` auf **alle Spalten aller Zeilen**: jeder mit dem `anon_up2-site`-Key kann `name`, `company`, `salutation`, `industry`, `tier` und `package` jedes Kunden beliebig überschreiben und alle Datensätze auslesen. Das ist eine Datenintegritäts- **und** Vertraulichkeitsfrage (Art. 5 Abs. 1 lit. d/f).
**Testfall D-09-T1 (P1, SBX, Kopie des Schemas — nicht gegen Produktion):** Mit Anon-Key `PATCH /client_public?slug=eq.<x>` mit `{"name":"TEST"}` → geht heute durch.
**Empfehlung (Kundenentscheidung, nicht Plattform):** Policy auf `WITH CHECK` für ausschließlich `visited_at` einschränken, oder besser über eine `SECURITY DEFINER`-Funktion — Spalten-Granularität kennt RLS nicht, dafür braucht es `GRANT UPDATE (visited_at) ON ...` statt `GRANT UPDATE ON ...`.

**Positiv-Feststellung zur Plattform:** Das Rollen-Template (`authenticator-role.sql.template`) vergibt **keinerlei** Tabellen-`GRANT`s und setzt keine `ALTER DEFAULT PRIVILEGES`. Eine frisch angelegte Tabelle in einer Tenant-DB ist für `anon_<slug>` deshalb **nicht** erreichbar, auch ohne RLS — es fehlt schon das `GRANT`. Die in `TESTPLAN.md` TC-REST-01 formulierte Sorge („Tabelle ohne RLS-Policy = voller Anon-Zugriff") trifft **nur** dann zu, wenn das Kundenschema selbst `GRANT ... TO anon_<slug>` ausführt und dann RLS vergisst. Das ist die realistische Fehlerform und sollte so getestet werden.

**Testfall D-10 (P0, CI, ohne neue Infrastruktur):** Bestandsprüfung über **alle** Tenant-DBs:
```sql
SELECT c.relname,
       c.relrowsecurity AS rls_an,
       (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policies,
       array_agg(DISTINCT a.grantee) AS grantees
  FROM pg_class c
  JOIN information_schema.role_table_grants a ON a.table_name = c.relname
 WHERE c.relkind='r' AND a.grantee LIKE 'anon\_%'
 GROUP BY c.relname, c.relrowsecurity
HAVING NOT c.relrowsecurity;
```
Jede Zeile im Ergebnis ist eine Tabelle, die `anon` erreichbar ist und **keine** RLS hat. Erwartet: leer. Rein lesend, damit **auch auf der Live-VPS zulässig** (Klasse 3) — das ist der einzige P0-DSGVO-Test dieses Berichts, der heute sofort ausführbar ist.

---

## 2.2 Verschlüsselung — reicht `age`? (Auftragspunkt 2.2)

**Kurzantwort: für den Zweck, für den sie da ist, ja. Als Gesamtantwort auf „Verschlüsselung at-rest und in-transit" nein — sie deckt nur einen von vier Wegen ab.**

| Ebene | Zustand | Bewertung | P |
|---|---|---|---|
| **Backups at-rest beim Dritten** | `age -r <pubkey>` → X25519 + ChaCha20-Poly1305 (`backup-script.sh` `encrypt_and_upload()`). Verschlüsselt **vor** dem Upload, Klartext wird gelöscht (`rm -f "$src"`) | **Angemessen nach Art. 32.** Backblaze kann nicht entschlüsseln | — |
| **Backups in-transit** | `rclone` → B2 über HTTPS (`api003.backblazeb2.com`, TLS) | ausreichend, zusätzlich zur age-Schicht | — |
| **Live-Daten at-rest auf der VPS** | **Keine Verschlüsselung.** Postgres-Volume, MinIO-Volume, `.env` (mit `ENCRYPTION_MASTER_KEY`, `MASTER_DB_PASSWORD`, allen API-Tokens), Klartext-Secrets in `admin_dashboard` | **Lücke.** Ob die Netcup-Festplatte auf Blockebene verschlüsselt ist, geht aus dem Repo nicht hervor → **OQ-S2** | **P1** |
| **Anwendungs-Traffic in-transit, extern** | Traefik terminiert TLS (Let's Encrypt, DNS-01 + HTTP-01). Cloudflare davor | in Ordnung | — |
| **Anwendungs-Traffic in-transit, intern** | **Alles Klartext:** PostgREST → PgBouncer → Postgres ohne `sslmode`, GoTrue → PgBouncer ohne TLS, Agent/CMS/Dashboard → MinIO über `http://core-minio:9000`, Traefik → App-Container über HTTP | Innerhalb eines Docker-Bridge-Netzes auf **einem** Host ist das vertretbar und gängig. **Aber:** es muss als bewusste Entscheidung in den TOM stehen, nicht als Versehen. Ein Angreifer mit Zugriff auf den Docker-Host oder auf `traefik-net` (z. B. über einen kompromittierten Kunden-App-Container) sieht Kundendaten und Passwörter im Klartext | **P1** |
| **Feldverschlüsselung in der DB** | `project_env_vars.value_encrypted`, `minio_secret_key_encrypted`, `cms_db_password_encrypted` — AES-256-GCM (`lib/crypto.ts`), CMS bewusst mit **eigenem** Schlüssel | gut durchdacht; die Trennung `CMS_ENCRYPTION_KEY` ≠ `ENCRYPTION_MASTER_KEY` ist eine echte Maßnahme | — |
| **Schlüsselverwahrung** | `backups/age-identity.txt`, `0600 root:root`, **auf derselben VPS** wie die Daten, im Verzeichnis, das der Agent `rw` gemountet hat | **Der eigentliche Schwachpunkt** — nicht der Algorithmus. Für den Schutz gegen Backblaze reicht es; für Wiederherstellung nach Totalverlust der VPS reicht es **nicht**. Existiert eine Off-Site-Kopie? → **OQ-S3** | **P0** |

**Zusammengefasst:** `age` ist die richtige Wahl und richtig eingesetzt. Die Frage „reicht sie aus?" wird aber falsch gestellt, wenn man sie auf Backups begrenzt — die Antwort lautet: sie deckt genau **einen** von vier Verschlüsselungswegen ab, und die beiden P0-/P1-Restrisiken (Schlüssel liegt neben den Daten; Live-Daten unverschlüsselt) liegen außerhalb ihres Zuständigkeitsbereichs.

**Testfälle:**

| ID | P | Testfall | Erwartet | Umg |
|---|---|---|---|---|
| D-13 | **P0** | `verify-backups.sh` als **geplanter** Lauf (nicht auf Zuruf): entschlüsselt eine Datei mit `BACKUP_AGE_IDENTITY_FILE` und prüft den Header | Erfolg. Ein falscher Key macht **jedes** Backup unbrauchbar, ohne dass irgendwo ein Fehler erscheint | PROD-safe |
| D-14 | **P0** | Restore-Test in Wegwerf-DB mit Zeilen-Counts vor/nach | Counts stimmen überein | PROD-safe (`POST /backups/restore-test`) |
| D-15 | P1 | Restore auf einer **fremden** Maschine, nur mit Off-Site-Kopie des age-Keys | Gelingt. Prüft OQ-S3 praktisch statt theoretisch | SBX |
| D-16 | P1 | `tcpdump`/`docker exec` in `traefik-net`: eine PostgREST→PgBouncer-Verbindung mitlesen | Klartext sichtbar — hält den Ist-Zustand fest, bis er in den TOM steht | SBX |

---

## 2.3 Löschkonzept (Auftragspunkt 2.3)

### Was heute gelöscht wird — vollständige Aufstellung

`DELETE /tenants/:slug` → `cleanupTenantResources()` (`index.ts:144-243`), in dieser Reihenfolge:

| # | Ressource | Mechanismus | Vollständig? |
|---|---|---|---|
| 1 | Projekte des Tenants: App-Container, Traefik-Router, Projekt-Netz, Images, Build-Cache, GitHub-Webhook, Kuma-Monitor | `cleanupProjectResources()` | ja |
| 2 | Tenant-Container (`api-`, `auth-`) | `docker compose down` | ja |
| 3 | `kunde_<slug>` (inkl. `auth.users`, `auth.sessions`, `auth.audit_log_entries`, allen Anwendungsdaten) | `pg_terminate_backend` + `DROP DATABASE` | ja |
| 4 | `authenticator_<slug>`, `cms_<slug>` | `DROP ROLE` | ja |
| 5 | MinIO-Bucket + Inhalt | `mc rb --force` | ja |
| 6 | MinIO-IAM-User + Policy | `mc admin user remove` / `policy remove` | ja |
| 7 | `kunden-instances/<slug>/` | `rm -rf` | ja |
| 8 | `projects`-Zeilen → kaskadiert auf `analytics_daily/_page_views/_referrers/_visitors`, `components`, `vulnerabilities` | `DELETE FROM projects` + `ON DELETE CASCADE` | ja |
| 9 | `kunden`-Zeile → kaskadiert auf `cms_collections` → `cms_fields`, `cms_users`, `cms_media` | `DELETE FROM kunden` + `ON DELETE CASCADE` | ja |

**Das ist erheblich vollständiger, als es der Prüfauftrag erwarten ließ.** Neun Ressourcenarten, kaskadierende FKs für die CMS- und Analytics-Ebene. Vier konkrete Restbestände bleiben:

### Befund D-01 (P0) — `cms_audit` bleibt vollständig zurück

`21_cms.sql:101` — `cms_audit` hat **keinen** Foreign Key auf `kunden(slug)`, anders als `cms_collections`, `cms_users` und `cms_media` (alle `ON DELETE CASCADE`). Die Tabelle enthält `user_email`, `user_id`, `ip`, `action`, `collection`, `row_pk`, `detail`.
**Folge:** Nach einer Tenant-Kündigung bleiben die E-Mail-Adressen und IP-Adressen aller Redakteure dieses Kunden dauerhaft in der Plattform-DB — und wandern in **jedes** nachfolgende Backup. Das ist ein direkter Verstoß gegen Art. 17 in der Umsetzung, nicht in der Absicht.
**Testfall D-01-T1 (P0, SBX):** Tenant mit ≥1 CMS-Redakteur und ≥1 Änderung anlegen → `DELETE /tenants/:slug` → `SELECT count(*) FROM cms_audit WHERE tenant_slug='<slug>'`. **Erwartet 0, tatsächlich > 0.**
**Empfehlung:** Entweder FK `ON DELETE CASCADE` ergänzen, oder — falls die Historie bewusst überleben soll (Nachweispflicht) — ein `UPDATE cms_audit SET user_email=NULL, ip=NULL, user_id=NULL WHERE tenant_slug=$1` in `cleanupTenantResources()`. Die zweite Variante behält den Nachweis und entfernt den Personenbezug. Welche gewollt ist, ist eine Entscheidung, keine technische Frage → **OQ-S4**.

### Befund D-03 (P1) — `audit_logs` hat weder FK noch Retention

Bereits als DS-03/DS-21 benannt; hier präzisiert: `lib/cleanup.ts` räumt vier `analytics_*`-Tabellen auf (`:210-213`), `audit_logs` steht **nicht** in der Liste. Die Tabelle wächst unbegrenzt und enthält `actor`, `ip_address`, `user_agent`, `meta`. Nach einer Tenant-Löschung bleiben alle Einträge mit `target = '<slug>'` stehen.
**Empfehlung:** Eine Frist festlegen (Vorschlag: 365 Tage — deckt die Nachweisdauer für Sicherheitsvorfälle ab) und in `cleanup.ts` in dieselbe Schleife aufnehmen. Der Code dafür ist eine Zeile in einem bestehenden Array.

### Befund D-17 (P1) — Backups: 3 Tage lokal, 14 Tage remote

`BACKUP_RETENTION_DAYS=3`, `BACKUP_REMOTE_RETENTION_DAYS=14` (`.env`, verifiziert). Nach einer Tenant-Löschung liegen die Daten also **bis zu 14 Tage** weiter in den age-verschlüsselten Dumps auf B2. Das ist DSGVO-konform (Löschung aus Backups darf zeitversetzt erfolgen), **muss aber als Frist dokumentiert und dem Kunden gegenüber genannt sein.** Es gibt heute kein Dokument, das diese Frist ausspricht.

### Befund D-02 (P0) — Access-Log: keine Löschfrist, gemessen

Der schwerste DSGVO-Befund. `TESTPLAN.md` DS-01 vermutete es, hier ist die Messung:

| Messwert | Ergebnis (2026-08-27) |
|---|---|
| Dateigröße | 11.763.807 Bytes, 11.388 Zeilen |
| Zeitraum | 2026-08-18T13:56 UTC bis 2026-08-27T13:10 UTC (**9 Tage**) |
| Zeilen mit echter Besucher-IP (`request_Cf-Connecting-Ip`) | **2.910** |
| Weitere Felder | `request_User-Agent`, `RequestHost`, `RequestPath`, `ClientHost` |
| `logrotate`-Regel | **keine** — `/etc/logrotate.d/` enthält nur `mt-backup` |
| Einzige Löschung | `lib/analytics.ts:291` `rotateIfNeeded()`: bei ≥ 200 MB `rename` → SIGUSR1 an Traefik → **`unlink`** |

**Die de-facto-Aufbewahrungsfrist ist damit größenabhängig, nicht zeitabhängig.** Bei der gemessenen Rate (11,7 MB / 9 Tage ≈ 1,3 MB/Tag) wird die 200-MB-Schwelle nach **rund 154 Tagen ≈ 5 Monaten** erreicht. Bis dahin liegen die IP-Adressen aller Besucher aller Kundenseiten unverschlüsselt auf der VPS. Wächst der Traffic, sinkt die Frist; sinkt der Traffic, steigt sie unbegrenzt. Eine Frist, die vom Besucheraufkommen abhängt, ist keine Frist im Sinne von Art. 5 Abs. 1 lit. e.

**Verschärfend:** Die Analytics-Pipeline **braucht** die Roh-IP nur flüchtig — `visitorHash()` verarbeitet sie sofort zu einem salted Hash. Die dauerhafte Klartext-Speicherung erfüllt keinen Zweck der Plattform; sie ist ein Nebenprodukt der Traefik-Konfiguration (`--accesslog.fields.headers.names.Cf-Connecting-Ip=keep`, `traefik/docker-compose.yml`).

**Testfall D-02-T1 (P0, PROD-safe, sofort ausführbar):**
```bash
python3 - <<'PY'
import json
first=last=None; n=ip=0
for line in open('traefik/logs/access.log'):
    try: d=json.loads(line)
    except: continue
    t=d.get('StartUTC') or d.get('time')
    first=first or t; last=t; n+=1
    if d.get('request_Cf-Connecting-Ip'): ip+=1
print(f"{n} Zeilen, {ip} mit Klartext-IP, {first} .. {last}")
PY
```
Erwartet **nach** einer Behebung: `0 mit Klartext-IP`, oder ein Zeitraum ≤ der festgelegten Frist.

**Empfehlung (Reihenfolge nach Wirkung):**
1. `logrotate`-Regel für `traefik/logs/access.log` mit `rotate 7 daily compress` — **löst die Fristfrage sofort und vollständig**, ~8 Zeilen in `/etc/logrotate.d/`. Achtung: `postrotate` muss SIGUSR1 an Traefik senden, sonst schreibt Traefik in die gelöschte Inode; und `analytics.ts` liest über eine Inode/Größen-Signatur, kommt mit dem Wechsel also zurecht (`analytics_ingest_state.file_signature`).
2. Alternativ oder zusätzlich `ANALYTICS_ROTATE_AT_BYTES` deutlich senken — schneller umzusetzen, behebt aber die **Zeit**-Unabhängigkeit nicht.
3. Die grundsätzlichere Lösung: prüfen, ob Traefik die IP pseudonymisiert loggen kann, oder ob die Analytics-Pipeline nahe genug am Request läuft, dass der Header gar nicht persistiert werden muss.

### Befund D-19 (P0) — Löschung pro **Person** existiert nicht

`TESTPLAN.md` DS-19 benennt es; hier die konkrete Konsequenz für die drei Betroffenenkategorien:

| Betroffener | Wo überall | Heute |
|---|---|---|
| **Redakteur** (Art. 17) | `cms_users`, `cms_audit.user_email/.user_id/.ip`, `cms_media.uploaded_by`, `audit_logs.meta`, Backups | Handarbeit per SQL, kein dokumentierter Ablauf |
| **Endnutzer eines Tenants** | `kunde_X.auth.users`, `.sessions.ip`, `.audit_log_entries.ip_address`, Anwendungstabellen des Kunden, Backups | Zuständigkeit des Kunden; der Betreiber muss ihn **unterstützen können** und braucht dafür einen Ablauf |
| **Website-Besucher** | `access.log` (Klartext-IP!), `analytics_visitors` (Hash, nach 90 Tagen weg) | Über den Hash ist keine gezielte Löschung möglich — das ist das gewollte Ergebnis der Pseudonymisierung. **Über `access.log` schon, und genau das ist D-02** |

**Empfehlung:** Kein Code. Ein Dokument (`docs/LOESCHKONZEPT.md`) mit **je Betroffenenkategorie** einer geprüften SQL-Sequenz und der genannten Backup-Frist. Das ist die Nachweispflicht aus Art. 5 Abs. 2 — der Ablauf muss existieren und belegbar sein, er muss nicht automatisiert sein.

### Löschkonzept-Testfälle

| ID | P | Testfall | Erwartet | Umg |
|---|---|---|---|---|
| **D-18** | **P0** | Vollausbau-Tenant anlegen (DB + GoTrue-Nutzer + CMS-Redakteur + Medien + Projekt + Analytics-Zeilen), dann `DELETE /tenants/:slug`, danach **jede** der neun Ressourcenarten einzeln prüfen | Alle neun leer. Der Pfad ist bewusst fehlertolerant und sammelt Warnungen statt abzubrechen — **eine unvollständige Löschung fällt deshalb nicht von selbst auf**, `warnings` muss Teil der Assertion sein | SBX |
| **D-01-T1** | **P0** | wie oben, Fokus `cms_audit` | erwartet 0, **tatsächlich > 0** | SBX |
| D-21 | P1 | nach D-18: `SELECT count(*) FROM audit_logs WHERE target='<slug>'` | > 0 — hält den bewussten Restbestand fest | SBX |
| D-17-T1 | P1 | `rclone lsl` auf den B2-Bucket, Dateialter prüfen | nichts älter als `BACKUP_REMOTE_RETENTION_DAYS` | PROD-safe |

---

## 2.4 Auskunftsrecht (Art. 15/20) — Machbarkeit (Auftragspunkt 2.4)

**Aktueller Stand: es existiert kein Export-Endpunkt, keine Export-Funktion und kein dokumentierter Ablauf.** Eine Suche über `*.ts`, `*.sql`, `*.sh` und `*.md` nach `dsgvo|gdpr|export|auskunft|art. 15|art. 20|anonymis` liefert **ausschließlich** Treffer in `TESTPLAN.md` selbst und einen Kommentar in `20_analytics.sql`. Es gibt im Repo keinerlei Umsetzung.

**Technisch ist ein Export gut machbar** — die Bausteine liegen vor:

| Ebene | Was schon da ist | Was fehlt |
|---|---|---|
| **Tenant-Vollexport** (Art. 20, Auftraggeber will seine Daten mitnehmen) | `pg_dump -Fc` je Tenant-DB läuft täglich im Backup; `mc mirror` für den Bucket wäre ein Einzeiler | Ein Endpunkt/Skript, das beides bündelt und übergibt. **Aufwand gering** |
| **Personenexport Redakteur** | Alle Tabellen bekannt (`cms_users`, `cms_audit`, `cms_media`) | Eine Query-Sequenz nach `email`. **Aufwand sehr gering** |
| **Personenexport Endnutzer** | `auth.users` je Tenant-DB | Die Anwendungstabellen des Kunden sind **schemaabhängig** — dafür gibt es keine generische Lösung, und es ist auch nicht die Zuständigkeit des Betreibers |
| **Besucher** | — | Nicht möglich und **nicht nötig**: `visitor_hash` ist ohne das Server-Salt nicht rückrechenbar, das Salt rotiert täglich. Art. 11 DSGVO (Verarbeitung ohne Identifizierung) greift. **Ausnahme: `access.log` — dort ist die IP im Klartext und damit sehr wohl auskunftspflichtig.** Ein weiteres Argument für D-02 |

**Empfehlung, kleinstmögliche Umsetzung:** Ein Skript `scripts/dsgvo-auskunft.sh <email>`, das die vier bekannten Plattformtabellen nach der Adresse durchsucht und das Ergebnis als JSON ausgibt. Kein Endpunkt, keine UI, kein Dashboard-Feature — ein Skript plus der Absatz in `docs/LOESCHKONZEPT.md`, der es benennt. Das erfüllt die Nachweispflicht; alles darüber hinaus ist Komfort für einen Fall, der bei zwei Kunden statistisch selten eintritt.

**Testfall D-20-T1 (P1, PROD-safe):** Eine bekannte Redakteurs-Adresse durch die vier Tabellen suchen, Trefferliste mit der Erwartung vergleichen. Belegt, dass der Ablauf tatsächlich alle Vorkommen findet — der eigentliche Punkt bei Art. 15 ist Vollständigkeit, nicht Format.

---

## 2.5 Drittanbieter-Datenfluss (Auftragspunkt 2.5)

### D-23 — Backblaze B2: **Region festgestellt** (beantwortet OQ-06)

`TESTPLAN.md` DS-23 vermerkte, die Region stehe nirgends in der Konfiguration und müsse an der B2-Konsole geprüft werden. **Das lässt sich ohne Konsole beantworten:** `rclone --config backups/rclone.conf lsd backblaze:up2-multitennant --dump headers` zeigt, an welchen API-Cluster rclone nach dem `b2_authorize_account`-Redirect spricht:

```
Host: api.backblazeb2.com      <- Authorize-Endpunkt, regionsneutral
Host: api003.backblazeb2.com   <- der Cluster des Buckets
```

Cluster **003** ist bei Backblaze `eu-central-003` (Amsterdam, Niederlande). **Der Bucket `up2-multitennant` liegt in der EU.** Das ist die entlastende Antwort auf einen der schwersten offenen Punkte.

**Was trotzdem gilt:** Backblaze Inc. ist ein US-Unternehmen. EU-Region bedeutet EU-**Speicherort**, nicht Ausschluss eines Zugriffs aus den USA (CLOUD Act). AVV + SCC bleiben nötig. **Doppelt entlastend:** Die Daten liegen dort ausschließlich age-verschlüsselt, der private Schlüssel verlässt die VPS nicht. Ein Zugriff durch Backblaze oder US-Behörden liefert Chiffrat. Damit ist B2 datenschutzrechtlich der **am besten abgesicherte** der fünf Drittanbieter.

**Empfehlung:** Die Feststellung dokumentieren (mit dem `api003`-Beleg) und `endpoint = s3.eu-central-003.backblazeb2.com` explizit in `rclone.conf` eintragen — heute hängt die Region allein an der Bucket-Erstellung. Wird der Bucket je neu angelegt, kann er unbemerkt in `us-west-###` landen.

**Nebenbefund D-23b (P3):** `backups/rclone.conf` enthält ein zweites, defektes Remote `[hetzner]` (`type = sftp`, `host = cd /opt/multitenant-platform`, leerer `user`). Offensichtlich ein verunglückter `rclone config`-Lauf. Unbenutzt (`RCLONE_REMOTE_PATH=backblaze:…`), aber es enthält ein Passwort und sollte entfernt werden.

### D-24 — Cloudflare: der eigentliche Drittlandtransfer

**Umfang, präzisiert:** Nicht nur Backups, sondern **jeder einzelne Request jeder Kundenseite** plus die gesamte Admin-Sitzung. Was Cloudflare dabei sieht:

| Weg | Daten bei Cloudflare |
|---|---|
| Besucher → Kundenseite (Proxy) | Vollständiger Klartext-Request: IP, User-Agent, URL, Cookies, **POST-Bodies von Kontaktformularen** (bei `up2-site`: Name, E-Mail, Telefon, Nachricht). TLS wird an der Edge terminiert |
| Admin → Dashboard (Zero-Trust-Tunnel) | Sitzungsdaten, alle im Dashboard sichtbaren Kundendaten, **die im SQL-Editor angezeigten Zeilen** |
| DNS | Auflösungsanfragen aller Plattform-Domains |
| ACME DNS-01 | `CF_DNS_API_TOKEN` — Kontrolle über die DNS-Zone |

**Das ist ein größerer Transfer als B2, und im Gegensatz zu B2 ist er unverschlüsselt aus Sicht des Anbieters.** Die age-Argumentation greift hier nicht.

**Zu klären (unverändert offen, aus dem Repo nicht beantwortbar):**
- AVV mit Cloudflare abgeschlossen? SCC eingebunden?
- Ist die **EU Data Localization Suite** aktiv (kostenpflichtig)? Ohne sie terminieren EU-Besucher an beliebigen Edge-Standorten weltweit.
- Ist **Cloudflare Access** auf dem Tunnel aktiv? → identisch mit **OQ-S1** aus Teil 1; die Frage entscheidet gleichzeitig über die Priorität von S-09
- Steht Cloudflare in der Datenschutzerklärung **jeder** Kundenseite?

**Empfehlung:** Diese vier Fragen sind mit vier Klicks in der Cloudflare-Konsole beantwortbar und blockieren mehrere P0-Einträge in Teil 1 und Teil 2 gleichzeitig. Das ist der wirksamste einzelne nächste Schritt des ganzen Berichts.

### D-25 — Resend

US-Anbieter. Betrifft **alle** Tenants gemeinsam: `GOTRUE_SMTP_PASS` ist der plattformweite `RESEND_API_KEY` (`tenant-compose.yml`), ebenso die Backup-Alarme (`backup-script.sh` `send_alert()`). Übertragen werden E-Mail-Adressen der Endnutzer und Mailinhalte (Bestätigungs-/Passwort-Links). Die Spalte `resend_api_key_encrypted` je Tenant existiert, wird aber **nicht** benutzt — eine Trennung je Kunde wäre also vorbereitet. AVV prüfen. **P0**, unverändert gegenüber `TESTPLAN.md`.

### D-26 bis D-28 — unverändert

Netcup (DE/EU, AVV nach Art. 28 sollte vorliegen, P1) · GitHub (nur bei Kundendaten im Repo — **konkreter Hinweis:** `up2web-schema.sql` und `dashboard/up2site-data.sql` liegen ungetrackt im Working Tree, vor jedem Commit prüfen, P1) · GoDaddy (nur bei Nutzung, P2).

### Neu: D-30 — freier Egress der Kunden-Apps

`app-<slug>-net` ist bewusst nicht `internal`. Eine Kunden-App kann beliebige Drittdienste kontaktieren (Google Fonts, Analytics, Zahlungsdienste) — jeder davon ist ein Datenfluss, den der Betreiber **nicht kontrolliert, aber mitverantwortet**, sobald er im AVV als Auftragsverarbeiter auftritt. **Empfehlung:** Im Onboarding ansprechen und im AVV eine Mitwirkungspflicht des Kunden vorsehen. Kein technischer Fix — ein `internal`-Netz würde die Apps funktionsunfähig machen. **P2**

---

## 2.6 Priorisierte Lückenliste Teil 2

| ID | P | Lücke | Empfehlung | Aufwand |
|---|---|---|---|---|
| **D-02** | **P0** | Access-Log: 2.910 Klartext-IPs, **keine** zeitbasierte Löschfrist (de facto ~5 Monate, größenabhängig) | `logrotate`-Regel, `rotate 7 daily`, `postrotate` mit SIGUSR1 | ~8 Zeilen |
| **D-01** | **P0** | `cms_audit` überlebt die Tenant-Löschung mit E-Mail + IP vollständig (kein FK) | FK `ON DELETE CASCADE` **oder** Anonymisierung im Cleanup → OQ-S4 | 1 Migration |
| **D-19** | **P0** | Kein Löschverfahren pro Person, für keine der drei Betroffenenkategorien | `docs/LOESCHKONZEPT.md` mit geprüfter SQL-Sequenz je Kategorie | Dokument |
| **D-11** | **P0** | age-Schlüssel liegt auf derselben VPS wie die Daten → OQ-S3 | Off-Site-Kopie anlegen, Ort und Zugriffsberechtigte dokumentieren, D-15 einmal durchspielen | Prozess |
| **D-24** | **P0** | Cloudflare: Umfang des Transfers ungeklärt (AVV, SCC, Data Localization, Access) | Vier Fragen in der Konsole klären. **Blockiert auch S-09** | Recherche |
| **D-25** | **P0** | Resend: AVV; plattformweiter Key betrifft alle Tenants | AVV prüfen; `resend_api_key_encrypted` je Tenant aktivieren | Recherche + klein |
| **D-31/32** | **P0** | AVV Betreiber↔Kunde und mit allen Unterauftragsverarbeitern | Liste aus §2.5 als Anlage zum AVV | Vertrag |
| **D-10** | **P0** | Keine Prüfung, ob eine Tenant-Tabelle `anon`-`GRANT` **ohne** RLS hat | Query aus §2.1 als CI-Test **und** als PROD-safe-Lauf. **Sofort ausführbar** | ~15 Zeilen |
| **D-18** | **P0** | Vollständigkeit der Tenant-Löschung nie geprüft (Pfad schluckt Fehler in `warnings`) | Testfall D-18 in `scripts/ci/integration/` | mittel |
| **D-23** | ~~P0~~ **erledigt** | B2-Region | **`eu-central-003` (Amsterdam) festgestellt.** `endpoint` explizit in `rclone.conf` eintragen | erledigt + 1 Zeile |
| **D-09** | P1 | `client_public`: `anon` hat SELECT+UPDATE auf alle Zeilen/Spalten (Kundenschema) | Mit dem Kunden klären; `GRANT UPDATE (visited_at)` statt `GRANT UPDATE` | Kundenentscheidung |
| **D-03** | P1 | `audit_logs` ohne Retention und ohne FK | Frist festlegen (Vorschlag 365 Tage), in `cleanup.ts`-Array aufnehmen | 1 Zeile |
| **D-12/D-16** | P1 | Live-Daten unverschlüsselt at-rest; interner Traffic unverschlüsselt | OQ-S2 klären (Festplattenverschlüsselung), beides in die TOM aufnehmen | Dokument |
| **D-17** | P1 | Backup-Frist (3/14 Tage) nirgends als Löschfrist dokumentiert | In AVV und Löschkonzept aufnehmen | Dokument |
| **D-07** | P1 | GoTrue speichert IPs (`auth.sessions.ip`, `auth.audit_log_entries.ip_address`) — **verifiziert**, aktuell 0 Zeilen bei `up2-site` | Frist festlegen, bevor der erste Tenant GoTrue produktiv nutzt | Dokument |
| **D-20** | P1 | Kein Auskunftsverfahren | `scripts/dsgvo-auskunft.sh <email>` über vier Tabellen | ~30 Zeilen |
| **D-33/34/35** | P1 | Art.-30-Verzeichnis, TOM-Dokumentation, Art.-33-Meldeprozess | §2.1 dieses Berichts ist die Vorlage für Art. 30 | Dokumente |
| **D-05** | P2 | `cms_audit.user_id` ohne FK → verwaiste, zuordenbare ID nach Redakteurslöschung | mit D-01 gemeinsam lösen | — |
| **D-06** | P2 | `kunden.notes` ist ein Freitextfeld ohne Zweckbindung | Verwendung prüfen | — |
| **D-09b** | P2 | PDFs im `public/`-Präfix behalten ihre Metadaten (Bilder werden rekodiert, EXIF gestrippt) | Bucket-Inhalt sichten; ggf. PDF-Metadaten strippen | klein |
| **D-30** | P2 | Freier Egress der Kunden-Apps | Im Onboarding/AVV ansprechen | Prozess |
| **D-23b** | P3 | Defektes, ungenutztes `[hetzner]`-Remote mit Passwort in `rclone.conf` | entfernen | 1 Zeile |

---

## 3. Offene Fragen (zu entscheiden, nicht zu testen)

| ID | Frage | Blockiert |
|---|---|---|
| **OQ-S1** | Ist **Cloudflare Access** auf dem Zero-Trust-Tunnel aktiv? | Priorität von **S-09** (P1 vs. P0), Teil von D-24 |
| **OQ-S2** | Ist die Netcup-VPS-Festplatte auf Blockebene verschlüsselt? | D-12, TOM |
| **OQ-S3** | Existiert eine Off-Site-Kopie von `backups/age-identity.txt`, und wo? | **D-11 (P0)** |
| **OQ-S4** | Soll `cms_audit` bei Tenant-Löschung **gelöscht** oder **anonymisiert** werden (Nachweispflicht vs. Art. 17)? | **D-01 (P0)** |
| **OQ-S5** | Sollen `service_role`-Schlüssel ein `exp` bekommen, oder bleibt die Supabase-Konvention? | S-08 |
| **OQ-S6** | Werden CMS-Rollen (`editor`/`admin`) durchgesetzt, oder ist die Spalte ungenutzt? | S-13 |
| **OQ-S7** | Welche Aufbewahrungsfristen gelten für `audit_logs`, `access.log` und GoTrue-IPs? | D-02, D-03, D-07 |
| **OQ-06** | ~~B2-Region~~ | **beantwortet: `eu-central-003` (Amsterdam, EU)** |

---

## 4. Empfohlene Reihenfolge

Nach **Wirkung pro Aufwand**, nicht nach Priorität allein.

**Sofort, ohne neue Infrastruktur (Stunden):**
1. **D-02** — `logrotate`-Regel für `access.log`. Schwerster DSGVO-Befund, kleinster Fix im Bericht.
2. **D-10** — RLS-/GRANT-Bestandsprüfung als PROD-safe-Query über alle Tenant-DBs. Rein lesend, sofort ausführbar.
3. **D-24 / OQ-S1** — vier Fragen in der Cloudflare-Konsole. Löst gleichzeitig einen P0 in Teil 1 und einen in Teil 2.
4. **OQ-S3** — Off-Site-Kopie des age-Keys. Prozessfrage, keine Codefrage, aber P0.
5. **S-07** — CMS-Routen-Struktur-Test, ~20 Zeilen in einer bestehenden Datei.
6. **D-23** — `endpoint` in `rclone.conf` eintragen, `[hetzner]`-Remote entfernen.

**Kurzfristig (Tage):**
7. **B-1** — Pipeline auf GitHub laufen lassen. Alles Weitere in Teil 1 hängt daran.
8. **S-09** — `rateLimit.ts` in `dashboard/src/auth.ts` einsetzen, unabhängig vom Ausgang von OQ-S1.
9. **D-01 / OQ-S4** — `cms_audit` entscheiden und migrieren.
10. **D-03** — `audit_logs`-Frist festlegen und in `cleanup.ts` aufnehmen.

**Mittelfristig (Wochen):**
11. **S-05** — MinIO nach `lib/minio.ts` herauslösen, dann die P0-Negativtests S-05/S-05b.
12. **D-18 / D-01-T1** — Löschvollständigkeits-Test.
13. **S-06** — Parallelitätstest gegen den CI-Stack.
14. **D-19 / D-20** — `docs/LOESCHKONZEPT.md` und `scripts/dsgvo-auskunft.sh`.
15. **S-04** — Netz-Isolation, braucht Traefik im CI-Stack.

**Vertraglich, parallel:** D-31/D-32 (AVV), D-33 (Art. 30 — §2.1 dieses Berichts als Vorlage), D-34 (TOM), D-35 (Art.-33-Meldeprozess).

---

## 5. Was in diesem Schritt **nicht** getan wurde

- **Keine Behebung.** Kein Code, kein Schema, keine Konfiguration wurde geändert. Einzige neue Datei ist dieser Bericht.
- **Keine aktiven Zugriffstests gegen echte Kundenprojekte.** Die drei Klasse-3-Prüfungen aus §0.3 waren ausschließlich lesend auf Schema- und Metadatenebene; es wurden keine Kundendaten-Inhalte gelesen.
- **Kein isolierter Test-Tenant gestartet.** `assert-not-production.sh` verbietet das auf dieser Maschine zu Recht (Blocker B-1).
- **Keine Secrets im Bericht.** Der einzige externe Aufruf war ein `rclone`-Verzeichnislisting gegen den eigenen B2-Bucket, ausgewertet wurde daraus allein der API-Hostname.
