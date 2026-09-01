# TESTPLAN

**Stand:** 2026-08-26 · **Branch:** `claude/backup-prozedur-main-1ibs2q` · **Basis-Commit:** `0b0d3bb`
**Grundlage:** `ANALYSE_1.md` (Ist-Analyse, Risiko) und `REPO-REVIEW.md` (Projekt-Contract).
**Zweck:** schriftlicher Plan. **Es wird in diesem Schritt nichts ausgeführt**, keine Testsuite angelegt, keine CI/CD-Konfiguration geändert.

---

## 0. Rahmen — was wo überhaupt getestet werden darf

Der Plan ist wertlos, wenn nicht bei jedem Testfall steht, **wo** er laufen darf. Es gibt eine Live-VPS mit echten Kunden (`sofre`, `up2-site`), kein Staging. Aus `ANALYSE_1.md` §7 ergeben sich drei Umgebungen; jeder Testfall unten trägt eine davon:

| Tag | Umgebung | Was dort erlaubt ist |
|---|---|---|
| **CI** | GitHub-Runner, nur Quellcode, kein Docker-Stack der Plattform | Unit-Tests, statische Struktur-Tests, Lint/Typecheck. Läuft heute schon (`.github/workflows/ci.yml`), nur ohne Test-Job. |
| **SBX** | isolierte Zweitumgebung (zweite VPS, lokales Compose oder Docker-in-Docker) — **existiert noch nicht** | Alles Destruktive: Provisioning, Rollback, Löschen, Restore, Deploy-Concurrency, Last. |
| **PROD-safe** | Live-VPS, ausschließlich Klasse-3-Aktionen (`ANALYSE_1.md` §4.2) | Lesende Routen, `/health`, `/stats/*`, `/audit-logs`, `POST /backups/restore-test` (Wegwerf-DB), `verify-backups.sh` ohne `--with-restore-test`, Konfigurations-Inspektion. |

> **Blocker OQ-09:** Ohne SBX sind die meisten P0-Fälle dieses Plans **nicht ausführbar**. Das ist keine Testplan-Frage, sondern eine Infrastrukturentscheidung, die vor der Automatisierung fallen muss. Die Priorisierung in §4 ist so gebaut, dass die CI-fähige Stufe 1 ohne SBX startbar ist.

### 0.1 Korrekturen an den Auftragsannahmen

Übernommen aus `ANALYSE_1.md` §0, hier nur soweit sie den Zuschnitt ändern:

- **CI existiert bereits** (Typecheck/Lint/Build für drei Node-Dienste). Was fehlt, ist ein *Test*-Job — es gibt keine Testsuite, kein Test-Script in einer der drei `package.json`, keine Test-Devdependency.
- **Monitoring existiert teilweise** (Uptime Kuma 2.4.0, Kuma-Monitore je Projekt, Resend-Alarme, CVE-Inventar). Ungescrapte Traefik-Prometheus-Metriken sind der offene Teil.
- **Es gibt keine Billing-Logik.** Der Auftrag nennt „Billing/Tarif-Logik" als Feature. Im Repo existiert kein Rechnungswesen, keine Zahlungsanbindung, kein Kontingent und keine Feature-Gate-Logik. Der Tarif (`starter|business|premium`) steuert **ausschließlich** RAM-/CPU-Limits (`lib/deploy.ts:31-39`, `lib/tenantDatabase.ts:52-56`). Getestet wird deshalb unter F14 die *Limit-Zuordnung*, nicht eine Abrechnung. Siehe OQ-10.
- **Nicht der Tarif entscheidet über DB/Auth**, sondern `kunden.db_enabled` / `db_provisioned` (Migration 19), unabhängig vom Tarif. Das vervielfacht die Testmatrix (§F14).

### 0.2 Werkzeuge (Festlegung, damit die Testfälle konkret sind)

- **Unit/Integration:** `node --test` aus der Standardbibliothek (Node 20 ist bereits die CI-Version). Kein Jest, kein Vitest — für Assertions über reine Funktionen und HTTP-Aufrufe gegen laufende Container fügt ein Framework nichts hinzu, was `node:test` + `node:assert` + `fetch` nicht schon können. Coverage über `node --experimental-test-coverage`.
- **E2E:** dieselbe Mechanik gegen die SBX-Umgebung, plus `docker`/`psql`/`mc` als Prüfmittel. Ein Browser-Runner (Playwright) wird **nur** für die zwei UI-Flüsse (Dashboard-Login, CMS-Redaktion) gebraucht; alles andere ist HTTP.
- **Last:** in diesem Plan nur benannt (§2, Kategorie L). Werkzeugwahl gehört in den späteren Lasttest-Prompt.

---

## 1. Feature-Inventar

Zwanzig testbare Einheiten. „Funktioniert korrekt" ist jeweils so formuliert, dass daraus ein Testfall ableitbar ist — nicht als Absichtserklärung.

| ID | Feature | „Funktioniert korrekt" heißt | Hauptcodestelle |
|---|---|---|---|
| **F01** | **Traefik-Routing & TLS** | Jede aktive Domain löst auf den richtigen Container auf, liefert ein gültiges Zertifikat (DNS-01 für Plattform-Subdomains, HTTP-01 für Custom-Domains), und `global-traefik` hängt in **jedem** `app-<slug>-net`. Ein Router zeigt nie auf einen fremden Tenant. | `traefik/`, `lib/traefikDynamic.ts`, `reattachProjectNetworks()` |
| **F02** | **Tenant-Provisioning** | `POST /tenants` erzeugt DB, Rollen, Schema `auth`, GoTrue, PostgREST, MinIO-Bucket+IAM, Compose-Datei und DB-Zeile — **oder** hinterlässt bei Fehlschlag nichts Halbes. Ein zweiter paralleler Request bekommt `409` und **löscht den ersten Tenant nicht**. | `index.ts:262-420`, `lib/tenantDatabase.ts` |
| **F03** | **Tenant-Isolation (DB + Rollen)** | `authenticator_<A>` kann sich **nicht** mit `kunde_<B>` verbinden; die Rollen `anon_/authenticated_/service_role_<A>` existieren nur in A und haben keinerlei Rechte in B. `REVOKE ALL ... FROM PUBLIC` ist auf jeder Tenant-DB gesetzt. | `tenantDatabase.ts:120-165`, `authenticator-role.sql.template` |
| **F04** | **PgBouncer-Auth** | Jeder `authenticator_<slug>` authentifiziert sich über `AUTH_QUERY` gegen `pgbouncer_auth.user_lookup` als **er selbst** — niemals still gemappt auf `postgres`. Ein falsches Passwort wird abgelehnt, nicht durchgereicht. | `18_pgbouncer_auth.sql`, `core-postgres/docker-compose.yml` |
| **F05** | **PostgREST-Datenzugriff** | Anon-Key sieht genau das, was RLS+GRANT freigeben; ein Token mit fremdem `role`-Claim scheitert; Schema-Reload nach DDL greift; nur Schema `public` ist sichtbar. | `templates/tenant-compose.yml`, `routes/tenants.ts:44` |
| **F06** | **GoTrue je Tenant** | Login/Refresh/Logout funktionieren gegen `auth-<slug>:9999`; ausgestelltes JWT trägt `role=authenticated_<slug>`; Self-Signup ist aus; das JWT eines Tenants wird von PostgREST eines anderen Tenants abgelehnt. | `templates/tenant-compose.yml`, `lib/jwt.ts` |
| **F07** | **MinIO-Storage** | Ein Tenant-IAM-User kann ausschließlich in `kunde-<slug>-storage` lesen/schreiben; `public/` ist anonym lesbar, alles andere 403; Bucket wird auch ohne DB angelegt. | `index.ts:346-373`, `cms/src/lib/media.ts` |
| **F08** | **Deployment (Nixpacks + Blue-Green)** | Build ≤10 min, Healthcheck <500 in ≤60 s, Swap tauscht Container ohne dauerhafte Downtime, fehlgeschlagener Deploy rollt auf den alten Container zurück, Build-Zeit-Denylist hält Secrets aus dem Image. | `lib/deploy.ts`, `lib/nixpacks.ts` |
| **F09** | **GitHub-Webhook** | HMAC-SHA256 über den **rohen** Body; nur `push` auf `default_branch`; `423` bei `suspended`; falsche Signatur → `401`, kein Deploy. | `routes/webhooks.ts` |
| **F10** | **Domains & ACME** | Preview-Domain wird automatisch vergeben, Custom-Domain erst nach Verifikation geroutet, `primary` steuert Redirects, Löschen entfernt den Router vollständig. | `routes/domains.ts`, `lib/dns.ts` |
| **F11** | **Admin-Zugang** | Dashboard nur über Cloudflare-Tunnel erreichbar; **jede** API-Route ruft `auth()`; Agent akzeptiert nur korrektes `X-Agent-Secret` (zeitkonstant); `/health` + `/webhooks/*` bleiben ohne Secret erreichbar. | `dashboard/src/auth.ts`, `dashboard/src/middleware.ts`, `index.ts` |
| **F12** | **SQL-/Table-Editor** | Läuft als Superuser (bewusst), aber mit `statement_timeout=30s`, Zeilenlimit 1000, `readOnly` als Default; nach DDL folgt automatisch der PostgREST-Reload; jede Ausführung landet im Audit-Log. | `dashboard/src/lib/tenantDb.ts:227-280` |
| **F13** | **CMS** | Der Tenant kommt **nur** aus der Session, nie aus der URL; gelöschte/gesperrte Redakteure verlieren die Session sofort; Uploads werden nach WebP rekodiert, EXIF gestrippt, SVG abgelehnt; Quota greift. | `cms/src/lib/session.ts`, `cms/src/lib/media.ts` |
| **F14** | **Tarif & Feature-Flags** | Tarif → korrekte `--memory`/`--cpus` bei Deploy **und** Rollback; `db_enabled=false` unterdrückt genau die DB-/Auth-Env-Vars; `suspended` stoppt Container und entfernt Router; `db_provisioned` wird nie wieder false. | `lib/deploy.ts:31-39`, `lib/secrets.ts:98-140`, `routes/tenants.ts` |
| **F15** | **Backup & Restore** | Täglich 03:00 laufen Globals + alle DBs + MinIO + Config, age-verschlüsselt, nach B2; jeder Fehlschlag alarmiert; ein Dump lässt sich entschlüsseln und mit **korrekten Zeilen-Counts** einspielen. | `backups/backup-script.sh`, `restore-test-script.sh`, `verify-backups.sh` |
| **F16** | **Analytics** | Accesslog wird ohne Doppel- und Lückenzählung eingelesen (Inode/Offset-Signatur); gespeichert werden **nur** Aggregate und ein täglich rotierender Besucher-Hash — keine IP, kein User-Agent. | `lib/analytics.ts`, `20_analytics.sql` |
| **F17** | **Monitoring & Alarm** | Uptime Kuma hat je Projekt einen Monitor; Ausfall und Backup-Fehlschlag lösen eine Resend-Mail aus; Versionsinventar erkennt CVE-relevante Stände. | `lib/monitoring.ts`, `lib/alert.ts`, `lib/inventory.ts` |
| **F18** | **Cleanup & Retention** | Täglicher Lauf löscht Build-Snapshots, prunt Images (behält 5) und wendet Analytics-Retention an — **ohne** ein Image zu entfernen, das noch von einem laufenden Container oder einem Rollback-Ziel gebraucht wird. | `lib/cleanup.ts`, `lib/projectCleanup.ts` |
| **F19** | **Audit-Log** | Login (Erfolg+Fehlschlag), SQL-Editor, Tabellen-Edits, Backups, Tenant-Aktionen landen mit echtem Actor, IP und User-Agent in `audit_logs`; Secrets erscheinen dort maskiert. | `lib/audit.ts` (Agent + Dashboard), `06_/16_*.sql` |
| **F20** | **Rate-Limiting** | Traefik bremst pro echter Besucher-IP (`Cf-Connecting-Ip`), nicht pro Cloudflare-Edge-IP; CMS-Login hat eine Bremse; der Agent limitiert schreibende Routen. | `traefik/dynamic/`, `cms/src/lib/rateLimit.ts`, `index.ts` |

