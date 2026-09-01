# RESSOURCEN-PROFIL & SKALIERUNGSGRENZE

**Stand:** 2026-08-27, 15:19–15:24 UTC · **Branch:** `claude/backup-prozedur-main-1ibs2q` · **Basis-Commit:** `0b0d3bb`
**Methode:** Messung im **laufenden Normalbetrieb**. Es wurde **keine künstliche Last erzeugt** — Lastspitzen gehören in den separaten Stresstest-Prompt.
**Messbasis:** 10 `docker stats`-Stichproben im 30-Sekunden-Abstand über 5 Minuten, plus cgroup-`memory.stat`, `/proc/meminfo`, `ps`, `docker system df`, `journalctl -k`.

---

## 0. Vorbemerkungen — zwei Korrekturen und eine Einschränkung

### 0.1 „Bisher gibt es kein Monitoring" trifft nicht ganz zu

Die Auftragsannahme ist zu pauschal. Vorhanden sind bereits:

| Baustein | Zustand |
|---|---|
| **Uptime Kuma 2.4.0** | läuft als Container, seit 8 Tagen. **Aber:** `projects.kuma_monitor_id` ist für **beide** Projekte `NULL` — es ist aktuell **kein einziger Monitor angelegt**. `lib/monitoring.ts` (109 Zeilen) existiert und würde das tun, hat es aber nie getan |
| **Traefik-Prometheus-Metriken** | `--metrics.prometheus=true` ist gesetzt (`traefik/docker-compose.yml`), aber **kein `metrics`-Entrypoint** exponiert. Die Metriken werden erzeugt und von niemandem abgeholt |
| **Versionsinventar** | `lib/inventory.ts` (434 Zeilen), stündlich, schreibt nach `components`/`vulnerabilities` (Migration 24) |
| **Disk-Alarm** | `getDiskUsage()` (`lib/cleanup.ts:261`) per `df -B1 /opt`, plus Resend-Alarm |
| **Cleanup** | täglich: Build-Snapshots (behält 5), Docker-Images (behält 5 je Projekt), Analytics-Retention |

Was **fehlt**, ist genau das, wofür dieser Bericht die Zahlen liefert: **Zeitreihen für RAM und CPU pro Container**. Kuma prüft Erreichbarkeit, nicht Ressourcen. Siehe §6.

### 0.2 Das Messwerkzeug läuft auf der Messmaschine

Die Claude-Code-Sitzung, die diese Messung durchführt, läuft **auf derselben VPS** und belegt **512,9 MiB RSS** (`claude` 432,9 MiB + Node-Hilfsprozesse). Das ist knapp 6,5 % des Gesamt-RAM und **darf nicht in den Sockel eingerechnet werden**. Alle Sockelzahlen unten sind ohne diesen Anteil gerechnet; wo Host-Gesamtwerte auftauchen, ist der Abzug ausgewiesen.

### 0.3 Einschränkung nach Leitplanke: n = 2

**Es laufen genau zwei Tenants (`sofre`, `up2-site`) mit je einem Projekt.** Beide im Tarif `business`, beide mit DB, **keiner mit CMS**. Daraus folgt:

- Der Wert **„RAM pro Tenant-Dienst" (api + auth) ist belastbar** — die Container sind funktionsgleich, die Streuung liegt bei 15–25 MiB (PostgREST) bzw. 7,4–7,8 MiB (GoTrue). Zwei Messpunkte reichen, weil die Software identisch ist.
- Der Wert **„RAM pro App-Container" ist eine Spanne, kein Mittelwert.** Gemessen 85,4 MiB (`sofre`) gegen 246,6 MiB (`up2-site`) — Faktor 2,9 bei zwei Next.js-Apps. Der Durchschnitt von 166 MiB ist arithmetisch korrekt und **prognostisch wenig wert**. Jede Zahl in §5, die darauf beruht, ist als **Hochrechnung** gekennzeichnet.
- **Nicht gemessen, weil kein Datenpunkt existiert:** CMS-Nutzung (0 Tenants), MinIO-Speicher (0 Objekte, 0 Bytes), Tarif `starter`/`premium`, Tenant ohne DB, mehr als ein Projekt pro Tenant.
- **Der Betrieb war während der Messung praktisch im Leerlauf:** Load Average 0,00 / 0,03 / 0,01 bei 4 vCPU. Die CPU-Zahlen unten sind Leerlaufwerte und sagen über das Verhalten unter Last **nichts** aus.

---

## 1. VPS-Spezifikation

| | Wert | Quelle |
|---|---|---|
| **Anbieter / Typ** | netcup, KVM Server (`v2202607387560489167`) | `/sys/class/dmi/id` |
| **CPU** | **4 vCPU**, AMD EPYC-Genoa, 1 Thread/Core, 4 Sockets, 4493 BogoMIPS | `nproc`, `lscpu` |
| **RAM** | **8.130.780 kB = 7,75 GiB** (7.938 MiB) | `/proc/meminfo` |
| **Swap** | 2,0 GiB (`/swapfile`), davon **263 MiB belegt** | `swapon --show` |
| **Storage** | `/dev/vda3`, **250,9 GiB**, davon **92,9 GiB belegt (39 %)**, 147,7 GiB frei | `df -h` |
| **Uptime** | 31 Tage | `uptime` |
| **Load Average** | **0,00 / 0,03 / 0,01** — praktisch Leerlauf | `/proc/loadavg` |
| **Overcommit** | `vm.overcommit_memory=0`, `CommitLimit` 5,88 GiB, **`Committed_AS` 5,47 GiB (93 %)** | `/proc/meminfo` |

