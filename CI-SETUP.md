# CI-SETUP

**Stand:** 2026-08-26 · **Grundlage:** `TESTPLAN.md` (Testfall-IDs), `ANALYSE_1.md`, `REPO-REVIEW.md`
**Gegenstand:** `.github/workflows/ci.yml`, `docker-compose.ci.yml`, `scripts/ci/`

Diese Pipeline **testet nur**. Sie deployt nichts, und kein Job verbindet sich mit der Live-VPS.

---

## 1. Was die Pipeline tut

Sechs Jobs. Die drei Build-Jobs bestanden bereits (P3-4), drei sind neu.

| Job | Läuft bei | Braucht | Dauer (erwartet) | Blockiert bei |
|---|---|---|---|---|
| **unit** | jedem Push/PR | nichts außer Node 20 | < 1 min | P0-Fehler |
| **dashboard** / **provisioning-agent** / **cms** | jedem Push/PR | Node 20 | je 1–3 min | jedem Fehler (unverändert) |
| **integration** | nach `unit` | Docker im Runner | 5–10 min | P0-Fehler |
| **security** | nach `unit` | Docker im Runner | 5–10 min | P0-Fehler |

`integration` und `security` hängen an `needs: [unit]` — einen Container-Stack für einen Tippfehler hochzufahren wäre verschwendete Runner-Zeit.

### 1.1 Job `unit` — Stufe 1 aus `TESTPLAN.md` §4

Reine Logik und Dateiscans, kein Stack. Läuft gegen `provisioning-agent/dist/` — dieselbe Ausgabe, die auch ins Container-Image geht, deshalb braucht es keinen zusätzlichen Test-Transpiler.