---

## 2. Testkategorien pro Feature

Legende: **U** Unit · **I** Integration · **E** E2E · **S** Security/Zugriff · **L** Last (nur benannt, Ausführung in einem späteren Prompt).
Spalte **Umg** = Umgebung nach §0. Spalte **P** = Priorität, begründet gesammelt in §4.

### F01 — Traefik-Routing & TLS

| ID | Art | Umg | Testfall | Erwartet | P |
|---|---|---|---|---|---|
| TC-ROUTE-01 | I | SBX | Traefik `--force-recreate`, danach Kundenseite abrufen | Nach Agent-Start ist die Seite wieder erreichbar (`reattachProjectNetworks()` repariert die Netzanbindung) — der in `ANALYSE_1.md` §1.4 benannte fragile Punkt | P0 |
| TC-ROUTE-02 | S | SBX | Router von Tenant A mit `Host:`-Header von Tenant B aufrufen | Kein Cross-Routing; Antwort kommt nie aus dem fremden Container | P0 |
| TC-ROUTE-03 | I | PROD-safe | Für jede Domain in `preview_domains`/`domains` prüfen, ob ein Traefik-Router existiert und das Zertifikat >14 Tage gültig ist | Keine verwaiste Domain, kein ablaufendes Zertifikat | P1 |
| TC-ROUTE-04 | U | CI | `traefikDynamic.ts`: Router-/Middleware-YAML für einen gegebenen Projektzustand erzeugen | Erzeugte Datei enthält genau die erwarteten Router, keine Fremd-Hosts, valides YAML | P2 |
| TC-ROUTE-05 | L | SBX | *(nur benannt)* Viele gleichzeitige TLS-Handshakes über viele Hosts | Szenario für den Lasttest-Prompt | P3 |

### F02 — Tenant-Provisioning

| ID | Art | Umg | Testfall | Erwartet | P |
|---|---|---|---|---|---|
| TC-PROV-01 | I | SBX | **Deploy-/Provisioning-Concurrency:** zwei gleichzeitige `POST /tenants` mit demselben Slug | Request 2 bekommt `409` aus dem Advisory Lock; Tenant aus Request 1 bleibt **vollständig** erhalten (DB, Rollen, Bucket, Verzeichnis, Zeile) | P0 |
| TC-PROV-02 | I | SBX | Provisioning künstlich **nach** `CREATE DATABASE` scheitern lassen (z.B. MinIO nicht erreichbar) | Rollback entfernt **alles** Angelegte; kein Restbestand in `pg_database`, `pg_roles`, MinIO, `kunden-instances/` | P0 |
| TC-PROV-03 | S | SBX | Fehler erzeugen, dessen Meldung **nicht** `already exists` enthält, obwohl der Tenant existiert (z.B. `mc`-Fehler) | Der Guard darf nicht in den destruktiven Pfad fallen. **Dieser Test ist der wichtigste des ganzen Plans** — beide Schutzschichten hängen an `/already exists/i`-String-Matching (`ANALYSE_1.md` §4.3) | P0 |
| TC-PROV-04 | E | SBX | Vollständiges Anlegen eines Tenants mit DB, danach Smoke: `api-<slug>` antwortet, `auth-<slug>/health` antwortet, Bucket existiert, Compose-Datei ist geschrieben | Alle sechs Ressourcen vorhanden und konsistent zur DB-Zeile | P0 |
| TC-PROV-05 | I | SBX | Tenant **ohne** DB anlegen (`withDatabase:false`) | Kein `api-`/`auth-`-Container, **aber** Bucket, JWT-Secret und Authenticator-Passwort existieren (für späteres Nachprovisionieren) | P1 |
| TC-PROV-06 | U | CI | Slug-Validierung `/^[a-z0-9-]+$/` gegen Grenzfälle: leer, `A`, `a_b`, `a.b`, `../x`, 200 Zeichen, führender/abschließender Bindestrich | Alle ungültigen Werte abgelehnt, bevor irgendeine Ressource entsteht | P1 |
| TC-PROV-07 | E | SBX | Tenant löschen (`DELETE /tenants/:slug`) und danach jede der neun Ressourcenarten prüfen | Nichts bleibt zurück; die gesammelten Warnungen des fehlertoleranten Pfades werden als Ergebnis sichtbar, nicht verschluckt | P1 |

### F03 — Tenant-Isolation (DB + Rollen)

Die vier Isolationsebenen aus `ANALYSE_1.md` §2. Jede braucht **mindestens einen Negativtest** — ein Positivtest beweist hier nichts.

| ID | Art | Umg | Testfall | Erwartet | P |
|---|---|---|---|---|---|
| TC-ISO-01 | S | SBX | **Ebene 1:** Als `authenticator_A` direkt auf `kunde_B` verbinden | `permission denied for database` — beweist, dass `REVOKE ALL ON DATABASE ... FROM PUBLIC` gesetzt ist | P0 |
| TC-ISO-02 | S | SBX | **Ebene 2:** In `kunde_B` prüfen, welche Rechte `anon_A`/`service_role_A` haben | Rollen existieren dort nicht oder haben null Rechte; kein `GRANT` quer über Tenants | P0 |
| TC-ISO-03 | S | SBX | **Ebene 3:** Mit `authenticator_A` und **falschem** Passwort über PgBouncer verbinden | Ablehnung. Ein Erfolg würde bedeuten, dass die `AUTH_QUERY` still auf `postgres` mappt — der gefährlichste Einzelfehler der Plattform | P0 |
| TC-ISO-04 | S | SBX | **Ebene 4:** Aus `app-A` heraus `api-B:3000`, `pgbouncer:5432` und `docker-socket-proxy` erreichen | Alle drei nicht auflösbar/nicht erreichbar; nur Egress ins Internet funktioniert | P0 |
| TC-ISO-05 | S | SBX | Anon-JWT von Tenant A gegen `api-B` senden | `401`/`JWSError` — Secrets sind je Tenant verschieden | P0 |
| TC-ISO-06 | I | PROD-safe | Bestandsprüfung über alle vorhandenen Tenants: für jede `kunde_*`-DB `datacl` und Rollenmitgliedschaften auflisten | Keine DB mit `PUBLIC CONNECT`, kein Authenticator mit Fremdrollen — rein lesend, deshalb auch auf der Live-VPS zulässig | P0 |
| TC-ISO-07 | S | SBX | Alt-Rollen: prüfen, ob `GRANT ... TO service_role` (clusterweit, `BYPASSRLS`) in einer Tenant-DB noch Wirkung entfaltet | Siehe **OQ-03** — Sollverhalten ist nicht entschieden | P1 |

### F04 — PgBouncer-Auth

| ID | Art | Umg | Testfall | Erwartet | P |
|---|---|---|---|---|---|
| TC-POOL-01 | I | SBX | Über PgBouncer als `authenticator_<slug>` verbinden und `SELECT current_user` | Gibt `authenticator_<slug>` zurück, **nicht** `postgres` | P0 |
| TC-POOL-02 | I | SBX | Prepared Statement über PgBouncer absetzen | Scheitert erwartungsgemäß (Transaction-Mode) — sichert die Begründung für `PGRST_DB_PREPARED_STATEMENTS=false` ab | P2 |
| TC-POOL-03 | I | SBX | Mehr gleichzeitige Verbindungen anfordern als `DEFAULT_POOL_SIZE` | Warteschlange statt Fehler, bis `QUERY_WAIT_TIMEOUT=15s` greift | P2 |
| TC-POOL-04 | L | SBX | *(nur benannt)* Ausschöpfung von `max_connections=60` über mehrere Tenants gleichzeitig | Szenario für den Lasttest-Prompt — das Budget gilt für **alle** Tenants zusammen | P1 |