**Zur Storage-Zahl:** `df -h --total` meldet 4,7 TiB — das ist ein Artefakt, weil Docker 18 Overlay-Mounts derselben Partition einzeln zählt. Maßgeblich ist **allein `/dev/vda3` mit 250,9 GiB**.

**Zum Overcommit-Wert:** `Committed_AS` bei 93 % des `CommitLimit` klingt alarmierend, ist es bei `overcommit_memory=0` aber nicht — der Kernel setzt das Limit dort gar nicht durch (heuristisches Overcommit). Als **Frühwarnindikator** ist die Zahl trotzdem brauchbar: sie zeigt, wie viel virtueller Speicher zugesagt ist. Node-Prozesse reservieren typischerweise sehr große virtuelle Adressräume (siehe die OOM-Protokolle in §4.3: `total-vm:24 GB` bei 245 MB tatsächlichem RSS), die Kennzahl ist deshalb hier eher ein Node-Artefakt als ein Warnsignal.

---

## 2. Fixer Sockel — was immer läuft, unabhängig von Tenants

Mittelwerte aus 10 Stichproben. `docker stats`-Speicher (= `memory.current` des cgroups, enthält Seitencache).

### 2.1 Geteilte Dienste

| Container | Ø MiB | min | max | Limit | Auslastung | Rolle |
|---|---:|---:|---:|---:|---:|---|
| `provisioning-agent` | **174,8** | 174,6 | 175,0 | 2048 | 9 % | Provisioning, Deploy, Analytics-Ingest, Cleanup |
| `core-minio` | **133,0** | 131,2 | 133,5 | 512 | 26 % | Objektspeicher aller Tenants |
| `uptime-kuma` | **107,5** | 107,4 | 107,5 | 128 | **84 %** | Erreichbarkeitsprüfung — **siehe §4.3** |
| `core-postgres` | **70,1** | 68,6 | 70,4 | 2048 | 3 % | Alle Tenant-DBs + `admin_dashboard` |
| `cms` | **57,2** | 56,9 | 57,6 | 512 | 11 % | Redaktionsoberfläche (aktuell von 0 Tenants genutzt) |
| `admin-dashboard` | **51,4** | 50,5 | 51,5 | 512 | 10 % | Next.js Admin-UI |
| `global-traefik` | **38,8** | 25,3 | 42,3 | 256 | 15 % | Reverse Proxy, TLS |
| `cloudflared` | **15,4** | 15,4 | 15,7 | **kein** | — | Zero-Trust-Tunnel |
| `docker-socket-proxy` | **2,1** | 2,1 | 2,1 | 64 | 3 % | gefilterter Docker-Zugriff |
| `pgbouncer` | **1,3** | 0,6 | 2,4 | 128 | 1 % | Connection Pooling |
| **Summe geteilte Dienste** | **651,7** | | | 6208 | **10 %** | |

### 2.2 Build-Infrastruktur — der überraschende Posten

| Container | Ø MiB | anon (hart) | Limit |
|---|---:|---:|---:|
| `buildx_buildkit_default` | **796,0** | **19,9** | 2048 |
| `buildx_buildkit_nixpacks-builder0` | **7,7** | 6,9 | 2048 |
| **Summe** | **803,7** | 26,8 | |

**Befund R-01 (P1): Die Build-Infrastruktur ist mit 804 MiB der größte Einzelposten des Sockels — größer als alle zehn geteilten Dienste zusammen (652 MiB).**

Entscheidend ist aber die Aufschlüsselung über `memory.stat`: von den 796 MiB des `buildx_buildkit_default` sind nur **19,9 MiB `anon`** (echt belegter, nicht wegwerfbarer Speicher). Der Rest ist Seitencache und Kernel-Slab über den 57,7 GB großen Build-Cache. **Unter Speicherdruck gibt der Kernel das größtenteils zurück** — `docker stats` zeigt hier also einen Betrag, der real, aber weitgehend rückgewinnbar ist.

Praktische Folge: In der Sockelrechnung taucht dieser Posten **zweimal auf** — einmal als „scheinbarer" und einmal als „harter" Sockel (§5.1). Beide Zahlen sind richtig, sie beantworten verschiedene Fragen.

### 2.3 Host-Ebene — was `docker stats` nicht zeigt

| Posten | MiB | Skaliert mit |
|---|---:|---|
| `dockerd` | **223,5** | leicht mit Containerzahl |
| `containerd-shim` (18 Stück) | **131,9** | **direkt: 7,3 MiB je Container** |
| `containerd` | **72,5** | fix |
| `systemd`-Familie (journal, network, resolve, logind, udevd, timesync) | ~**97,5** | fix |
| `multipathd` | 26,5 | fix |
| **Summe Host-Infrastruktur** | **~552** | davon ~420 fix |

**Befund R-02 (P2): `containerd-shim` kostet 7,3 MiB pro Container und taucht in keinem `docker stats` auf.** Bei drei Containern je Tenant+Projekt (`api`, `auth`, `app`) sind das **22 MiB pro Projekt, die in einer naiven Rechnung fehlen** — bei 20 Projekten 440 MiB, also ein halbes GB unsichtbarer Overhead.

### 2.4 Kernel-Speicher