| Testfall | Prio | Was geprüft wird |
|---|---|---|
| `TC-DEPL-01` | P0 | Build-Zeit-Env-Filter: `JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `MINIO_SECRET_KEY`, `DATABASE_URL`, `POSTGRES_PASSWORD` und alles secret-artige bleiben aus dem Image; `NEXT_PUBLIC_*` & Co. kommen durch |
| `TC-AUD-02` | P0 | `maskSecrets()`: Namensmuster, Zugangsdaten in Verbindungs-URLs, konkrete Werte, Längensortierung, Ignorieren zu kurzer Werte |
| `TC-ANA-01` | P0 | Besucher-Hash ist tagesstabil und tagesübergreifend **nicht** wiedererkennbar; gibt IP und User-Agent nicht preis |
| `TC-ANA-02` | P0 | Query-String verworfen, Pfad gekappt, Referrer auf die Herkunft reduziert |
| `TC-ADM-01` | P0 | **Jeder** HTTP-Handler jeder Dashboard-API-Route ruft `auth()`; genau eine dokumentierte Ausnahme |
| `TC-STOR-01` | P0 (teilweise) | MinIO-Policy nennt ausschließlich die zwei eigenen Bucket-ARNs, kein Wildcard |
| `TC-REST-05` | P1 | JWT-Claims: `role` tenant-eigen, `iss` gesetzt, `exp`/`aud` bewusst nicht |
| `TC-TAR-01` | P1 | Tarif-Limits; unbekannter Tarif fällt auf `starter` |
| `TC-PROV-06` | P1 | alle Slug-Regexe im Code verwenden dasselbe Muster |
| `TC-MON-03` | P1 | Image-Referenzen (Digest, Registry-Port, fehlender Tag), Container-Zuordnung, Drift |
| `TC-DOM-03` | P1 | Public-Suffix-Zerlegung; Apex → A-Record, Subdomain → CNAME |
| `TC-DEPL-06` | P2 | Build-Fehlerhinweise; unbekannte Fehler liefern `null` statt eines falschen Hinweises |

**Stand: 43 Tests, davon 23 mit `[P0]`, alle grün** (lokal gegen Node 20.20.2 ausgeführt).

### 1.2 Job `integration`

Baut `docker-compose.ci.yml` auf und provisioniert zwei Testmandanten **mit dem echten Agent-Code**, danach:

| Testfall | Prio | Was geprüft wird |
|---|---|---|
| `TC-REST-01` | P0 | Tabelle ohne RLS ist mit dem Anon-Key voll lesbar — hält den Ist-Zustand fest (siehe `TESTPLAN.md` OQ-13) |
| `TC-REST-02` | P0 | RLS begrenzt `anon`, `service_role_<slug>` sieht die Zeile |
| `TC-AUTH-03` | P0 | Token mit fremdem `role`-Claim und Token mit falschem Secret werden abgewiesen |
| `TC-TAR-04` | P0 | die gerenderte Tenant-Compose nennt tenant-eigene Rollen, verbindet nie als Superuser, hat keine unersetzten Platzhalter |
| `TC-REST-04` | P1 | PostgREST bedient ausschließlich `public` |
| `TC-AUTH-02` | P1 | GoTrue antwortet, Self-Signup ist aus |
| `TC-POOL-02` | P1 | `PGRST_DB_PREPARED_STATEMENTS=false` (PgBouncer-Transaction-Mode) |
| — | P1 | `scripts/migrate.sh` läuft ein zweites Mal über bereits angewandte Migrationen: prüft ihre **Idempotenz** (vor P2-7 nicht gegeben) |

### 1.3 Job `security`

Derselbe Stack, ausschließlich **Negativtests**: jeder prüft einen Zugriff, der fehlschlagen *muss*. Ein Positivtest bewiese hier nichts — dass Tenant A seine eigenen Daten sieht, sagt nichts darüber, ob er auch die von B sieht.

| Testfall | Prio | Ebene (`ANALYSE_1.md` §2) | Was geprüft wird |
|---|---|---|---|
| `TC-ISO-01` | P0 | 1 — DB pro Tenant | `authenticator_A` kommt **nicht** in `kunde_B`; Gegenprobe: kommt in die eigene DB |
| `TC-ISO-06` | P0 | 1 | keine `kunde_*`-DB vergibt `CONNECT` an `PUBLIC` (`REVOKE`-Wirkung, P0-2a) |
| `TC-ISO-02` | P0 | 2 — Rollen pro Tenant | Rollen von A haben in `kunde_B` kein `CONNECT`; Authenticator ist `NOINHERIT` und Mitglied ausschließlich eigener Rollen; keine `BYPASSRLS`-Rolle ist an einen Authenticator vergeben |
| `TC-ISO-03` | P0 | 3 — PgBouncer-Auth | falsches Passwort wird abgewiesen statt still auf `postgres` gemappt; fremder Authenticator kommt mit eigenem Passwort nicht in fremde DB |
| `TC-POOL-01` | P0 | 3 | `current_user` über PgBouncer ist `authenticator_<slug>`, **nicht** `postgres` |

`TC-ISO-03`/`TC-POOL-01` sind der Kern: ohne `AUTH_QUERY` erzeugt das PgBouncer-Image `userlist.txt` nur aus `DB_USER`/`DB_PASSWORD` und mappt jede unbekannte Rolle auf `postgres`. PostgREST wäre dann in **jeder** Tenant-DB Superuser und RLS überall wirkungslos. Der Fehler produziert keinen Fehler, sondern Zugriff — deshalb braucht genau er einen Test.

---

## 2. Der isolierte CI-Stack

`docker-compose.ci.yml` startet im Runner: `core-postgres`, `pgbouncer`, `core-minio`. `scripts/ci/up.sh` fügt hinzu: Passwort der PgBouncer-Auth-Rolle, Plattform-Migrationen, zwei Testmandanten, das Testschema und die Tenant-Dienste (`auth-ci-alpha`, `api-ci-alpha` aus dem **echten** `tenant-compose.yml`).

**Was bewusst gleich bleibt wie in Produktion:** Image-Versionen, Container-/Hostnamen und die sicherheitsrelevante PgBouncer-Konfiguration (`AUTH_QUERY`, `AUTH_DBNAME`, `POOL_MODE`, `max_connections=60`). Die Namen sind im Agent-Code hartkodiert — eine Umbenennung ließe die Tests an der Konfiguration vorbei laufen.

**Was bewusst anders ist:** kein `restart: always`, keine `mem_limit`s, kein Traefik/Cloudflared/Agent/Dashboard, flüchtige Volumes (jeder Lauf startet leer, damit `docker-entrypoint-initdb.d` die Migrationen wirklich ausführt), `shared_buffers=128MB`, **keine** auf den Runner-Host veröffentlichten Ports.

Die Tests laufen selbst als Container in `traefik-net` (`scripts/ci/in-net.sh`) und sprechen die Dienste unter denselben Namen an wie die Produktion. Das erspart Port-Kollisionen mit den Diensten, die ein Runner-Image vorinstalliert mitbringt.

### 2.1 Warum die Testmandanten mit echtem Agent-Code angelegt werden

`scripts/ci/provision-test-tenants.js` ruft `provisionTenantDatabaseSchema()` und `writeTenantCompose()` aus `provisioning-agent/dist/` auf. Eine nachgebaute SQL-Sequenz würde das Testskript prüfen statt die Plattform — und genau die geprüfte Eigenschaft (`REVOKE ALL ... FROM PUBLIC`, Rollen-Template, `NOINHERIT`) ist der Gegenstand des Tests.

Dafür wurden drei behavior-neutrale Änderungen am Produktionscode nötig, ohne die die P0-Tests nicht existieren können:

| Datei | Änderung | Warum |
|---|---|---|
| `lib/nixpacks.ts` | `isBuildTimeSafe` von einer Closure in `nixpacksBuild()` auf Modulebene gehoben und exportiert | sonst nur über einen echten `nixpacks`-Build testbar |
| `lib/deploy.ts` | `TARIFF_LIMITS` exportiert | — |
| `lib/analytics.ts` | `visitorHash`, `normalizeHost`, `normalizePath`, `normalizeReferrer` exportiert | die Datenschutzzusage aus `20_analytics.sql` war sonst nicht nachprüfbar |
| `lib/tenantDatabase.ts` | reiner DB-Teil als `provisionTenantDatabaseSchema()` herausgelöst, `provisionTenantDatabase()` ruft ihn auf | der Rest der Funktion startet Docker-Container; die Isolationstests brauchen nur den DB-Teil |

Kein Verhalten wurde geändert; `npx tsc --noEmit` und alle 43 Unit-Tests laufen danach durch.

### 2.2 Die Notbremse

Die CI-Container heißen wie die Produktionscontainer (unvermeidbar, siehe oben). Ein versehentliches `docker compose -f docker-compose.ci.yml up` auf der Live-VPS würde die laufenden Container überschreiben.

`scripts/ci/assert-not-production.sh` steht deshalb vor jedem Skript, das Container startet, und bricht bei **einem** von drei Merkmalen ab:

1. `CI` ist nicht `true`
2. eine `.env` liegt im Repo-Root (die ist gitignored — ein frischer Checkout hat keine)
3. auf dem Host existiert ein Container namens `global-traefik`, `cloudflared`, `provisioning-agent`, `admin-dashboard` oder `uptime-kuma`

**Gegen die Live-VPS getestet:** mit erzwungenem `CI=true` bricht das Skript dort an Merkmal 2 ab, bevor irgendetwas startet.

---

## 3. Secrets

**Es wird kein einziges echtes Secret verwendet, und es muss keines in GitHub hinterlegt werden.**

`scripts/ci/env.sh` würfelt pro Lauf alle Werte neu (`openssl rand -hex`): DB-Passwörter, PgBouncer-Auth-Passwort, MinIO-Root, `ENCRYPTION_MASTER_KEY` (64 Hexzeichen, so verlangt es `lib/crypto.ts`), `CMS_ENCRYPTION_KEY`, `ANALYTICS_SALT` sowie Slugs, Authenticator-Passwörter und JWT-Secrets der beiden Testmandanten. Alles stirbt mit dem Runner.

Damit gibt es **keinen Pfad**, über den ein Pull Request — auch aus einem Fork — an ein Produktionsgeheimnis käme, und keinen Grund, jemals eines in GitHub Actions Secrets zu legen. `RESEND_API_KEY`, `GITHUB_PAT` und `CF_DNS_API_TOKEN` bleiben bewusst **leer**, damit der Code seinen Warnpfad geht statt zu versuchen, nach außen zu telefonieren. `PLATFORM_DOMAIN=ci.invalid` ist per RFC 2606 garantiert nicht auflösbar — ein Test, der versehentlich rausruft, scheitert sofort statt still zu funktionieren.

### 3.1 Wie das zur `age`-Verschlüsselung der Backups passt

Die Plattform verschlüsselt Backups mit `age` (X25519 + ChaCha20-Poly1305, öffentlicher Schlüssel in `BACKUP_AGE_PUBLIC_KEY`, privater in `backups/age-identity.txt`). Für die CI ist die Antwort einfach: **sie taucht dort nicht auf.**

Ein Backup-Test in der Pipeline bräuchte entweder den privaten age-Schlüssel oder Zugang zum Backblaze-Bucket — beides Produktionsgeheimnisse, beide würden dem Runner Lesezugriff auf sämtliche Kundendaten geben. Der Gegenwert wäre gering: `backups/verify-backups.sh` prüft dieselben Eigenschaften bereits vollständig und läuft dort, wo die Daten liegen. `TC-BKP-01`/`TC-BKP-03` bleiben deshalb bewusst Stufe 2 aus `TESTPLAN.md` (PROD-safe, lesend auf der VPS) und nicht Teil dieser Pipeline.

Wenn ein Backup-Restore je in CI laufen soll, dann mit einem **eigenen age-Keypair und einem eigenen leeren Bucket** für Testdaten — nie mit den produktiven.

---

## 4. Ab wann blockiert was

Requirement aus dem Auftrag, hier konkret gemacht:

| Stufe | Verhalten heute | Wird blockierend, wenn |
|---|---|---|
| **P0** (unit, integration, security) | **blockiert** den Merge sofort | — |
| **P1–P3** | `continue-on-error: true` — rot im Log, grün für den Merge | die jeweilige P0-Suite eine Woche ohne Fehlalarm grün lief und die P1-Fälle einmal bewusst durchgesehen wurden. Danach `continue-on-error` entfernen, Stufe für Stufe: erst `unit`, dann `integration`, zuletzt `security` |
| **Build-Jobs** | blockieren (unverändert seit P3-4) | — |

**Noch zu tun außerhalb dieser Dateien:** In den GitHub-Branch-Protection-Regeln für `main` müssen die Jobs `unit`, `integration` und `security` als *required status checks* eingetragen werden. Ohne das kann ein PR trotz rotem P0-Job gemergt werden — die Pipeline meldet dann korrekt und folgenlos.

### 4.1 Der Leerlauf-Schutz

`node --test --test-name-pattern '\[P0\]'` beendet sich mit **0**, wenn kein einziger Test auf das Muster passt: nicht getroffene Tests gelten als `SKIP`. Verrutschte die Namenskonvention, wäre der blockierende P0-Schritt still grün — wirkungslos genau dann, wenn er gebraucht wird.

`scripts/ci/run-tests.sh` liest deshalb die Summenzeile und bricht mit Exit 3 ab, wenn `pass + fail == 0`. Beide Pfade sind lokal verifiziert: `'\[P0\]'` → 23 Tests, Exit 0; `'\[P9\]'` → Exit 3; ein absichtlich rot gesetzter Test → Exit 1.

Dieselbe Klasse von Fehler ist auch im Struktur-Test abgesichert: `TC-ADM-01` prüft zuerst, dass der Verzeichnisscan überhaupt ≥ 40 Route-Dateien findet — ein umbenanntes Verzeichnis ließe ihn sonst grün durchlaufen, ohne etwas zu prüfen.

---

## 5. Was bewusst NICHT in dieser Pipeline ist

### 5.1 E2E- und Lasttests

Beide gehören laut Auftrag und `TESTPLAN.md` §4 in einen separaten, manuell ausgelösten Lauf gegen einen isolierten Test-Tenant. Zwei Gründe, die über die Aufgabenstellung hinausgehen und für die Entscheidung sprechen:

- **`TC-RATE-01`** (600 Requests über die echte Cloudflare-Kette) ist der wertvollste Test der Plattform — er ist der einzige, der zeigt, ob `Cf-Connecting-Ip` wirklich greift oder ob Traefik alle Besucher als eine Edge-IP sieht. Er ist im CI-Runner **nicht abbildbar**: dort gibt es kein Cloudflare.
- **`TC-DEPL-08`** (Nixpacks-Build unter Speicherdruck) fordert 1–2 GB. Auf der VPS nimmt der OOM-Killer dann typischerweise Postgres, also die DB aller Kunden. Im Runner wäre der Test möglich, aber sein Aussagewert hängt an den Speicherverhältnissen der echten Maschine.

### 5.2 Automatisches Deployment

Kein Job dieser Datei fasst die Live-VPS an. Deployment-Automatisierung setzt voraus, dass ein Fehlschlag zurückgerollt werden kann und dass vorher etwas Vergleichbares getestet wurde — beides gibt es erst mit einer Staging-/Test-Tenant-Umgebung (`TESTPLAN.md` OQ-09). Vorher wäre Auto-Deploy ein Mechanismus, der Fehler schneller in die Produktion trägt.

---

## 6. Offene Punkte

Testfälle aus `TESTPLAN.md`, die sich **nicht sauber isoliert** im Runner abbilden lassen. Sie stehen hier statt als unsichere Näherung im Code.

| # | Testfall | Warum nicht (jetzt) | Was es bräuchte |
|---|---|---|---|
| **OP-1** | `TC-STOR-01` (P0) — Tenant A kommt nicht an Bucket B | Die MinIO-Provisionierung (Bucket, IAM-User, Policy) liegt in `provisioning-agent/src/index.ts` **mitten im Request-Handler** von `POST /tenants` und ist ohne Serverstart nicht aufrufbar. Ein Nachbau in der CI würde das Testskript prüfen, nicht die Plattform. Ersatzweise prüft `scripts/ci/unit/structure.test.js` die Policy-**Form** (nur eigene ARNs, kein Wildcard) | Herauslösen nach `lib/minio.ts`, analog zu `provisionTenantDatabaseSchema()`. Danach ist der echte Negativtest ein Zehnzeiler |
| **OP-2** | `TC-PROV-01/02/03` (P0) — Provisioning-Concurrency und Rollback | Brauchen den laufenden Agent samt Advisory Lock, Docker-Socket-Proxy und dem vollen `POST /tenants`-Pfad. `TC-PROV-03` ist zugleich der **wichtigste Einzelfall des Testplans** (beide Rollback-Schutzschichten hängen an `/already exists/i`-String-Matching) | Agent-Container im CI-Stack mit gemountetem Docker-Socket. Machbar, aber eine eigene Ausbaustufe — der Agent bringt `nixpacks`, `mc`, `rclone` und `age` mit und erwartet den Pfad `/opt/multitenant-platform` |
| **OP-3** | `TC-CMS-01/02/03` (P0) — Mandantengrenze des CMS | Braucht den laufenden CMS-Dienst und `cms_users`-Sitzungen | CMS-Container im CI-Stack. Die eigentliche Prüfung (`requireSession(tenantSlug)` gibt `null` bei Slug-Abweichung) ist danach billig |
| **OP-4** | `TC-CMS-05/06/08`, `TC-STOR-05/06`, `TC-ADM-05` (P0/P1) — Unit-Tests in `cms`/`dashboard` | Beides sind Next.js-Apps ohne Build-Artefakt, das sich wie `provisioning-agent/dist/` importieren ließe. Node 20 kann `.ts` nicht direkt ausführen | Entweder Node 22 mit nativem Type-Stripping für den Test-Job, oder eine kleine `tsconfig.test.json` je Paket, die nur die reinen Logikmodule emittiert. Bewusst zurückgestellt, weil beides ungetestet in den Workflow gegangen wäre |
| **OP-5** | `TC-REST-03` (P1) — Schema-Reload nach DDL | Der Reload braucht `SIGUSR1` an `api-<slug>`, also Docker-Zugriff aus dem Testcontainer heraus. Das CI-Testschema wird deshalb **vor** dem Start von PostgREST eingespielt | Docker-Socket in den Testcontainer, oder ein Workflow-Step, der `docker kill -s SIGUSR1` zwischen zwei Testläufen ausführt |
| **OP-6** | `TC-BKP-*` (P0) — Backup und Restore | Bräuchte produktive Schlüssel oder Bucket-Zugang (§3.1) | Eigenes age-Keypair + leerer Testbucket, oder weiterhin `verify-backups.sh` auf der VPS |
| **OP-7** | `TC-ROUTE-*` (P0) — Traefik-Routing, Netz-Reattach | Kein Traefik im CI-Stack; der geprüfte Zustand (`global-traefik` hängt in jedem `app-<slug>-net`) ist reiner Docker-Laufzeitzustand der echten Maschine | Traefik im CI-Stack plus ein Dummy-App-Container. Sinnvoll erst zusammen mit OP-2 |
| **OP-8** | Erstlauf-Verifikation | `unit` ist lokal vollständig ausgeführt (43/43 grün). `integration` und `security` sind **statisch geprüft** (YAML valide, Compose valide, Shell- und JS-Syntax, Argumentaufbau von `in-net.sh` per Dry-Run), aber **noch nie in einem echten Runner gelaufen** — auf dieser Maschine wäre das nur gegen die Produktion gegangen, und das verbietet die Aufgabenstellung zu Recht | Der erste Lauf auf GitHub. Erwartbare Stolperstellen: Image-Pull-Zeiten (GoTrue/PostgREST), das `sudo ln -s` auf `/opt/multitenant-platform`, und ob PgBouncer nach dem `restart` schnell genug bereit ist |

---

## 7. Lokal ausführen

```bash
# Unit- und Strukturtests (jederzeit, überall, ohne Docker)
cd provisioning-agent && npm ci && npm run build && cd ..
scripts/ci/run-tests.sh '\[P0\]'      provisioning-agent/test/ scripts/ci/unit/
scripts/ci/run-tests.sh '\[P[123]\]'  provisioning-agent/test/ scripts/ci/unit/
```

Integration und Security **nicht** lokal auf der VPS starten — `assert-not-production.sh` verhindert es, und das ist beabsichtigt. Sie brauchen eine leere Maschine mit Docker:

```bash
export CI=true
source scripts/ci/env.sh
scripts/ci/up.sh
scripts/ci/in-net.sh scripts/ci/run-tests.sh '\[P0\]' scripts/ci/security/
scripts/ci/in-net.sh scripts/ci/run-tests.sh '\[P0\]' scripts/ci/integration/
docker compose -f docker-compose.ci.yml down -v
```

---

## 8. Dateiübersicht

```
.github/workflows/ci.yml              6 Jobs: unit, 3× build, integration, security
docker-compose.ci.yml                 isolierter Stack (Postgres, PgBouncer, MinIO)
scripts/ci/
├── assert-not-production.sh          Notbremse — steht vor jedem Stack-Start
├── env.sh                            Wegwerf-Secrets, pro Lauf neu gewürfelt
├── up.sh                             Stack aufbauen, migrieren, Mandanten anlegen
├── in-net.sh                         Befehl in traefik-net ausführen
├── run-tests.sh                      node --test mit Prio-Filter + Leerlauf-Schutz
├── provision-test-tenants.js         ruft den echten Agent-Code auf
├── fixtures/tenant-schema.sql        Testschema (RLS-Tabelle + offene Tabelle)
├── unit/structure.test.js            TC-ADM-01, TC-PROV-06, TC-STOR-01 (Form)
├── integration/                      TC-REST-*, TC-AUTH-*, TC-TAR-04, TC-POOL-02
└── security/isolation.test.js        TC-ISO-*, TC-POOL-01 — nur Negativtests
provisioning-agent/test/              Unit-Tests gegen dist/
```