### F05 — PostgREST-Datenzugriff

| ID | Art | Umg | Testfall | Erwartet | P |
|---|---|---|---|---|---|
| TC-REST-01 | S | SBX | Tabelle **ohne** RLS-Policy bei aktivem `postgrest_public_enabled` mit Anon-Key lesen und schreiben | Dokumentiert das reale Risiko aus `ANALYSE_1.md` §2: derzeit voller Zugriff. Test hält den Zustand fest, bis entschieden ist, ob die Plattform RLS erzwingt (**OQ-13**) | P0 |
| TC-REST-02 | I | SBX | Tabelle **mit** RLS: Zugriff als `anon_<slug>` vs. `authenticated_<slug>` | Genau die von der Policy erlaubten Zeilen, nicht mehr | P0 |
| TC-REST-03 | I | SBX | DDL über den SQL-Editor, danach sofort dieselbe Tabelle über die API abfragen | Kein `PGRST205` — der automatische `SIGUSR1`-Reload hat gegriffen | P1 |
| TC-REST-04 | S | SBX | Tabelle in einem Nicht-`public`-Schema anlegen und über die API abfragen | Unsichtbar (`PGRST_DB_SCHEMA=public`) | P2 |
| TC-REST-05 | U | CI | `lib/jwt.ts` `signTenantJwt()`: erzeugtes Token gegen erwartete Claims prüfen | `role=<kind>_<slug>`, `iss=multitenant-platform`, HS256, **kein** `exp`/`aud` — festgehalten als bewusste Eigenschaft, damit eine spätere Änderung auffällt | P1 |
| TC-REST-06 | L | SBX | *(nur benannt)* Dauerlast auf `api-<slug>` bei `PGRST_DB_POOL=5` | Szenario für den Lasttest-Prompt | P2 |

### F06 — GoTrue je Tenant

| ID | Art | Umg | Testfall | Erwartet | P |
|---|---|---|---|---|---|
| TC-AUTH-01 | E | SBX | Nutzer per Admin-API anlegen → Login → Token → PostgREST-Abfrage → Logout | Kompletter Kette funktioniert; Token trägt `role=authenticated_<slug>` | P0 |
| TC-AUTH-02 | S | SBX | Self-Signup über `/signup` versuchen | Abgelehnt (`GOTRUE_DISABLE_SIGNUP=true`) | P1 |
| TC-AUTH-03 | S | SBX | Token mit manipuliertem `role`-Claim (`service_role_<fremd>`) an PostgREST | Abgelehnt — Signaturprüfung schlägt fehl, kein `SET ROLE` | P0 |
| TC-AUTH-04 | I | SBX | `POST /tenants/:slug/rotate-secret`, danach altes Token verwenden | Altes Token sofort ungültig, neue Keys funktionieren — inklusive der Nebenwirkung, dass hartkodierte Kundenkeys brechen | P1 |
| TC-AUTH-05 | I | SBX | Provisioning **ohne** gesetztes `RESEND_API_KEY` | Warnung wird ausgegeben; der Zustand „niemand kann sich registrieren" ist erkennbar, nicht still | P2 |

### F07 — MinIO-Storage

| ID | Art | Umg | Testfall | Erwartet | P |
|---|---|---|---|---|---|
| TC-STOR-01 | S | SBX | Mit den IAM-Credentials von Tenant A auf `kunde-B-storage` lesen/schreiben/listen | `AccessDenied` für alle vier Aktionen — die Policy deckt nur die zwei eigenen ARNs ab | P0 |
| TC-STOR-02 | S | SBX | Objekt außerhalb von `public/` anonym über die Media-URL abrufen | `403` | P0 |
| TC-STOR-03 | I | SBX | Objekt unter `public/` anonym abrufen, nachdem das CMS aktiviert wurde | `200` — `publishTenantMediaPrefix()` hat gegriffen | P1 |
| TC-STOR-04 | I | SBX | Tenant **ohne** DB anlegen | Bucket + IAM-User existieren trotzdem | P2 |
| TC-STOR-05 | U | CI | `media.ts`: Dateityp-Whitelist gegen JPEG/PNG/WebP/AVIF/GIF/PDF/**SVG**/`.exe`/leere Datei/falscher MIME bei echtem Bildinhalt | SVG und alles Unbekannte abgelehnt; Prüfung am Inhalt, nicht an der Endung | P0 |
| TC-STOR-06 | U | CI | `media.ts`: Rekodierung — EXIF-GPS-Tag im Quellbild, Kantenlänge >2400 px | Ausgabe ist WebP, ohne EXIF, ≤2400 px | P1 |
| TC-STOR-07 | S | SBX | Zwei gleichzeitige Uploads dicht unter dem Quota-Limit | Bekannter Befund: beide gehen durch (nicht atomar). Test hält den Zustand fest — Fix ist eine Produktentscheidung | P2 |

### F08 — Deployment (Nixpacks + Blue-Green)

| ID | Art | Umg | Testfall | Erwartet | P |
|---|---|---|---|---|---|
| TC-DEPL-01 | S | CI | `nixpacks.ts`: Build-Zeit-Env-Filter gegen `NEXT_PUBLIC_X`, `MY_TOKEN`, `STRIPE_KEY`, `API_CREDENTIAL`, `JWT_SECRET`, `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PUBLIC_KEY` | Denylist-Werte erscheinen **nie** im Build-Kontext; `NEXT_PUBLIC_*` immer. Reine Stringlogik, extrem billig zu testen, schützt Secrets vor dem Einbacken ins Image | P0 |
| TC-DEPL-02 | E | SBX | Minimal-Repo deployen: Build → Healthcheck → Swap → Abruf über die Preview-Domain | Seite antwortet mit dem neuen Stand; alter Container ist umbenannt, nicht gelöscht | P0 |
| TC-DEPL-03 | I | SBX | Deploy mit App, deren Healthpfad `500` liefert | Rollback auf den alten Container innerhalb der 60-s-Grenze; Kundenseite bleibt/wird wieder erreichbar | P0 |
| TC-DEPL-04 | I | SBX | Deploy einer App, die auf `127.0.0.1` statt `0.0.0.0` lauscht | Healthcheck scheitert mit verständlicher Meldung (`buildErrorHints.ts`), nicht mit einem Timeout ohne Ursache | P1 |
| TC-DEPL-05 | I | SBX | Rollback auf ein Deployment, dessen Image `pruneOldDockerImages()` bereits entfernt hat | Klarer Fehler statt halbem Swap; laufender Container bleibt unangetastet | P1 |
| TC-DEPL-06 | U | CI | `buildErrorHints.ts` gegen echte Fehlerausgaben (fehlendes `build`-Script, OOM, Timeout, fehlende Node-Version) | Jeder Fall liefert den passenden Hinweis, unbekannte Fehler den Rohtext | P2 |
| TC-DEPL-07 | I | SBX | Zwei gleichzeitige Deploys für dasselbe Projekt | Kein doppelter Swap, kein verwaister Container | P1 |
| TC-DEPL-08 | L | SBX | *(nur benannt)* Nixpacks-Build unter Speicherdruck | Szenario für den Lasttest-Prompt. **Auf der Live-VPS verboten**: ein Build fordert 1–2 GB, der OOM-Killer nimmt typischerweise Postgres — also die DB aller Kunden | P0 |

### F09 — GitHub-Webhook

| ID | Art | Umg | Testfall | Erwartet | P |
|---|---|---|---|---|---|
| TC-HOOK-01 | S | CI/SBX | Webhook mit falscher Signatur, mit fehlendem Header, mit gültiger Signatur über **umformatiertem** JSON-Body | Nur der unveränderte Rohbody mit korrekter Signatur wird akzeptiert; Umformatierung bricht die Signatur (beweist `express.raw()`) | P0 |
| TC-HOOK-02 | S | SBX | Gültiger Webhook auf einen `suspended` Tenant | `423`, kein Deploy | P1 |
| TC-HOOK-03 | I | SBX | Push auf einen Nicht-Default-Branch, `ping`-Event, `pull_request`-Event | Kein Deploy, sauberer `200`/`204` | P1 |
| TC-HOOK-04 | S | SBX | Webhook-Secret von Projekt A gegen Endpunkt von Projekt B | Abgelehnt | P0 |

### F10 — Domains & ACME

| ID | Art | Umg | Testfall | Erwartet | P |
|---|---|---|---|---|---|
| TC-DOM-01 | E | SBX | Custom-Domain hinzufügen → Verifikation → Router → Zertifikat → Abruf | Vor bestandener Verifikation kein Router; danach erreichbar mit gültigem Zertifikat | P1 |
| TC-DOM-02 | S | SBX | Domain anlegen, die bereits einem anderen Projekt gehört | Abgelehnt — kein Hijacking über die Domain-Route | P0 |
| TC-DOM-03 | U | CI | `lib/dns.ts`: Hostname-Validierung (Wildcards, Unicode/Punycode, überlange Labels, IP als Host) | Ungültiges wird abgelehnt, bevor ein Router entsteht | P1 |
| TC-DOM-04 | I | SBX | `DELETE /domains/:id` | Router und dynamische Konfiguration vollständig entfernt, keine Karteileiche in `traefik/dynamic/` | P2 |

### F11 — Admin-Zugang (Dashboard, Agent-Secret)