```
Slab:            3.811.588 kB  (3,63 GiB)
  SReclaimable:  3.427.744 kB  (3,27 GiB)   <- rückgewinnbar
  SUnreclaim:      383.844 kB  (0,37 GiB)   <- nicht rückgewinnbar
```

**Befund R-03 (P2): 3,27 GiB rückgewinnbarer Slab-Speicher.** Ursache ist gemessen: **597.109 Dateien** im Buildkit-Cache-Volume. Jede erzeugt Dentry- und Inode-Cache-Einträge. Das ist kein Fehler und kein Leck — der Kernel gibt es unter Druck frei —, aber es erklärt, warum `free -h` mit 5,3 GiB `buff/cache` deutlich voller aussieht, als das System tatsächlich ausgelastet ist. **Als „belegt" zählen muss man nur `SUnreclaim` (375 MiB).**

### 2.5 Sockel-Zusammenfassung

| Sockel-Definition | MiB | Wofür die Zahl taugt |
|---|---:|---|
| **A — scheinbar** (`docker stats` aller geteilten Dienste + Buildkit + Host-Infra + SUnreclaim) | **2.383** | „Wie voll sieht die Maschine aus" |
| **B — hart** (nur `anon` + Postgres-`shmem` + Host-Infra + SUnreclaim) | **~1.470** | **Kapazitätsplanung.** Nur das muss unter Druck wirklich vorhanden sein |

Die Differenz von ~900 MiB ist fast vollständig der Buildkit-Seitencache aus R-01.

---

## 3. Verbrauch pro Tenant und pro Projekt

### 3.1 Was ein Tenant und was ein Projekt architektonisch ist

Das muss vor jeder Zahl stehen, weil die Frage „pro Projekt" sonst falsch beantwortet wird:

- **Kein Tenant bekommt eine eigene Postgres-Instanz.** Alle Tenants teilen sich `core-postgres`; jeder bekommt eine eigene **Datenbank** `kunde_<slug>` mit eigenen Rollen. Der Speicherpreis eines Tenants in Postgres ist also **kein Container**, sondern Backend-Prozesse bei Aktivität.
- **Pro Tenant mit DB** starten **2 Container**: `api-<slug>` (PostgREST) und `auth-<slug>` (GoTrue).
- **Pro Projekt** startet **1 Container**: `app-<slug>` (die Kunden-App aus Nixpacks).
- Ein Tenant kann **mehrere** Projekte haben (`projects.tenant_slug`). Aktuell hat jeder genau eins — deshalb fallen „Tenant" und „Projekt" heute zusammen und müssen für die Skalierung trotzdem getrennt gerechnet werden.

### 3.2 Fixer Verbrauch pro Tenant (Existenz allein, ohne Traffic)

| Container | `sofre` | `up2-site` | Ø | Limit (business) | Auslastung |
|---|---:|---:|---:|---:|---:|
| `api-<slug>` (PostgREST) | 24,9 | 14,8 | **19,9** | 128 | 16 % |
| `auth-<slug>` (GoTrue) | 7,8 | 7,4 | **7,6** | 128 | 6 % |
| `containerd-shim` × 2 | — | — | **14,6** | — | — |
| **Summe pro Tenant** | | | **~42 MiB** | 256 | **16 %** |

Beide Container sind über 5 Minuten **vollkommen stabil** (`auth`: 7,4–8,1 MiB; `api`: 14,1–15,4 bzw. konstant 24,9 MiB). Das ist echter Fixverbrauch: die Container haben während der Messung praktisch nichts getan.

**Auf der Platte** kommt pro Tenant hinzu: eine leere Tenant-DB (Untergrenze ~7,5 MB, gemessen an der `postgres`-Systemdatenbank), ein MinIO-Bucket (**0 Bytes**, solange kein CMS aktiv ist) und ein Verzeichnis `kunden-instances/<slug>/` (wenige KB).

### 3.3 Variabler Verbrauch pro Projekt

| Container | RAM Ø | min | max | Limit | Auslastung |
|---|---:|---:|---:|---:|---:|
| `app-sofre` | **85,4** | 84,9 | 85,4 | 512 | 17 % |
| `app-up2-site` | **246,6** | 228,2 | 252,2 | 512 | 48 % |
| `containerd-shim` × 1 | 7,3 | | | — | |

**Das ist der variable Anteil, und er ist der einzige, der wirklich streut: Faktor 2,9 zwischen zwei Apps derselben Technologie.** Der Kommentar in `lib/deploy.ts:31` benennt den Grund vorab korrekt — ein Next.js-Standalone-Server braucht allein beim Start 150–250 MB, weshalb `starter` von 256m auf 512m angehoben wurde, nachdem es regelmäßig OOM-Kills gab.

Wovon der Wert im Einzelnen abhängt (nicht getrennt messbar, weil n = 2): Größe des Route-Trees und der Server-Komponenten, `revalidate`-Caches, In-Memory-Bildverarbeitung (`sharp`/`libvips` — siehe §4.3), Anzahl gleichzeitiger Requests.

**Datenbank-Anteil pro Projekt (auf der Platte):**

| Datenbank | Größe |
|---|---:|
| `admin_dashboard` | 10.007 kB |
| `kunde_up2-site` | 9.791 kB |
| `kunde_sofre` | 9.487 kB |
| `postgres` (Referenz: praktisch leer) | 7.551 kB |