| ID | Art | Umg | Testfall | Erwartet | P |
|---|---|---|---|---|---|
| TC-ADM-01 | S | CI | **Struktur-Test:** jede Datei unter `dashboard/src/app/api/**/route.ts` enthält einen `auth()`-Guard; erlaubte Ausnahme nur `api/auth/[...nextauth]` | Schließt die in `ANALYSE_1.md` A5 benannte Lücke: heute korrekt, aber nichts erzwingt es für **neue** Routen. Reiner Dateiscan, läuft in Sekunden, braucht keinen Stack | P0 |
| TC-ADM-02 | S | SBX | Agent-Route ohne, mit falschem und mit fast richtigem `X-Agent-Secret` aufrufen | `401`; Antwortzeit unabhängig vom Präfix (zeitkonstanter Vergleich) | P0 |
| TC-ADM-03 | S | SBX | `/health` und `POST /webhooks/github/:id` ohne Secret | Erreichbar — sie stehen bewusst vor der Middleware | P1 |
| TC-ADM-04 | S | PROD-safe | Prüfen, dass `admin-dashboard` nur auf `127.0.0.1:3000` lauscht und keinen Traefik-Router hat | Kein öffentlicher Zugang außer über den Cloudflare-Tunnel | P0 |
| TC-ADM-05 | U | CI | Passwortprüfung gegen `ADMIN_PASSWORD_HASH`: richtiges Passwort, falsches, leeres, fehlender Hash in der Umgebung | Fehlender Hash führt zu Ablehnung, **nie** zu einem Login ohne Prüfung | P0 |
| TC-ADM-06 | E | SBX | Login-Flow im Browser inkl. Fehlversuch | Fehlversuch erzeugt `auth.login_failure` mit Grund, IP, User-Agent | P2 |

### F12 — SQL-/Table-Editor

| ID | Art | Umg | Testfall | Erwartet | P |
|---|---|---|---|---|---|
| TC-SQL-01 | S | SBX | Query gegen `kunde_B` über den Editor von Tenant A absetzen (Slug in URL manipulieren) | Verbindung geht nur zur DB des adressierten Tenants; kein Cross-Tenant-Zugriff über den Parameter | P0 |
| TC-SQL-02 | I | SBX | `SELECT pg_sleep(60)` und `SELECT * FROM großetabelle` | Abbruch nach 30 s; Ausgabe auf 1000 Zeilen begrenzt (kein OOM im Dashboard) | P1 |
| TC-SQL-03 | I | SBX | Schreibendes Statement bei `readOnly=true` | Abgelehnt | P1 |
| TC-SQL-04 | I | SBX | DDL absetzen | Automatischer `postgrest/reload` folgt; Audit-Eintrag mit dem ausgeführten SQL existiert | P1 |
| TC-SQL-05 | I | SBX | Table-Editor auf einer Tabelle **ohne** PK und auf einer mit **zusammengesetztem** PK | `ctid`-Fallback greift; zusammengesetzter PK ist der offene Punkt **P1-2** → siehe **OQ-02**, Sollverhalten nicht entschieden | P1 |
| TC-SQL-06 | S | SBX | Query mit Postgres-Fehler auslösen | Fehlermeldung enthält keine Rohdetails, die Interna preisgeben (Befund aus dem zweiten Audit-Durchgang) | P2 |

### F13 — CMS

| ID | Art | Umg | Testfall | Erwartet | P |
|---|---|---|---|---|---|
| TC-CMS-01 | S | SBX | Als Redakteur von Tenant A eine URL mit Slug von Tenant B aufrufen — für **jede** CMS-Route | `requireSession(tenantSlug)` liefert `null` → kein Zugriff. Das ist die einzige Stelle, an der die Mandantengrenze des CMS hängt; sie braucht Abdeckung über alle Routen, nicht über eine | P0 |
| TC-CMS-02 | S | SBX | Redakteur mitten in der Session löschen bzw. `disabled=true` setzen, dann weiterklicken | Nächster Request scheitert sofort (DB-Revalidierung), nicht erst nach 8 h | P0 |
| TC-CMS-03 | S | SBX | Prüfen, mit welcher Rolle das CMS verbindet und ob es eine nicht freigegebene Tabelle lesen kann | Verbindet als `cms_<slug>`, **nicht** als Superuser; nicht freigegebene Tabellen sind unzugänglich | P0 |
| TC-CMS-04 | S | SBX | Login mit falschem Passwort in Serie | Bremse greift (`rateLimit.ts`), bcrypt-DoS ausgeschlossen; `locked_until` wird gesetzt | P1 |
| TC-CMS-05 | U | CI | `rows.ts`/Feldvalidierung: optionales Feld mit Wert **außerhalb** der Grenzen, Pflichtfeld leer, falscher Typ | Grenzen greifen auch bei optionalen Feldern (Befund aus dem zweiten Audit-Durchgang) | P1 |
| TC-CMS-06 | U | CI | `rateLimit.ts`: Schlüsselbildung aus `cf-connecting-ip`, aus erstem `x-forwarded-for`, ohne beides | Kein Schlüssel `undefined`, unter dem alle Clients zusammenfallen | P1 |
| TC-CMS-07 | E | SBX | Redaktionsfluss: Login → Collection → Eintrag anlegen → Bild hochladen → veröffentlichen → auf der Kundenseite sichtbar | Inhalt und Bild erscheinen unter der öffentlichen URL | P1 |
| TC-CMS-08 | S | CI | Sanitizing von Redaktionsinhalten (`sanitize-html`): `<script>`, `onerror=`, `javascript:`-URL | Wird entfernt, nicht escaped-durchgereicht | P1 |

### F14 — Tarif & Feature-Flags

| ID | Art | Umg | Testfall | Erwartet | P |
|---|---|---|---|---|---|
| TC-TAR-01 | U | CI | `TARIFF_LIMITS`-Zuordnung für `starter`/`business`/`premium`/`unbekannt`/`undefined`/`""` | starter 512m/0.5 · business 512m/1 · premium 1g/2 · alles Unbekannte fällt auf `starter`; `--pids-limit 512` immer | P1 |
| TC-TAR-02 | I | SBX | Deploy und danach **Rollback** für einen Premium-Tenant | Beide Container tragen dieselben Limits; ein zwischenzeitliches Downgrade wirkt bewusst auch auf den alten Stand | P2 |
| TC-TAR-03 | I | SBX | Tenant-Dienste mit **fehlender** `PREMIUM_POSTGREST_MEM` in der Umgebung | Fallback ist `64m`/`0.25` — ein Tippfehler in der `.env` degradiert einen Premium-Tenant still. Test macht die stille Degradierung sichtbar | P1 |
| TC-TAR-04 | U | CI | `buildEnvVars()` für die fünf Betriebskombinationen aus `ANALYSE_1.md` §5.4 | Bei `db_enabled=false` **keine** der Variablen `GOTRUE_URL`, `JWT_SECRET`, `POSTGREST_URL`, `SUPABASE_*`; `MINIO_*` und `S3_BUCKET_NAME` immer; `NEXT_PUBLIC_SUPABASE_*` nur bei `postgrest_public_enabled` **und** gesetzter `PLATFORM_DOMAIN` | P0 |
| TC-TAR-05 | I | SBX | Tenant auf `suspended` setzen, dann Kundenseite, Webhook und **manuelles** `POST /deployments` versuchen | Seite offline, Webhook `423`. Verhalten des manuellen Deploys ist **nicht definiert** → **OQ-01** | P1 |
| TC-TAR-06 | I | SBX | `db_enabled` aus- und wieder einschalten | Beim Ausschalten `compose down`, DB bleibt, `db_provisioned` bleibt `true`; beim Einschalten nur `up -d`, dieselben Secrets, kein Neu-Provisioning | P1 |
| TC-TAR-07 | I | SBX | CMS-Aktivierung auf einem Tenant ohne `db_provisioned` | `409` bzw. leere Tabellenliste, kein halb angelegter CMS-Zustand | P2 |

### F15 — Backup & Restore

| ID | Art | Umg | Testfall | Erwartet | P |
|---|---|---|---|---|---|
| TC-BKP-01 | E | PROD-safe | `restore-test-script.sh` auf den jüngsten Dump jeder DB anwenden | Entschlüsselung erfolgreich, Einspielen in die Wegwerf-DB erfolgreich, **Zeilen-Counts** je Tabelle >0 und plausibel (Audit §9). Arbeitet in `<db>_restoretest`, fasst Produktivdaten nicht an | P0 |
| TC-BKP-02 | E | SBX | **Restore auf einer fremden Maschine** allein aus Remote-Dateien + age-Key | Der einzige echte Beweis, dass die Backups im Ernstfall benutzbar sind. Heute laut `verify-backups.sh` explizit **nicht** abgedeckt und Handarbeit | P0 |
| TC-BKP-03 | I | PROD-safe | `verify-backups.sh` (Stufe 0–3, rein lesend) als geplanter Lauf statt als Handgriff | Falscher age-Key, fehlende Kategorie, veraltete Datei werden erkannt, bevor sie im Ernstfall auffallen | P0 |
| TC-BKP-04 | I | SBX | Backup-Lauf mit künstlich scheiternder Einzel-DB | Die übrigen DBs werden weiterhin gesichert, genau **eine** Alarmmail geht raus, `backups`-Zeile trägt den Fehlerstatus | P0 |
| TC-BKP-05 | I | SBX | Backup-Lauf ohne `RESEND_API_KEY`/`ADMIN_EMAIL` | Lauf bricht nicht ab, protokolliert aber, dass kein Alarm möglich war | P2 |
| TC-BKP-06 | I | SBX | Restore prüfen, dass **Globals zuerst** eingespielt werden | Ohne `pg_dumpall --globals-only` scheitert jedes `OWNER TO authenticator_<slug>`; Test sichert die Reihenfolge ab | P0 |
| TC-BKP-07 | I | PROD-safe | Retention prüfen: lokal `BACKUP_RETENTION_DAYS=3`, remote `BACKUP_REMOTE_RETENTION_DAYS=14` | Ältere Dateien sind weg, jüngere da — Grundlage für die DSGVO-Löschfrist in §3 | P1 |