Nach Abzug der ~7,5 MB Systemgrundlast enthalten beide Tenant-DBs also **rund 2 MB echte Nutzdaten**. Die Datenmenge ist heute **irrelevant** für die Skalierung — und wird es bleiben, solange keine Anwendung mit nennenswertem Datenvolumen dazukommt.

### 3.4 Gemessen vs. zugesagt — die entscheidende Differenz

| | Gemessen (Ø) | Gesetzte Limits | Faktor |
|---|---:|---:|---:|
| Pro Tenant (`api` + `auth`) | 27,5 MiB | 256 MiB | **9,3×** |
| Pro Projekt (`app`, business) | 166,0 MiB | 512 MiB | **3,1×** |
| **Zusammen (1 Tenant + 1 Projekt)** | **193,5 MiB** (+ 21,9 Shims = **215,4**) | **768 MiB** | **3,6×** |

**Befund R-04 (P0 für die Planung): Zwischen Messwert und zugesagtem Limit liegt Faktor 3,6.** Docker-`mem_limit` ist eine **Obergrenze, keine Reservierung** — die Container belegen den Speicher nicht, aber sie **dürfen** ihn jederzeit anfordern. Jede Skalierungsrechnung muss sich entscheiden, welche der beiden Zahlen sie benutzt, und das offenlegen. §5 rechnet **beide**.

### 3.5 CPU

| Ebene | Gemessen (Leerlauf) |
|---|---|
| Host Load Average | 0,00 / 0,03 / 0,01 bei 4 vCPU |
| `api-<slug>` | 0,09 % |
| `auth-<slug>` | 0,01 % |
| `app-<slug>` | 0,00 % |
| `core-postgres` | 2,35 % (davon der größte Teil durch die Messabfragen dieses Berichts selbst) |
| `provisioning-agent` | 2,47 % Ø, **19,71 % Spitze** (Analytics-Ingest-Lauf, minütlich) |

**CPU ist im Normalbetrieb kein limitierender Faktor und wird in §5 nicht als Deckel gerechnet.** Die Summe der gesetzten CPU-Limits (business: `app` 1,0 + `api` 0,5 + `auth` 0,25 = 1,75 vCPU pro Tenant+Projekt) würde rechnerisch bei 2,3 Projekten die 4 vCPU ausschöpfen — aber `cpus` ist in Docker ebenfalls eine **Obergrenze, keine Reservierung**, und der gemessene Leerlaufverbrauch liegt drei Größenordnungen darunter. **Ob CPU unter echter Last bindet, kann dieser Bericht nicht beantworten — das ist genau die Frage des Stresstest-Prompts.**

---

## 4. Ist-Gesamtbild und Engpässe

### 4.1 RAM-Bilanz zum Messzeitpunkt

```
MemTotal          7.938 MiB
  used            2.148 MiB    <- davon 513 MiB das Messwerkzeug selbst
  buff/cache      5.324 MiB    <- überwiegend Slab über den Build-Cache (R-03)
  available       5.615 MiB
Swap                  2.048 MiB, davon 263 MiB belegt
```

Nach Abzug des Messwerkzeugs liegt der **tatsächliche Verbrauch bei 2 Tenants und 2 Projekten bei rund 1,64 GiB — 21 % des Gesamt-RAM.** Die Maschine ist heute weit von jeder Grenze entfernt.

Dass 263 MiB im Swap liegen, ist bei 5,6 GiB `available` **kein Druckindikator**, sondern normales Auslagern lange untätiger Seiten über 31 Tage Uptime.

### 4.2 Platte — der Posten, der tatsächlich wächst

| Posten | Größe | Verwaltet durch |
|---|---:|---|
| **Buildkit Build-Cache** | **57,74 GB** (55,76 GB davon rückgewinnbar) | **nichts** |
| Docker-Images | 18,62 GB (8,27 GB rückgewinnbar) | `pruneOldDockerImages()`, behält 5 je Projekt |
| Docker-Volumes | 13,54 GB (davon `buildx_buildkit_default_state` 15 GB auf Platte) | — |
| Build-Snapshots `deployments/builds/` | 404 MB | `pruneOldBuildSnapshots()`, behält 5 |
| Container-Layer | 167,6 MB | — |
| MinIO-Daten | 1,2 MB (**0 Objekte**) | — |
| Postgres-Daten | 85 MB | — |
| **Gesamt belegt** | **92,9 GB von 250,9 GB (39 %)** | |

**Befund R-05 (P0): Der Buildkit-Build-Cache ist mit 57,7 GB der mit Abstand größte Speicherverbraucher — bei zwei Projekten — und wird von `lib/cleanup.ts` überhaupt nicht angefasst.**

`runCleanup()` (`cleanup.ts:246`) ruft drei Funktionen: `pruneOldBuildSnapshots()`, `pruneOldDockerImages()`, `pruneAnalytics()`. Es gibt **kein** `docker builder prune`. Der Cache wächst mit jedem Deploy monoton weiter. Bei 2 Projekten und ~3 Wochen Betrieb sind 57,7 GB entstanden; das sind grob **29 GB pro Projekt**, und der Wert ist an die **Deploy-Häufigkeit** gekoppelt, nicht an die Projektzahl.

**Nebenbefunde zur Platte:**
- `deployments/builds/` enthält Verzeichnisse für **`sara`, `test2`, `test-app`** — Projekte, die es nicht mehr gibt. `pruneOldBuildSnapshots()` räumt innerhalb eines Projekts auf, entfernt aber keine verwaisten Projektverzeichnisse.
- `docker images` enthält `app-my-test-site`, `app-test-app`, `app-testxadasda`, `testimage` und zwei `<none>`-Images — zusammen mehrere GB aus gelöschten Testprojekten. `pruneOldDockerImages()` arbeitet je bekanntem Projekt und sieht diese nicht mehr.
- Ein einzelnes App-Image ist **1,88–2,3 GB** groß (Nixpacks-Node-Images). Bei der Keep-5-Politik sind das bis zu **~7 GB unique je Projekt**.

### 4.3 OOM-Ereignisse — es gab bereits welche

`journalctl -k` über 30 Tage, zwei Treffer, beide **`CONSTRAINT_MEMCG`** — also am **Container-Limit**, nicht an der Host-RAM-Grenze:

| Datum | Opfer | RSS beim Kill | Limit |
|---|---|---:|---:|
| 02.08. 16:16 | **`uptime-kuma`** | 117,3 MB anon + 60,4 MB file | 128 MiB |
| 03.08. 04:25 | **`next-server`** (Kunden-App, `libvips`-Worker löste aus) | 245,6 MB anon + 87,9 MB file | 512 MiB (heute) |

**Befund R-06 (P1): `uptime-kuma` läuft heute bei 107,5 MiB gegen ein 128-MiB-Limit — 84 % — und wurde an dieser Grenze am 02.08. bereits einmal getötet.** Das ist kein hypothetisches Risiko, sondern ein wiederkehrendes. Da Kuma gleichzeitig der Dienst ist, der Ausfälle melden soll, ist ein stiller OOM-Kill dort besonders unangenehm.
**Empfehlung:** Limit auf 256 MiB anheben. Kosten: 128 MiB von 7.938 — vernachlässigbar gegen den Nutzen.

**Befund R-07 (P2): Der zweite Kill kam aus `libvips`** — der Bildverarbeitung. Das ist der Beleg dafür, dass der App-Container-Verbrauch nicht nur vom Route-Tree abhängt, sondern schlagartig durch **eine einzelne Bildoperation** steigen kann. Für die Skalierung heißt das: der Ø-Wert von 166 MiB beschreibt den Ruhezustand, die relevante Planungsgröße ist die **Spitze**, und die liegt nachweislich bei ≥ 333 MB.

**Positiv:** Der Postgres-OOM-Schutz ist aktiv und wirkt. `core-postgres` hat `oom_score_adj = -900` (gesetzt durch `scripts/protect-postgres-oom.sh` per systemd-Timer), effektiver `oom_score = 70` gegen 671 beim `provisioning-agent` und 668 bei `app-up2-site`. **Bei einem Host-OOM würde der Kernel zuerst den Agent oder eine Kunden-App treffen, nicht die Datenbank aller Kunden.** Genau so ist es gedacht.

### 4.4 Der Deckel, den niemand vermutet: Datenbankverbindungen

| Parameter | Wert | Quelle |
|---|---:|---|
| Postgres `max_connections` | **60** | `pg_settings` |
| davon `superuser_reserved_connections` | 3 | `pg_settings` |
| **nutzbar** | **57** | |
| PgBouncer `POOL_MODE` | `transaction` | Container-Env |
| PgBouncer `DEFAULT_POOL_SIZE` | **5** je (User, DB) | |
| PgBouncer `RESERVE_POOL_SIZE` | +2 unter Druck → **max. 7** | |
| PgBouncer `MAX_DB_CONNECTIONS` | 20 je Datenbank | |
| PgBouncer `MAX_CLIENT_CONN` | 500 (clientseitig, unkritisch) | |
| `MIN_POOL_SIZE` / `SERVER_IDLE_TIMEOUT` | 0 / 120 s | |
| **Aktuell offene Backends** | **6** | `pg_stat_activity` |

**Befund R-08 (P0 für die Skalierung): Das Verbindungsbudget begrenzt die Zahl *gleichzeitig aktiver* Tenants auf etwa 9 — deutlich früher, als der RAM es täte.**

Die Rechnung: `PGRST_DB_POOL=5`, und PostgREST **und** GoTrue eines Tenants verbinden sich beide als `authenticator_<slug>` zur selben `kunde_<slug>` — sie teilen sich also **einen** PgBouncer-Pool von 5 (bis 7) Serververbindungen. Bei ~10 Verbindungen für `admin_dashboard` (Agent und Dashboard öffnen kurzlebige Clients) bleiben 47:

- 47 ÷ 5 = **9,4 → ~9 gleichzeitig aktive Tenants**
- 47 ÷ 7 (mit Reserve-Pool unter Druck) = **6,7 → ~6 unter Last**

**Die entscheidende Entlastung:** `MIN_POOL_SIZE=0` und `SERVER_IDLE_TIMEOUT=120` bedeuten, dass ein Tenant ohne Traffic **null** Serververbindungen hält — heute sichtbar an den 6 offenen Backends bei 2 laufenden Tenants. Der Deckel gilt also für **Gleichzeitigkeit, nicht für die Zahl der bereitgestellten Tenants**. 20 provisionierte Tenants, von denen 8 zeitgleich Traffic haben, funktionieren; 12 zeitgleich aktive laufen in `QUERY_WAIT_TIMEOUT=15s` und liefern 5xx.