### F16 — Analytics

| ID | Art | Umg | Testfall | Erwartet | P |
|---|---|---|---|---|---|
| TC-ANA-01 | U | CI | `visitorHash()`: gleicher Besucher am selben Tag vs. am Folgetag | Innerhalb eines Tages gleich, tagesübergreifend verschieden (rotierendes Salt). **Der Test, der die Pseudonymisierungszusage aus `20_analytics.sql` absichert** | P0 |
| TC-ANA-02 | U | CI | Log-Zeile mit Query-String, überlangem Pfad, vollem Referrer-Pfad | Query-String abgeschnitten, Pfad gekappt, nur Referrer-Herkunft (Schema+Host) gespeichert | P0 |
| TC-ANA-03 | I | SBX | Ingest zweimal über dieselbe Datei laufen lassen; danach Datei rotieren (neuer Inode) und truncaten | Keine Doppelzählung, keine Lücke — Offset/Signatur greifen | P1 |
| TC-ANA-04 | U | CI | Kaputte/halbe JSON-Zeile im Accesslog | Zeile wird übersprungen, Lauf bricht nicht ab | P2 |
| TC-ANA-05 | S | SBX | In `analytics_*` nach IP-artigen und User-Agent-artigen Werten suchen | Keine Treffer — der Test hält die Datenschutzzusage nachprüfbar | P0 |

### F17 — Monitoring & Alarm

| ID | Art | Umg | Testfall | Erwartet | P |
|---|---|---|---|---|---|
| TC-MON-01 | I | SBX | Projekt anlegen und wieder löschen | Kuma-Monitor entsteht und verschwindet mit; keine verwaisten Monitore | P2 |
| TC-MON-02 | I | SBX | Container eines Projekts stoppen | Kuma erkennt den Ausfall, Alarmmail geht raus | P1 |
| TC-MON-03 | U | CI | `inventory.ts`: Versionsvergleich gegen bekannte CVE-Stände, inkl. Grenzfälle (`v2.4.0` vs `2.4.0`, Datums-Tags, `latest`) | Keine falsch-negative Bewertung; `latest` wird als „nicht bewertbar" markiert, nicht als „sicher" | P1 |
| TC-MON-04 | I | PROD-safe | `GET /security/components` gegen die tatsächlich laufenden Images abgleichen | Inventar deckt sich mit `docker ps`; keine unbemerkte Komponente | P2 |

### F18 — Cleanup & Retention

| ID | Art | Umg | Testfall | Erwartet | P |
|---|---|---|---|---|---|
| TC-CLN-01 | I | SBX | Cleanup-Lauf, während ein Container läuft und ein Rollback-Ziel existiert | Weder das laufende noch die letzten 5 Images werden entfernt. **Ein Fehler hier macht Rollbacks unmöglich** (vgl. TC-DEPL-05) | P0 |
| TC-CLN-02 | I | SBX | Agent neu starten und 5 Minuten warten | Der automatische Cleanup läuft und ist destruktiv — Test macht die Nebenwirkung explizit, die jeden Agent-Neustart begleitet | P1 |
| TC-CLN-03 | U | CI | Retention-Grenzen: Datensätze exakt auf, knapp über und knapp unter der Grenze (90/180/730 Tage) | Off-by-one-frei; Tagessummen überleben die Löschung der Besucher-Hashes | P1 |
| TC-CLN-04 | I | SBX | Zwei Cleanup-Läufe gleichzeitig | Kein doppeltes Löschen, kein Fehlerabbruch | P3 |

### F19 — Audit-Log

| ID | Art | Umg | Testfall | Erwartet | P |
|---|---|---|---|---|---|
| TC-AUD-01 | S | SBX | Für jede schreibende Agent- und Dashboard-Route prüfen, ob ein Audit-Eintrag entsteht | Lücke = eine Aktion, die im Nachhinein niemand nachvollziehen kann | P1 |
| TC-AUD-02 | S | CI | `maskSecrets()` mit JWT, Authenticator-Passwort, MinIO-Key, `.env`-artigem Text | Kein Secret erscheint im Log, auch nicht teilweise | P0 |
| TC-AUD-03 | I | SBX | Login-Erfolg und -Fehlschlag | Beide protokolliert, mit Grund, echter IP und User-Agent (nicht `admin`/leer) | P1 |
| TC-AUD-04 | S | SBX | Agent-Aufruf mit gefälschtem `X-Actor`-Header | Der Wert landet im Log — bekannter Befund (A6). Test dokumentiert, dass der Actor nur so vertrauenswürdig ist wie das Agent-Secret | P2 |

### F20 — Rate-Limiting

| ID | Art | Umg | Testfall | Erwartet | P |
|---|---|---|---|---|---|
| TC-RATE-01 | L | SBX | *(nur benannt)* 600 Requests **über die echte Cloudflare-Kette** gegen eine Kundendomain | Der wertvollste Test der Plattform und zugleich der gefährlichste: nur so zeigt sich, ob `Cf-Connecting-Ip` wirklich greift oder ob Traefik alle Besucher als eine Edge-IP sieht. Gehört in den Lasttest-Prompt und **niemals** auf die Live-VPS ohne Vorbereitung | P0 |
| TC-RATE-02 | S | SBX | CMS-Login-Serie von einer IP | Bremse greift; parallele Anfragen von anderer IP bleiben unbeeinflusst | P1 |
| TC-RATE-03 | S | SBX | Schreibende Agent-Routen in Serie mit **wechselndem** `X-Actor` | Limit wird umgangen — bekannter Befund (A6), Test hält ihn fest | P2 |
| TC-RATE-04 | L | SBX | *(nur benannt)* Gleichzeitige Last auf mehrere Tenants (Postgres-Verbindungsbudget, RAM) | Szenario für den Lasttest-Prompt; hängt an TC-POOL-04 | P1 |

---

## 3. DSGVO-relevante Prüfpunkte

Vorbemerkung zur Rollenverteilung, weil sie über jeden einzelnen Punkt entscheidet: Für die **Plattformdaten** (Kundenstamm, Redakteure, Zugriffslogs) ist der Betreiber **Verantwortlicher**. Für die **Tenant-Anwendungsdaten** (alles in `kunde_<slug>.public.*` und im Bucket) ist er **Auftragsverarbeiter** seiner Kunden. Ob das so festgelegt und vertraglich abgebildet ist, geht aus dem Repo nicht hervor → **OQ-07**.

### 3.1 Wo personenbezogene Daten liegen

| # | Ort | Daten | Bewertung / Prüfauftrag | P |
|---|---|---|---|---|
| DS-01 | **`traefik/logs/access.log`** | Echte Besucher-IP (`Cf-Connecting-Ip` wird bewusst mitgeschrieben), User-Agent, Referer, Hostname, Pfad — pro Request, im Klartext | **Schwerster Befund dieses Abschnitts.** Die Datei liegt bei ~11 MB und reicht bis zum 18.08.2026 zurück; in `/etc/logrotate.d/` existiert **nur** `mt-backup`, keine Regel für dieses Log, und Traefik ist ohne Rotationsgrenze konfiguriert. Es gibt damit **keine Löschfrist** (Art. 5 Abs. 1 lit. e). Die Datei liegt nicht im Config-Backup, wächst aber unbegrenzt auf der VPS. **Prüfen:** Ist die Speicherung der Roh-IP nötig? Die Analytics-Pipeline braucht sie nur flüchtig zum Hashen | **P0** |
| DS-02 | `analytics_daily`, `_page_views`, `_referrers`, `_visitors` | Nur Aggregate + `visitor_hash` (salted, Salt rotiert täglich) | Sauber gelöst und im Schema begründet. **Prüfen** ist trotzdem: (a) rotiert das Salt wirklich täglich (TC-ANA-01), (b) landet nirgends doch eine IP (TC-ANA-05), (c) sind 90/180/730 Tage die gewollten Fristen und dokumentiert | P1 |
| DS-03 | `audit_logs.ip_address`, `.user_agent`, `.actor`, `.meta` | IP + User-Agent des Admins, dazu Aktionsdetails | **Keine Retention.** `lib/cleanup.ts` räumt Analytics auf, `audit_logs` nicht. Bei einem Ein-Personen-Betrieb sind das die eigenen Daten, die Aufbewahrung ist als Sicherheitsprotokoll begründbar — aber eine Frist muss **festgelegt** sein → **OQ-08**. Zusätzlich prüfen, dass `meta` keine Klartext-Secrets enthält (TC-AUD-02) | P1 |
| DS-04 | `cms_users` | E-Mail, bcrypt-Hash, Anzeigename, `last_login_at`, `failed_logins`, `locked_until` | Personenbezogene Beschäftigtendaten der Kunden. **Prüfen:** Löschung beim Entfernen eines Redakteurs (harte Zeile weg oder nur `disabled=true`?), Löschung bei Tenant-Löschung (FK `ON DELETE CASCADE` auf `kunden.slug` — greift), Verbleib in Backups | P1 |
| DS-05 | `cms_audit`, `cms_media.uploaded_by`, `.original_name` | Wer hat wann was geändert/hochgeladen; Originaldateiname kann Namen enthalten | `cms_media.uploaded_by` ist `ON DELETE SET NULL` — gut. `cms_audit.user_id` hat **keinen** FK; prüfen, ob dort nach Löschung eines Redakteurs eine verwaiste, zuordenbare ID bleibt | P2 |
| DS-06 | `kunden.contact_email`, `.display_name`, `.notes` | Kontaktdaten der Auftraggeber | Vertrags-/Bestandsdaten. **`notes` ist ein Freitextfeld** — dort kann alles landen. Prüfen, ob es in der Praxis personenbezogene Angaben enthält, und ob das gewollt ist | P2 |
| DS-07 | `auth.users` je Tenant-DB (GoTrue) | E-Mail, Passwort-Hash, Bestätigungs-Token, `last_sign_in_at`; GoTrue führt zusätzlich `auth.audit_log_entries` | Endnutzer der Kunden → Betreiber ist Auftragsverarbeiter. **Prüfen:** ob `auth.audit_log_entries` IPs speichert (GoTrue tut das je nach Version) und ob dafür eine Frist existiert. Aus dem Repo nicht belegbar, muss an der laufenden Instanz nachgesehen werden | **P0** |
| DS-08 | `kunde_<slug>.public.*` | Alles, was das Kundenschema mitbringt — im Referenzfall `up2-site` u.a. Newsletter- und Kontaktdaten | Fremdverantwortet. **Prüfen:** dass die Plattform keine Kopien anlegt (tut sie nur im Backup) und dass der SQL-/Table-Editor-Zugriff als Superuser (A3/A4) im AVV abgebildet ist — der Betreiber kann technisch jede Kundendatenbank vollständig lesen | **P0** |
| DS-09 | MinIO `kunde-<slug>-storage` | Hochgeladene Dateien; `public/` ist **anonym lesbar** | **Prüfen:** dass keine personenbezogenen Dateien nach `public/` gelangen (Bewerbungen, Ausweise, Rechnungen). Entlastend: Bilder werden zwangsweise rekodiert und EXIF (inkl. GPS) gestrippt; PDFs jedoch **nicht** — ein PDF behält seine Metadaten und geht unverändert in den Bucket | **P0** |
| DS-10 | `backups/files/*.age` + B2-Bucket `up2-multitennant` | Vollständige Kopie von allem oben | age-verschlüsselt (X25519 + ChaCha20-Poly1305) — als technische Maßnahme nach Art. 32 tragfähig. **Aber:** siehe DS-11/DS-12 | **P0** |
| DS-11 | `backups/age-identity.txt` (privater Schlüssel, `0600`) | — | Liegt auf **derselben** VPS wie die Daten und in einem Verzeichnis, das der Provisioning-Agent `rw` gemountet hat. Für den Schutz des Off-Site-Backups reicht das (der B2-Betreiber kann nicht entschlüsseln); für die Wiederherstellbarkeit nach Totalverlust der VPS reicht es **nicht**. **Prüfen:** existiert eine Off-Site-Kopie des Schlüssels, und wo | **P0** |
| DS-12 | Postgres-Volume, MinIO-Volume, `.env` | — | Keine Verschlüsselung im Ruhezustand auf der VPS selbst; `.env` enthält `ENCRYPTION_MASTER_KEY`, `MASTER_DB_PASSWORD`, alle API-Tokens im Klartext. Dazu die bekannten Klartext-Secrets in `admin_dashboard` (A1: `gotrue_jwt_secret`, `authenticator_password`, `webhook_secret`). **Prüfen:** ob die VPS-Festplatte verschlüsselt ist und ob das in den TOM dokumentiert ist | P1 |