**Empfehlung:** `max_connections` von 60 auf 200 anheben. Der Preis in Postgres 16 sind grob 2–4 MB je zusätzlichem möglichen Backend-Slot an Shared Memory und ein größerer Prozess-Table — bei 7,75 GiB RAM tragbar und um Größenordnungen billiger als die Alternative (`DEFAULT_POOL_SIZE` senken, was jeden einzelnen Tenant langsamer macht). Vorher im Stresstest verifizieren, dass 15–20 gleichzeitige Backends die 4 vCPU nicht überfahren.

---

## 5. Skalierungsgrenze

### 5.1 Sockelbudget

Sicherheitspuffer: geplant wird bis **80 % des RAM**, entsprechend der Aufgabenstellung.

```
Gesamt-RAM                        7.938 MiB
Planungsgrenze (80 %)             6.350 MiB
```

Zwei Sockelvarianten, je nachdem ob die Build-Infrastruktur bleibt:

| Posten | Variante 1 (Ist) | Variante 2 (Buildkit aufgeräumt) |
|---|---:|---:|
| Geteilte Dienste (§2.1) | 652 | 652 |
| Buildkit-Container (§2.2) | 804 | **0** ¹ |
| Host-Infrastruktur, fixer Teil (§2.3) | 420 | 420 |
| Kernel `SUnreclaim` (§2.4) | 375 | ~150 ² |
| **Sockel** | **2.251** | **1.222** |
| **Für Tenants/Projekte verfügbar** | **4.099** | **5.128** |

¹ Buildkit-Container laufen nur während eines Builds; ein `docker buildx rm` plus On-Demand-Builder gibt den Dauerposten frei.
² `SUnreclaim` sinkt mit der Zahl der Dateien im Cache (597.109 heute, R-03) — geschätzt, nicht gemessen.

### 5.2 Vier Modelle

Alle Zahlen für den heutigen Standardfall **1 Tenant = 1 Projekt, Tarif `business`, mit DB, ohne CMS**.

#### Modell A — nach gemessenem Ist-Verbrauch

Kosten je Tenant+Projekt: 27,5 (api+auth) + 166,0 (app, Ø) + 21,9 (3 Shims) = **215,4 MiB**

| | Variante 1 | Variante 2 |
|---|---:|---:|
| 4.099 ÷ 215,4 | **19 Projekte** | |
| 5.128 ÷ 215,4 | | **23 Projekte** |

⚠️ **Hochrechnung.** Beruht auf dem Mittelwert aus **zwei** App-Containern, die um Faktor 2,9 auseinanderliegen. Zwanzig Apps vom Typ `up2-site` (246,6 MiB) ergäben stattdessen **13 Projekte**, zwanzig vom Typ `sofre` (85,4 MiB) **31**.

#### Modell B — nach gesetzten Limits (OOM-sicher)

Kosten je Tenant+Projekt: 128 + 128 + 512 + 21,9 = **789,9 MiB**

| | Variante 1 | Variante 2 |
|---|---:|---:|
| 4.099 ÷ 789,9 | **5 Projekte** | |
| 5.128 ÷ 789,9 | | **6 Projekte** |

Das ist die Zahl, bei der **garantiert** kein Host-OOM auftreten kann, selbst wenn jeder Container sein Limit voll ausschöpft. Sie ist konservativ bis zur Unbrauchbarkeit — kein Betreiber plant so —, aber sie ist die einzige, die eine echte Garantie trägt.

#### Modell C — Verbindungsbudget (§4.4)

**~9 gleichzeitig aktive Tenants**, unabhängig vom RAM. Bei `max_connections=200` steigt das auf **~38**.

#### Modell D — Platte

Bei 147,7 GB frei:

| Annahme | Kapazität |
|---|---:|
| ~7 GB Images je Projekt (Keep-5), Build-Cache **gedeckelt** auf ~20 GB | **~18 Projekte** |
| Build-Cache bleibt **ungedeckelt** (heute: 57,7 GB bei 2 Projekten) | **Platte läuft vor dem RAM voll** |

### 5.3 Empfohlene Planungszahl

| Szenario | Grenze | Bindender Faktor |
|---|---:|---|
| **Heute, ohne jede Änderung** | **8–10 Projekte** | Platte (R-05, ungedeckelter Build-Cache) — nicht RAM |
| **Nach Deckelung des Build-Cache** | **12–15 Projekte** | RAM nach Modell A, konservativ am oberen App-Verbrauch gerechnet |
| **Zusätzlich `max_connections` erhöht + Buildkit on-demand** | **18–20 Projekte** | RAM; Verbindungen sind dann kein Deckel mehr |
| **Harte Obergrenze bei voller Limit-Ausschöpfung** | **5–6 Projekte** | Modell B, nur relevant, wenn alle Apps gleichzeitig ihr Limit ausreizen |

**Die empfohlene Planungszahl für die nächsten Monate ist 12 Projekte** — mit der Auflage, dass R-05 (Build-Cache) vorher behoben ist. Diese Zahl liegt bewusst unterhalb von Modell A: sie lässt Raum für den in §4.3 belegten Fall, dass ein einzelner App-Container durch eine Bildoperation kurzzeitig auf das Dreifache seines Ruhewerts springt.

**Was diese Zahlen nicht beantworten:** Ob 12 Projekte auch **unter Last** laufen. Alle Messungen stammen aus einem System mit Load Average 0,00. CPU-Sättigung, PgBouncer-Warteschlangen und der RAM-Bedarf gleichzeitiger Requests sind Gegenstand des Stresstests, nicht dieses Berichts.

### 5.4 Der teuerste Einzelfall: ein gleichzeitiger Deploy