### 3.2 Reicht die age-Verschlüsselung?

Kurz: **für den Transport- und Ruhezustand beim Dritten ja, als Gesamtantwort nein.**

| # | Prüfpunkt | P |
|---|---|---|
| DS-13 | Verfahren: `age -r <public key>` → X25519 + ChaCha20-Poly1305. Zeitgemäß, keine Beanstandung | — |
| DS-14 | **Schlüsselverwahrung** ist der schwache Punkt, nicht der Algorithmus (DS-11). Prüfen: Off-Site-Kopie, Zugriffsberechtigte, Rotationsverfahren, was bei Verlust passiert | P0 |
| DS-15 | **Ein falscher age-Key macht jedes Backup unbrauchbar, ohne dass irgendwo ein Fehler erscheint** — genau deshalb ist das Stufe 0 in `verify-backups.sh`. Der Test muss regelmäßig laufen, nicht auf Zuruf (TC-BKP-03) | P0 |
| DS-16 | Verschlüsselung deckt **nur** die Backup-Dateien ab, nicht die Live-Daten auf der VPS (DS-12) | P1 |
| DS-17 | Löschung im Backup: nach einer Tenant-Löschung bleiben die Daten lokal bis zu 3 und remote bis zu **14 Tage** in den Dumps. Das ist zulässig, muss aber als Frist **dokumentiert** und dem Kunden gegenüber genannt sein | P1 |

### 3.3 Lösch- und Auskunftsfunktionen

| # | Prüfpunkt | Befund aus der Analyse | P |
|---|---|---|---|
| DS-18 | **Löschung pro Tenant** | Existiert: `DELETE /tenants/:slug` löscht DB, Rollen, Bucket, IAM-User, Policy, Verzeichnis, Container, Monitore, DB-Zeilen. **Zu prüfen:** vollständig? (TC-PROV-07) — der Pfad ist bewusst fehlertolerant und sammelt Warnungen, statt abzubrechen; eine unvollständige Löschung fällt deshalb nicht von selbst auf | **P0** |
| DS-19 | **Löschung pro Person** | **Existiert nicht.** Es gibt keine Funktion „lösche alle Daten zu Person X" — weder für einen Redakteur (`cms_users` + `cms_audit` + `cms_media.uploaded_by`) noch für einen Endnutzer eines Tenants (`auth.users` + Anwendungstabellen). Praktisch heißt das: Handarbeit per SQL. Prüfauftrag: dokumentierte Vorgehensweise je Betroffenenkategorie | **P0** |
| DS-20 | **Auskunft (Art. 15)** | **Kein Export-Endpunkt.** Für Tenant-Daten ist der Kunde zuständig, aber der Betreiber muss ihn unterstützen können. Prüfauftrag: gibt es einen belegten Weg, zu einer E-Mail-Adresse alle Vorkommen über `cms_users`, `auth.users`, `cms_audit`, `audit_logs` und die Kundentabellen zu finden | P1 |
| DS-21 | **Resteffekte nach Löschung** | `analytics_*` hängt per `ON DELETE CASCADE` an `projects` → wird mitgelöscht. **`audit_logs` nicht** (kein FK) → Einträge zu einem gelöschten Tenant bleiben. Ebenso bleiben Einträge im `access.log` (DS-01) und in den Backups (DS-17). Prüfen und als bewusste Entscheidung festhalten | P1 |
| DS-22 | **Berichtigung** | Über Dashboard/CMS möglich. Kein eigener Prüfbedarf über TC-CMS-* hinaus | P3 |

### 3.4 Verlassen Daten die EU?

| # | Dienst | Rolle | Prüfauftrag | P |
|---|---|---|---|---|
| DS-23 | **Backblaze B2** (`RCLONE_REMOTE_PATH=backblaze:up2-multitennant`) | Alle Backups | **Die Region steht nirgends in der Konfiguration** — `backups/rclone.conf` enthält für das B2-Remote nur `account` und `key`, keinen `endpoint`. Die Region hängt am Bucket (`eu-central-003` vs. `us-west-###`) und **muss an der B2-Konsole geprüft werden** → **OQ-06**. Backblaze ist ein US-Unternehmen: auch bei EU-Region bleiben AVV + SCC nötig, weil ein Zugriff aus den USA nicht ausgeschlossen ist. Entlastend: die Daten liegen dort ausschließlich age-verschlüsselt, der Schlüssel verlässt die VPS nicht | **P0** |
| DS-24 | **Cloudflare** (Proxy, DNS, Zero-Trust-Tunnel) | **Jeder** Request aller Kundenseiten läuft durch Cloudflare, inklusive der Admin-Sitzung durch den Tunnel | Drittlandtransfer im laufenden Betrieb, nicht nur im Backup. Prüfen: AVV abgeschlossen? SCC? Ist die *EU Data Localization Suite* aktiv (kostenpflichtig) oder terminieren EU-Besucher an beliebigen Edge-Standorten? Muss in der Datenschutzerklärung der Kundenseiten stehen | **P0** |
| DS-25 | **Resend** (SMTP für GoTrue-Mails und Plattform-Alarme) | E-Mail-Adressen der Endnutzer und des Admins, Mailinhalte | US-Anbieter. AVV prüfen. Betrifft **alle** Tenants, weil GoTrue global über den einen `RESEND_API_KEY` versendet (`resend_api_key_encrypted` je Tenant ist bewusst ungenutzt) | **P0** |
| DS-26 | **Netcup** (VPS) | Alle Live-Daten | DE/EU, unkritisch. AVV mit Netcup sollte trotzdem vorliegen (Art. 28) | P1 |
| DS-27 | **GitHub** (`GITHUB_PAT`, Repos, Webhooks) | Quellcode, Commit-Metadaten | Nur dann personenbezogen, wenn Kundendaten im Repo liegen (Seeds, Fixtures, Dumps). Prüfen. Hinweis aus der Analyse: `up2web-schema.sql` und `dashboard/up2site-data.sql` liegen **ungetrackt** im Working Tree — vor jedem Commit prüfen, ob dort echte Kundendaten stehen | P1 |
| DS-28 | **GoDaddy-API** (`GODADDY_API_*`) | Domain-Verwaltungsdaten | Nur bei Nutzung. Prüfen, ob der Pfad überhaupt aktiv ist | P2 |
| DS-29 | **Uptime Kuma** | Erreichbarkeitsdaten | Self-hosted auf derselben VPS — kein Transfer | P3 |
| DS-30 | **Kunden-Apps selbst** | Fonts, Analytics, Zahlungsdienste im Kundencode | Verantwortung des Kunden, aber der Betreiber sollte es im Onboarding ansprechen — die Apps haben freien Internet-Egress (`app-<slug>-net` ist bewusst nicht `internal`) | P2 |

### 3.5 Auftragsverarbeitungsverträge