Nicht in den Modellen enthalten, aber betrieblich entscheidend: Ein **Nixpacks-Build fordert 1–2 GB** (`TESTPLAN.md` TC-DEPL-08). Bei 12 laufenden Projekten nach Modell A (2.585 MiB) plus Sockel (2.251 MiB) sind 4.836 MiB belegt — ein 2-GB-Build passt in die verbleibenden 3.102 MiB, **ein zweiter gleichzeitiger Build nicht mehr**.

Da `oom_score_adj` nur für Postgres gesetzt ist (§4.3), träfe der Kernel bei Host-OOM den Prozess mit dem höchsten Score — und das ist heute der `provisioning-agent` (671) oder eine **Kunden-App** (668). **Empfehlung: Deploys serialisieren** (ein globaler Advisory Lock analog zu dem, der bereits `POST /tenants` schützt) — das ist billiger und wirksamer als mehr RAM.

---

## 6. Monitoring-Empfehlung

### 6.1 Was fehlt

Dieser Bericht ist eine **Momentaufnahme von fünf Minuten im Leerlauf**. Für die Skalierungsentscheidung braucht es Zeitreihen: Wächst `app-up2-site` über Wochen? Wann treffen Lastspitzen zusammen? Wie viele PgBouncer-Verbindungen sind gleichzeitig in Benutzung?

### 6.2 Empfehlung: **nicht** cAdvisor + Prometheus + Grafana

Der naheliegende Stack ist für diese Maschine der falsche:

| Komponente | RAM-Bedarf | Bewertung |
|---|---:|---|
| cAdvisor | 150–300 MiB | bekannt speicherhungrig, liest permanent alle cgroups |
| Prometheus | 400 MiB – 1 GiB | TSDB im Speicher, wächst mit Kardinalität |
| Grafana | 150–250 MiB | |
| **Summe** | **~700 MiB – 1,5 GiB** | **entspricht 3–7 Kundenprojekten nach Modell A** |

**Ein Monitoring-Stack, der 10–19 % des zu überwachenden RAM verbraucht und dabei die Kapazität um mehrere zahlende Projekte senkt, ist auf einer 8-GB-VPS die falsche Antwort.** Er wäre außerdem selbst ein OOM-Kandidat und würde genau dann ausfallen, wenn er gebraucht wird.

### 6.3 Empfehlung: schlanke Variante in drei Stufen

**Stufe 1 — Sampler ins Repo (empfohlen, sofort):**
Ein Cron-Job, der minütlich `docker stats --no-stream` plus `free`, `df` und `pg_stat_activity` in eine Postgres-Tabelle schreibt. Aufwand: ein Shell-Skript und eine Migration. RAM-Kosten: **null** (läuft, schreibt, endet). Die Tabelle ist mit derselben Retention-Mechanik aufräumbar, die `lib/cleanup.ts` schon für `analytics_*` benutzt — und `analytics_daily` zeigt bereits, dass Aggregate über zwei Jahre in dieser Datenbank kaum Platz kosten. Das Dashboard hat unter `/api/stats/*` bereits die Route-Struktur, um das anzuzeigen.

**Stufe 2 — vorhandene Bausteine zu Ende bringen (empfohlen, billig):**
- **`kuma_monitor_id` ist für beide Projekte `NULL`** (§0.1) — die Monitore werden nicht angelegt. Das zu reparieren kostet nichts an Ressourcen und bringt die Ausfallerkennung, die eigentlich schon da sein sollte.
- **Traefik-Metriken freischalten:** `--entrypoints.metrics.address=:8082` plus `--metrics.prometheus.entryPoint=metrics`. Zwei Zeilen; danach sind Request-Raten und Latenzen je Router abrufbar — auch ohne Prometheus, per `curl` durch den Sampler aus Stufe 1.
- **Alarmschwellen** an den vorhandenen Resend-Alarm hängen: Container > 85 % seines Limits (hätte `uptime-kuma` **vor** dem Kill vom 02.08. gemeldet), Platte > 80 %, `pg_stat_activity` > 40.

**Stufe 3 — erst bei Bedarf:**
Wenn die Aggregate aus Stufe 1 nicht mehr reichen, ist **Netdata** (~100–150 MiB, ein Container, Container-Metriken out of the box) die passendere Wahl als der Prometheus-Stack. Oder — wenn die Zahl der Projekte tatsächlich Richtung 15+ geht — Prometheus **extern**, auf einer separaten kleinen Instanz, die die VPS nur abfragt statt auf ihr zu leben.

### 6.4 Was zuerst

Der wirksamste Schritt ist **kein Monitoring**, sondern R-05: `docker builder prune --filter until=168h` in `runCleanup()`. Das gibt sofort bis zu 55,76 GB Platte frei, entlastet nebenbei 3,27 GiB Kernel-Slab (R-03) und beseitigt den heute bindenden Skalierungsfaktor. Erst danach lohnt es, den Rest zu vermessen.

---

## 7. Befundliste

| ID | P | Befund | Empfehlung |
|---|---|---|---|
| **R-05** | **P0** | Buildkit-Build-Cache 57,74 GB (55,76 GB rückgewinnbar), von `lib/cleanup.ts` **nicht** verwaltet — heute der bindende Skalierungsfaktor | `docker builder prune --filter until=168h` in `runCleanup()` aufnehmen |
| **R-08** | **P0** | Verbindungsbudget deckelt bei **~9 gleichzeitig aktiven Tenants** (`max_connections=60`, Pool 5/Tenant), lange vor dem RAM | `max_connections` auf 200; im Stresstest gegen 4 vCPU verifizieren |
| **R-04** | **P0** | Gesetzte Limits sind Faktor 3,6 über dem Messwert — jede Planungszahl muss offenlegen, welche Basis sie nutzt | beide Modelle führen (§5.2); Limits nicht senken, ohne R-07 zu bedenken |
| **R-06** | **P1** | `uptime-kuma` bei 84 % seines 128-MiB-Limits, **am 02.08. bereits OOM-getötet** — ausgerechnet der Alarmdienst | Limit auf 256 MiB |
| **R-01** | **P1** | Buildkit-Container binden 804 MiB Dauer-RAM (davon nur 27 MiB `anon`) — mehr als alle geteilten Dienste zusammen | Builder on-demand statt dauerhaft; gibt ~1 GB Planungsbudget frei |
| **R-09** | **P1** | Kein `oom_score_adj` außer für Postgres; bei Host-OOM trifft es `provisioning-agent` (671) oder eine **Kunden-App** (668) | Kunden-Apps auf negativen Score, Buildkit auf positiven; **oder** Deploys serialisieren (§5.4) |
| **R-10** | **P1** | Verwaiste Artefakte gelöschter Projekte: Snapshot-Verzeichnisse `sara`/`test2`/`test-app`, Images `app-my-test-site`/`app-test-app`/`app-testxadasda`/`testimage` + zwei `<none>` | Cleanup um einen Abgleich gegen die `projects`-Tabelle erweitern |
| **R-11** | **P1** | Kein Kuma-Monitor angelegt (`kuma_monitor_id` beide `NULL`), obwohl `lib/monitoring.ts` das vorsieht | reparieren — kostet keine Ressourcen |
| **R-07** | P2 | App-Container-Verbrauch springt durch einzelne Bildoperationen (`libvips`-OOM am 03.08. bei 333 MB) — der Ø von 166 MiB beschreibt nur den Ruhezustand | Spitzenwert, nicht Mittelwert planen; im Stresstest quantifizieren |
| **R-02** | P2 | `containerd-shim` kostet 7,3 MiB/Container und erscheint in keinem `docker stats` — 22 MiB je Projekt | in Kapazitätsrechnungen einkalkulieren (hier geschehen) |
| **R-03** | P2 | 3,27 GiB rückgewinnbarer Kernel-Slab durch **597.109** Dateien im Build-Cache; lässt `free -h` voller aussehen als das System ist | löst sich mit R-05 |
| **R-12** | P2 | Traefik-Prometheus-Metriken werden erzeugt, aber von keinem Entrypoint ausgeliefert | zwei Zeilen (§6.3) |
| **R-13** | P3 | `cloudflared` ohne `mem_limit` als einziger Dienst | 128 MiB setzen (misst 15,4 MiB) |

---

## 8. Reproduzierbarkeit der Messung

```bash
# VPS-Spezifikation
free -h; nproc; lscpu; df -h /; swapon --show; cat /proc/loadavg

# Zeitreihe (10 Stichproben, 30 s Abstand)
for i in $(seq 1 10); do
  docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}'
  sleep 30
done

# anon vs. Seitencache je Container (die belastbarere Zahl)
for c in $(docker ps --format '{{.Names}}'); do
  id=$(docker inspect -f '{{.Id}}' "$c")
  awk -v c="$c" '/^anon /{a=$2}/^file /{f=$2}/^shmem /{s=$2}
    END{printf "%-34s anon=%.1f file=%.1f shmem=%.1f MiB\n",c,a/1048576,f/1048576,s/1048576}' \
    "/sys/fs/cgroup/system.slice/docker-$id.scope/memory.stat"
done

# Host-Overhead, den docker stats nicht zeigt
ps -eo rss,comm --sort=-rss --no-headers | head -20
ps -eo rss,comm --no-headers | awk '$2=="containerd-shim"{n++;s+=$1} END{print n" Shims, "s/1024" MiB"}'

# Gesetzte Limits
for c in $(docker ps --format '{{.Names}}'); do
  docker inspect -f '{{.Name}} mem={{.HostConfig.Memory}} cpus={{.HostConfig.NanoCpus}}' "$c"
done

# Platte
docker system df; docker builder du; du -sh /var/lib/docker/volumes/*

# Verbindungsbudget
docker exec core-postgres psql -U postgres -Atc \
  "SELECT name,setting FROM pg_settings WHERE name IN ('max_connections','superuser_reserved_connections');"
docker exec core-postgres psql -U postgres -Atc "SELECT count(*) FROM pg_stat_activity;"
docker inspect pgbouncer -f '{{range .Config.Env}}{{println .}}{{end}}' | grep POOL

# OOM-Historie
journalctl -k --since "30 days ago" | grep -i 'oom\|killed process'
for c in core-postgres provisioning-agent app-up2-site; do
  pid=$(docker inspect -f '{{.State.Pid}}' $c)
  echo "$c oom_score_adj=$(cat /proc/$pid/oom_score_adj) oom_score=$(cat /proc/$pid/oom_score)"
done
```

**Alle Befehle sind rein lesend.** Es wurde keine künstliche Last erzeugt, kein Container gestartet oder gestoppt, keine Konfiguration geändert. Einziger Seiteneffekt: ein `curlimages/curl`-Image wurde für einen Erreichbarkeitstest geladen und danach wieder entfernt.