| # | Prüfauftrag | P |
|---|---|---|
| DS-31 | **AVV Betreiber ↔ Kunde** (Art. 28) für jeden Tenant — der Betreiber verarbeitet Endnutzerdaten im Auftrag. Muss die Unterauftragsverarbeiter aus DS-23 bis DS-28 benennen | **P0** |
| DS-32 | **AVV/DPA mit den Unterauftragsverarbeitern:** Netcup, Cloudflare, Backblaze, Resend, GitHub, ggf. GoDaddy. Liste vollständig halten — jeder neue Dienst in der `.env` ist ein potenzieller neuer Unterauftragsverarbeiter | **P0** |
| DS-33 | **Verzeichnis von Verarbeitungstätigkeiten** (Art. 30) — existiert im Repo nicht; §3.1 dieses Plans ist eine brauchbare Vorlage dafür | P1 |
| DS-34 | **TOM-Dokumentation** (Art. 32) — die vorhandenen Maßnahmen sind stark (Isolation auf vier Ebenen, age-Backups, Tunnel-only-Admin, Audit-Log), aber nirgends als TOM zusammengefasst. Die bekannten Lücken (Klartext-Secrets A1/A2, Superuser-SQL-Editor A3/A4) gehören ehrlich hinein | P1 |
| DS-35 | **Meldeprozess für Datenschutzverletzungen** (Art. 33, 72 h) — es gibt Alarme für Backup-Fehlschläge und Ausfälle, aber keinen definierten Ablauf für einen Datenabfluss | P1 |

---

## 4. Priorisierung

**Maßstab:** **P0** = sicherheits- oder datenschutzkritisch, oder ein Fehler verhindert eine Kernfunktion (Kunde offline, Daten weg, Isolation durchbrochen). **P1** = Betriebsrisiko oder stiller Fehlzustand. **P2** = Korrektheit im Detail, dokumentierte Altlasten festhalten. **P3** = Komfort.

Die reine Prio-Liste reicht nicht, weil fast alle P0-Fälle die noch fehlende SBX-Umgebung brauchen. Deshalb ist die Reihenfolge unten **nach Machbarkeit gestaffelt** — Stufe 1 und 2 sind ohne jede neue Infrastruktur startbar.

### Stufe 1 — sofort, reine CI, kein Stack nötig (der erste Test-Job)

Alles reine Logik oder Dateiscan. Zusammen deutlich unter 10 Sekunden Laufzeit.

| P | Fälle |
|---|---|
| **P0** | `TC-DEPL-01` Build-Zeit-Secret-Filter · `TC-ADM-01` Auth-Guard-Struktur­test · `TC-ADM-05` Passwortprüfung · `TC-STOR-05` Upload-Whitelist · `TC-ANA-01` Besucher-Hash-Rotation · `TC-ANA-02` Log-Feld-Normalisierung · `TC-AUD-02` `maskSecrets()` · `TC-TAR-04` `buildEnvVars()` über 5 Kombinationen |
| **P1** | `TC-PROV-06` Slug-Validierung · `TC-REST-05` JWT-Claims · `TC-TAR-01` Tarif-Limits · `TC-STOR-06` Rekodierung/EXIF · `TC-CMS-05` Feldvalidierung · `TC-CMS-06` Rate-Limit-Schlüssel · `TC-CMS-08` Sanitizing · `TC-DOM-03` Hostname-Validierung · `TC-MON-03` Versionsvergleich · `TC-CLN-03` Retention-Grenzen |
| **P2–P3** | `TC-DEPL-06` Fehlerhinweise · `TC-ROUTE-04` Router-YAML · `TC-ANA-04` kaputte Logzeile |

> Diese Stufe ist die günstigste Sicherheit im ganzen Plan: acht der P0-Fälle brauchen **weder** Docker **noch** eine Datenbank, und `TC-ADM-01` allein schließt eine Lücke (A5), die heute nur durch Disziplin geschlossen ist.

### Stufe 2 — sofort, lesend auf der Live-VPS (PROD-safe)

| P | Fälle |
|---|---|
| **P0** | `TC-ISO-06` Bestandsprüfung aller Tenant-DBs auf `PUBLIC CONNECT`/Fremdrollen · `TC-ADM-04` Dashboard nicht öffentlich · `TC-BKP-01` Restore-Test in Wegwerf-DB · `TC-BKP-03` `verify-backups.sh` als geplanter Lauf |
| **P0 (DSGVO-Inventur)** | `DS-01` Access-Log-Frist · `DS-07` GoTrue-Audit-IPs · `DS-09` `public/`-Präfix sichten · `DS-23` B2-Region feststellen · `DS-24`/`DS-25` Cloudflare/Resend-AVV prüfen · `DS-11` Off-Site-Kopie des age-Keys |
| **P1** | `TC-ROUTE-03` Domains/Zertifikate · `TC-BKP-07` Retention · `TC-MON-04` Inventar-Abgleich · `DS-03` Audit-Log-Frist festlegen |

### Stufe 3 — nach Bereitstellung der SBX-Umgebung (P0-Kern)

Die vier vom README selbst benannten Integrationstests zuerst — sie hätten 7 der 11 schwersten Audit-Befunde gefunden:

| Nr. | README-Test | Umsetzung hier |
|---|---|---|
| 1 | **Tenant-Isolation** | `TC-ISO-01` … `TC-ISO-05`, `TC-POOL-01`, `TC-STOR-01`, `TC-AUTH-03`, `TC-SQL-01`, `TC-CMS-01`/`03` |
| 2 | **Backup-Restore** | `TC-BKP-02` (fremde Maschine), `TC-BKP-04`, `TC-BKP-06` |
| 3 | **Deploy-Concurrency** | `TC-PROV-01`, `TC-PROV-02`, **`TC-PROV-03`**, `TC-DEPL-07` |
| 4 | **Route-Vertrag** | `TC-ADM-01` (bereits Stufe 1), `TC-ADM-02`, `TC-HOOK-01`, `TC-HOOK-04` |

Dazu die restlichen P0: `TC-ROUTE-01`, `TC-ROUTE-02`, `TC-PROV-04`, `TC-REST-01`, `TC-REST-02`, `TC-AUTH-01`, `TC-STOR-02`, `TC-DEPL-02`, `TC-DEPL-03`, `TC-DOM-02`, `TC-CMS-02`, `TC-CLN-01`.

**`TC-PROV-03` ist innerhalb dieser Stufe der wichtigste Einzelfall.** Beide Schutzschichten gegen den historisch destruktivsten Bug hängen an einem `/already exists/i`-String-Match auf einer Fehlermeldung; ein Postgres-Update, das die Meldung umformuliert, führt zurück in den Pfad, der einen fertigen Tenant löscht.

### Stufe 4 — P1/P2/P3 und Last

- **P1:** `TC-PROV-05`, `TC-PROV-07`, `TC-ISO-07`, `TC-REST-03`, `TC-AUTH-02`, `TC-AUTH-04`, `TC-STOR-03`, `TC-DEPL-04`, `TC-DEPL-05`, `TC-HOOK-02`, `TC-HOOK-03`, `TC-DOM-01`, `TC-ADM-03`, `TC-SQL-02` … `TC-SQL-05`, `TC-CMS-04`, `TC-CMS-07`, `TC-TAR-03`, `TC-TAR-05`, `TC-TAR-06`, `TC-ANA-03`, `TC-MON-02`, `TC-CLN-02`, `TC-AUD-01`, `TC-AUD-03`, `TC-RATE-02`
- **P2/P3:** der Rest der Tabellen in §2 — überwiegend Fälle, die einen **bekannten** Zustand festhalten (`TC-STOR-07` Quota nicht atomar, `TC-AUD-04`/`TC-RATE-03` `X-Actor` fälschbar, `TC-POOL-02` Prepared Statements). Solche Tests sind kein Qualitätsurteil, sondern ein Alarm, falls sich das Verhalten unbemerkt ändert.
- **Last (nur benannt, eigener Prompt):** `TC-RATE-01` Cloudflare-Kette (P0 — der wertvollste und zugleich gefährlichste Test der Plattform), `TC-DEPL-08` Build unter Speicherdruck (P0 — OOM-Killer trifft Postgres), `TC-POOL-04` Verbindungsbudget, `TC-RATE-04` Mehr-Tenant-Last, `TC-REST-06` PostgREST-Dauerlast, `TC-ROUTE-05` TLS-Handshakes. Alle sechs ausschließlich gegen einen isolierten Test-Tenant.

---

## 5. Abdeckungsziel

Eine Repo-weite Prozentzahl wäre hier eine Fantasiezahl: über die Hälfte des Agent-Codes ruft `docker`, `psql`, `mc` oder `git` auf. Diese Zeilen mit Mocks zu „decken" misst die Mocks, nicht das Verhalten — genau die Isolationsfehler, um die es geht, sind mit Mocks nicht auffindbar. Das Ziel wird deshalb pro Testart getrennt definiert.

### 5.1 Unit-Tests — Line Coverage nur auf einer benannten Modulliste

**Ziel: 70 % Line Coverage über die folgenden Module, gemessen ausschließlich über sie**, per `node --experimental-test-coverage`:

| Dienst | Module |
|---|---|
| provisioning-agent | `lib/jwt.ts` · `lib/crypto.ts` · `lib/secrets.ts` · `lib/nixpacks.ts` (Env-Filter) · `lib/buildErrorHints.ts` · `lib/analytics.ts` (Parsing + Hash) · `lib/inventory.ts` (Versionsvergleich) · `lib/audit.ts` (`maskSecrets`) · `lib/dns.ts` (Validierung) · `lib/traefikDynamic.ts` (Erzeugung) · `lib/deploy.ts` (nur `TARIFF_LIMITS`) |
| cms | `lib/rows.ts` · `lib/media.ts` (Validierung/Rekodierung) · `lib/rateLimit.ts` · `lib/errors.ts` |
| dashboard | `lib/audit.ts` |

Begründung für 70 % statt 80/90: Die Liste enthält bereits fast nur Logik ohne I/O — die letzten Prozent bestehen aus Fehlerpfaden, die eine echte Fehlerquelle brauchen, und das ist Integrationsarbeit. 70 % erreicht man mit den Fällen aus Stufe 1 nahezu vollständig, ohne Test-Kosmetik.

Zwei Regeln, die wichtiger sind als der Prozentwert:

1. **Ratchet, nie absolut:** Der Schwellwert darf nur steigen. Ein PR, der ihn senkt, scheitert. Startwert ist der nach Stufe 1 gemessene Wert — nicht ein vorher ausgedachter.
2. **Coverage außerhalb der Liste wird nicht gemessen und ist kein Ziel.** Neue Module kommen bewusst auf die Liste oder bewusst nicht.

### 5.2 Integration — Abdeckung nach Feature, nicht nach Prozent

- **Mindestens ein Integrationstest pro P0-Feature.** Das sind: F02, F03, F04, F05, F06, F07, F08, F11, F13, F15 → **10 Pflicht-Tests**.
- **Die vier vom README benannten Tests sind der Startsatz** (§4, Stufe 3) und gelten als Abnahmekriterium für die SBX-Umgebung: laufen sie dort nicht, ist die Umgebung nicht fertig.
- Jeder Integrationstest räumt hinter sich auf und legt seinen Tenant unter `test-<datum>-<zufall>` an. **Nie** gegen `sofre` oder `up2-site`.

### 5.3 E2E — Mindestszenarien

- **Zwei E2E-Szenarien pro kritischem Feature** (F02 Provisioning, F06 Auth, F08 Deployment, F13 CMS, F15 Backup) — je ein Erfolgs- und ein Fehlerpfad. Der Fehlerpfad ist der wertvollere: fast alle Befunde der bisherigen Audits lagen dort.
- **Drei der fünf Betriebskombinationen** aus `ANALYSE_1.md` §5.4 als durchgehendes Szenario: (1) Starter ohne DB, (3) Vollausbau mit DB + öffentlichem PostgREST + CMS, (5) DB vorhanden aber `db_enabled=false`. Die Kombinationen (2) und (4) sind über Integrationstests ausreichend abgedeckt.
- Browserbasiert nur zwei: Dashboard-Login und CMS-Redaktionsfluss. Alles andere ist HTTP und braucht keinen Browser.

### 5.4 Security-/Zugriffstests — hier gilt Vollständigkeit, nicht Prozent

- **Jede der vier Isolationsebenen braucht mindestens einen Negativtest** — `TC-ISO-01` bis `TC-ISO-04`. Ohne alle vier ist die Suite unvollständig, unabhängig von jeder Coverage-Zahl.
- **Jede Vertrauensgrenze braucht einen Ablehnungstest:** Agent-Secret, Dashboard-Session, CMS-Session, Webhook-HMAC, Tenant-JWT, MinIO-IAM. Sechs Grenzen, sechs Tests.
- **Ein Struktur-Test statt Disziplin:** `TC-ADM-01` prüft alle Dashboard-API-Routen auf ihren `auth()`-Guard. Der Test muss neue Routen automatisch einbeziehen (Verzeichnis-Scan, keine gepflegte Liste) — sonst verliert er genau dann seinen Wert, wenn er gebraucht wird.

### 5.5 Last — kein Abdeckungsziel in diesem Plan

Nur die sechs Szenarien aus §4, Stufe 4 sind benannt. Grenzwerte und Werkzeuge gehören in den späteren Lasttest-Prompt, weil sie von der SBX-Ausstattung abhängen.

### 5.6 Laufzeitbudget (damit die Suite benutzt wird)

| Stufe | Budget | Wo |
|---|---|---|
| Unit | < 10 s | jeder Push/PR, zusätzlich zum bestehenden Typecheck/Lint/Build |
| Integration | < 5 min | jeder PR auf `main`, sobald SBX steht |
| E2E | < 20 min | nächtlich und vor jedem Release |
| Last | eigener Termin | manuell, nie automatisch |

Wird ein Budget gerissen, wird der Test verschoben, nicht das Budget erhöht — eine Suite, die niemand abwartet, wird abgeschaltet.

### 5.7 Was ausdrücklich **kein** Ziel ist

- Keine Coverage-Zahl für `index.ts`, `routes/*`, `lib/deploy.ts` (außerhalb `TARIFF_LIMITS`), `lib/tenantDatabase.ts`, `lib/git.ts`, `lib/cms.ts`, `lib/github.ts`, `lib/monitoring.ts` — diese Dateien werden über Integration und E2E abgedeckt oder gar nicht.
- Keine Snapshot-Tests auf UI-Markup.
- Kein Test, der nur eine Konstante gegen sich selbst prüft.

---

## 6. Offene Fragen

Punkte, bei denen aus Code und Analyse **nicht** hervorgeht, wie das korrekte Verhalten aussieht. Sie werden hier benannt statt geraten; ohne Antwort lässt sich der jeweilige Testfall nicht abschließend formulieren.

| # | Frage | Betrifft |
|---|---|---|
| **OQ-01** | Soll ein **manuelles** `POST /deployments` auf einen `suspended` Tenant durchlaufen? `runDeployment()` prüft den Status selbst nicht — nur Webhook-Handler und Status-Route tun es. | `TC-TAR-05` |
| **OQ-02** | Zusammengesetzte Primärschlüssel im Table-Editor (offener Punkt P1-2): unterstützen oder wie im CMS ausdrücklich ablehnen? | `TC-SQL-05` |
| **OQ-03** | Sollen die clusterweiten Alt-Rollen `anon`/`authenticated`/`service_role` (letztere mit `BYPASSRLS`) entfernt werden? Heute existieren sie, werden aber nicht mehr vergeben — ein `GRANT ... TO service_role` aus einem Supabase-Export **scheitert deshalb nicht**, sondern wirkt still ins Leere. | `TC-ISO-07` |
| **OQ-04** | Wie wird `GOTRUE_DISABLE_SIGNUP` pro Tenant umgestellt? Es gibt keinen Endpunkt und keine Dashboard-Option; eine Handänderung an der Compose-Datei wird vom nächsten `writeTenantCompose()` überschrieben. Ohne Antwort hat ein Signup-E2E kein definiertes Soll. | `TC-AUTH-02` |
| **OQ-05** | Ist `tenant-migrations/` der dauerhafte Ort für Projekt-Migrationen, oder `supabase/migrations/` im Projekt-Repo (so die Empfehlung in `skills/multitenant-projekt/`)? Es gibt **keinen** Migrations-Läufer und kein Tracking für Tenant-DBs — damit fehlt der Sollzustand, gegen den ein Test prüfen könnte. | Testbarkeit von F05 |
| **OQ-06** | In welcher Region liegt der B2-Bucket `up2-multitennant`? Die rclone-Konfiguration enthält keinen `endpoint`; die Region hängt am Bucket und ist nur an der Backblaze-Konsole feststellbar. | `DS-23` |
| **OQ-07** | Wie ist die datenschutzrechtliche Rollenverteilung vertraglich abgebildet — existiert je Kunde ein AVV, der die Unterauftragsverarbeiter benennt? | `DS-31`, `DS-32` |
| **OQ-08** | Welche Aufbewahrungsfristen gelten für `audit_logs` und `traefik/logs/access.log`? Für beide existiert heute **keine**. | `DS-01`, `DS-03` |
| **OQ-09** | **Woher kommt die SBX-Umgebung?** Zweite VPS, lokales Compose oder Docker-in-Docker. Ohne Entscheidung bleiben Stufe 3 und 4 dieses Plans unausführbar — das ist der einzige echte Blocker. | Stufen 3–4 gesamt |
| **OQ-10** | Ist eine Billing-/Kontingentlogik geplant? Heute steuert der Tarif ausschließlich RAM/CPU. Falls geplant, kommen Testfälle für Kontingentgrenzen und Abrechnungsereignisse dazu — heute wären sie erfunden. | F14 |
| **OQ-11** | Sind `P2-5`, `P2-8`–`P2-10`, `P2-13`–`P2-16`, `P2-18` umgesetzt? Die Sprint-Skripte haben sich nach Anwendung selbst gelöscht, im Code existieren keine Marker. Ohne Antwort ist kein Soll und damit kein Regressionstest formulierbar. | Regressionsabdeckung |
| **OQ-12** | Das rclone-Remote `hetzner` in `backups/rclone.conf` ist unbrauchbar konfiguriert (`host = cd /opt/multitenant-platform`, leerer `user`) und wird von `RCLONE_REMOTE_PATH` nicht verwendet. Altlast zum Entfernen oder unfertiges Zweitziel? Ein zweites, unabhängiges Backupziel wäre für DS-11 die naheliegende Antwort. | `DS-10`, `DS-11` |
| **OQ-13** | Soll die Plattform RLS erzwingen, bevor `postgrest_public_enabled` gesetzt werden kann? Heute warnt der Code nur (`routes/tenants.ts`), verhindert es aber nicht — eine öffentlich freigegebene Tenant-DB ohne Policies ist für jeden mit dem Anon-Key les- **und schreibbar**. | `TC-REST-01` |

---

## 7. Was dieser Plan bewusst nicht enthält

- **Keine Testsuite, kein Testcode.** Die Modulliste in §5.1 und die Fall-IDs in §2 sind die Vorlage dafür; geschrieben wird sie im nächsten Schritt.
- **Keine CI/CD-Konfiguration.** `.github/workflows/ci.yml` bleibt unangetastet; §4 Stufe 1 beschreibt, was der spätere Test-Job aufnimmt.
- **Keine Ausführung.** Kein Test wurde gefahren, keine Last erzeugt, kein Dienst angefasst. Die Angaben zu Access-Log, rclone-Konfiguration, Retention-Werten und fehlenden Test-Scripts stammen aus rein lesender Inspektion der Live-VPS.
