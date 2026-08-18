# Architektur-Übersicht

## Module

```
multitenant-platform/
├── dashboard/              Next.js Admin-UI — Tenant-Verwaltung, Table/SQL-Editor,
│                           Deployment-Historie, Domain-/Env-Verwaltung, Audit-Log
│                           Auth: NextAuth v5 (Credentials, Single-Admin)
│
├── provisioning-agent/     Node/Express-Backend — der eigentliche "Motor":
│                           - Tenant anlegen/löschen (DB, Auth, Storage)
│                           - Deployment-Pipeline (GitHub-Webhook → Build → Deploy)
│                           - Domain-/TLS-Management (Traefik-Dynamic-Config)
│                           - Backup-Steuerung, Monitoring-Integration
│                           Auth: X-Agent-Secret-Header (nur vom Dashboard/intern erreichbar)
│
├── core-postgres/          Zentrale Postgres-Instanz + PgBouncer davor.
│                           init-scripts/ = versionierte SQL-Migrationen (Rollen,
│                           Admin-Schema, Audit-Logs, Backups, Monitoring, Previews)
│
├── cms/                    Next.js-Dienst für die ENDKUNDEN: Inhalte pflegen,
│                           Bilder hochladen. Ein Dienst für alle Tenants,
│                           Mandant kommt aus der Sitzung. Verbindet sich mit
│                           eingeschränkten Rollen (cms_config / cms_<slug>),
│                           nie als Superuser. Entwurf: docs/CMS-PLAN.md
│
├── minio/                  S3-kompatibler Object Storage, ein Bucket pro Tenant
├── traefik/                Reverse Proxy + automatisches TLS (Let's Encrypt, DNS-01)
│                           logs/access.log = JSON-Accesslog, Quelle der Analytics
├── cloudflared/             Cloudflare Tunnel für Admin-Zugriff ohne offenen Port
├── monitoring/uptime-kuma/  Uptime-Monitoring pro Projekt/Tenant
├── backups/                 Backup- und Restore-Test-Skripte (age + rclone)
├── deployments/             Laufzeit-Verzeichnis für Build-Artefakte (gitignored)
├── scripts/                 Betriebsskripte: redeploy.sh (ausrollen), migrate.sh,
│                            smoke-test.sh, write-ratelimit.sh
├── docs/                    OPERATIONS.md (Betrieb), CMS-PLAN.md (Entwurf)
└── bootstrap.sh              Onboarding-Skript für frischen Server
```

## Datenfluss: Tenant-Erstellung

```
Dashboard (POST /api/provision-tenant)
   │  X-Agent-Secret
   ▼
Provisioning Agent (POST /tenants)   { withDatabase: true | false }
   ├─ nur wenn withDatabase (lib/tenantDatabase.ts):
   │   ├─ CREATE DATABASE kunde_<slug>       (core-postgres, via PgBouncer)
   │   ├─ CREATE ROLE authenticator_<slug>   (eingeschränkte Rolle für PostgREST/GoTrue)
   │   └─ Docker: Container für GoTrue + PostgREST starten
   │       (Ressourcen-Limits nach Tarif, Healthchecks, eigenes Compose-Template)
   ├─ MinIO: Bucket + IAM-User + Policy anlegen   (immer — kostet keinen Container)
   └─ AES-256-GCM: Secrets (JWT, MinIO-Key) verschlüsselt in `kunden`-Tabelle ablegen
```

Die Datenbank-Ebene ist optional und nachträglich schaltbar
(`POST /tenants/:slug/database`, Migration 19). Zwei Flags in `kunden`:
`db_provisioned` (Datenbank existiert — wird nie wieder false, solange der Tenant
existiert) und `db_enabled` (Container sollen laufen). Abschalten ist ein
`docker compose down`: RAM frei, Daten unangetastet, Tabellen- und SQL-Editor im
Dashboard funktionieren weiter (die verbinden direkt über PgBouncer, nicht über
PostgREST).

## Datenfluss: Deployment (Push-to-Deploy)

```
GitHub Push
   │  HMAC-SHA256-signierter Webhook
   ▼
Provisioning Agent (POST /webhooks/github/:projectId)
   │  Router wird unter dem Prefix '/webhooks' gemountet, die Route darin heisst
   │  deshalb '/github/:projectId'. Stand dort der volle Pfad, lag der Endpunkt
   │  effektiv unter /webhooks/webhooks/... und GitHub bekam 401 — Push loeste
   │  dann nie ein Deployment aus.
   ├─ Signatur gegen rohen Body verifizieren (express.raw, nicht express.json!)
   ├─ Nur reagieren, wenn Ziel-Branch == default_branch
   ├─ Repo klonen, Nixpacks-Build ausführen
   ├─ Deploy-Swap: Kandidatencontainer hochfahren, Healthcheck abwarten,
   │  alten Container parken, neuen mit öffentlichem Namen + Labels starten,
   │  erneut Healthcheck; bei Fehlschlag den geparkten wiederherstellen.
   │  (Bewusst NICHT als Blue-Green bezeichnet — es gibt eine kurze Downtime
   │  zwischen Umbenennen und Gesundwerden, siehe Audit §10.)
   └─ Deployment-Log live ins Dashboard (Polling) + Rollback-Option
```

## Datenfluss: Besucher-Analytics

```
Besucher  ──▶  Traefik  ──▶  Kunden-Container
                  │
                  └─ schreibt JSON-Zeile nach traefik/logs/access.log
                         │
                         ▼
              Provisioning Agent (lib/analytics.ts, jede Minute)
                 ├─ liest ab gemerktem Byte-Offset (analytics_ingest_state)
                 ├─ verwirft Assets, Bots und die eigene Uptime-Überwachung
                 ├─ ordnet RequestHost über `domains` einem Projekt zu
                 ├─ Besucher = HMAC(Tages-Salt, IP + User-Agent + Host)
                 │    IP = Cf-Connecting-Ip, ersatzweise ClientHost
                 └─ schreibt Aggregate: analytics_daily / _page_views /
                    _referrers / _visitors
                         │
                         ▼
              Dashboard-Tab „Besucher" (GET /analytics/:projectId)
```

Bewusst am Proxy statt per Tracking-Script in der Kunden-App: kein Eingriff in
Kundencode, nicht durch Adblocker abschaltbar, funktioniert auch für rein
statische Seiten. Der Preis ist, dass clientseitige Navigation (SPA-Routenwechsel
ohne neuen Request) nicht gezählt wird.

Steht Cloudflare vor der Plattform — der Regelfall —, ist `ClientHost` im Accesslog
die IP eines Cloudflare-Edge und nicht die des Besuchers. Traefik behält deshalb den
Header `Cf-Connecting-Ip`, und die Auswertung nimmt ihn, wenn er da ist. Ohne diesen
Umweg zählt die Statistik Rechenzentren statt Menschen: ein Fehler, der keine
Fehlermeldung erzeugt und dessen Zahlen trotzdem plausibel aussehen.

Datenschutz: keine IP, kein User-Agent wird gespeichert. Das Salt des
Besucher-Hashes wechselt täglich, ein Besucher ist also innerhalb eines Tages
wiedererkennbar und darüber hinaus nicht. Entsprechend ist „Besucher" über einen
Zeitraum die Summe der Tageswerte, nicht die Zahl unterschiedlicher Personen.

## Datenfluss: CMS (Endkunden-Redaktion)

```
Betreiber im Dashboard (Tab „CMS")
   ├─ CMS aktivieren  ──▶ Agent: CREATE ROLE cms_<slug>, Passwort verschlüsselt
   │                       (CMS_ENCRYPTION_KEY, NICHT der Master-Key)
   ├─ Tabelle freigeben ─▶ cms_collections + cms_fields (aus dem Schema vorbelegt)
   │                       Agent: GRANT SELECT,INSERT,UPDATE,DELETE auf GENAU diese Tabelle
   └─ Zugang anlegen  ──▶ cms_users (bcrypt)

Endkunde auf cms.<PLATFORM_DOMAIN>/<slug>
   ├─ Anmeldung → Sitzungs-Cookie (JWT, HS256) mit tenant_slug
   ├─ Liste/Formular werden aus cms_fields gebaut, nie aus dem Request
   ├─ Schreiben als Rolle cms_<slug> über PgBouncer in kunde_<slug>
   └─ Upload → Neukodierung (EXIF weg) → MinIO public/… → URL im Textfeld
```

Zwei Grenzen, die bewusst doppelt gezogen sind: die Anwendung schreibt nur in
Tabellen, die als Collection konfiguriert sind, **und** die Datenbankrolle hat
auf nichts anderes Rechte. Ein Fehler in der einen Schicht öffnet nicht die
andere — insbesondere ist `auth.*` (die GoTrue-Nutzer des Kunden) für das CMS
grundsätzlich unerreichbar.

Nicht dasselbe wie der Tabellen-Editor im Dashboard: der verbindet sich als
`postgres`-Superuser und ist Betreiberwerkzeug. Der CMS-Dienst läuft deshalb als
eigener Prozess mit eigenen Zugangsdaten, auch wenn dadurch etwas Code doppelt
existiert.

## Netzwerkmodell

```
traefik-net          Traefik ↔ Plattformdienste (Dashboard, CMS, MinIO, Agent)
docker-proxy-net     Agent ↔ docker-socket-proxy — sonst niemand
app-<slug>-net       Traefik + Agent + MinIO + api-<tenant> + auth-<tenant>
                     + der App-Container des Projekts
```

Ein Netz pro Projekt statt eines gemeinsamen: der Container eines Kunden kann so die
Dienste eines anderen nicht einmal adressieren, unabhängig von Zugangsdaten.

Die Zugehörigkeit zu `app-<slug>-net` entsteht beim Deploy (`ensureProjectNetwork`)
und ist **reiner Laufzeit-Zustand des Docker-Daemons** — sie steht in keiner
`docker-compose.yml`. Wird Traefik, der Agent oder MinIO neu erstellt, baut Docker
deren Netze aus der Compose-Datei neu auf, und die Projektnetze fehlen danach.
Traefik kennt den Router dann weiterhin, erreicht den Container aber nicht: 504 auf
jeder Kundenseite, ohne eine einzige Fehlermeldung. Der Agent stellt die
Verbindungen deshalb bei jedem Start für alle Projekte wieder her.

## Rate-Limiting

Vier Ebenen, jede an der Stelle, an der die jeweilige Ressource knapp wird:

| Ebene | Grenze | Was geschützt wird |
|---|---|---|
| Traefik → Kundenseiten | 50 req/s, Burst 100 | Bandbreite, CPU der App-Container |
| Traefik → Kunden-APIs | 20 req/s, Burst 40 | die von allen Mandanten geteilte Datenbank |
| Provisioning Agent | global / Webhooks / sensible Operationen getrennt | Provisionierung, Deployments |
| CMS | Login 10/min pro IP, Upload 30/min und Schreibvorgänge 60/min pro Konto | bcrypt- und sharp-Last im gemeinsamen Dienst |

Zwei Entscheidungen dahinter, beide aus einem Lasttest gelernt:

**Geschlüsselt wird auf `Cf-Connecting-Ip`, nicht auf die TCP-Gegenstelle.** Hinter
Cloudflare ist letztere immer eine von wenigen Edge-IPs; ein Limit darauf verteilt
sich auf Dutzende Töpfe und greift nicht. Messbar: 600 Anfragen in fünf Sekunden
gegen ein 20/s-Limit kamen zu 576 durch. Nach der Umstellung sind es 137 — der
rechnerische Wert aus Burst plus Rate.

**Die Middlewares hängen an den einzelnen Routern, nicht am Entrypoint.** Am
Entrypoint wäre es bequemer und würde auch bestehende Container erfassen. Aber ein
Router, dessen Middleware nicht auflöst, wird von Traefik komplett verworfen — der
Fehlerfall wäre „alle Seiten offline" statt „nicht gebremst". Für eine
Schutzmaßnahme ist das die falsche Richtung. Damit die Bremse trotzdem überall
ankommt, schreibt der Agent alle Router-Dateien bei jedem Start neu.

## Docker-Sicherheitsmodell

Der Provisioning Agent spricht für den Normalbetrieb nicht direkt mit
`/var/run/docker.sock`, sondern über einen `docker-socket-proxy` (Tecnativa) in
einem eigenen `internal`-Netzwerk, das sonst niemand betritt. Freigeschaltet sind
`CONTAINERS`, `IMAGES`, `NETWORKS`, `BUILD`, `POST`, `INFO`, `PING`; `EXEC` und
`VOLUMES` sind aus, ebenso Swarm, Secrets, Configs, Nodes, System und Plugins.

Zur ehrlichen Einordnung, weil die Flag-Liste mehr verspricht, als sie hält: der
Proxy filtert nach Pfad und Methode, nicht nach Request-Body. `POST` zusammen mit
`CONTAINERS` erlaubt es, einen Container mit beliebigen Mounts zu starten — das ist
für sich genommen root-äquivalent. Die wirksame Grenze ist die Netzwerktrennung
(nur der Agent erreicht den Proxy), nicht die Flags.

Eine Ausnahme gibt es: der Nixpacks-Build braucht eine bidirektionale Session zum
Daemon (HTTP-Upgrade auf einen gRPC-Stream), die ein HAProxy-basierter Proxy
strukturell nicht durchreichen kann — er antwortet mit `403 unable to upgrade to
tcp`. Ausschließlich der Build-Prozess läuft deshalb über den rohen Socket, alle
übrigen Docker-Aufrufe unverändert über den Proxy.

## Auth-Modell

- **Dashboard:** Single-Admin, NextAuth-Credentials-Login (bcrypt-Hash aus `.env`),
  Middleware schützt `/dashboard/*` und `/api/tenants/*`.
- **Provisioning Agent:** Shared-Secret-Header (`X-Agent-Secret`), nur vom
  Dashboard-Backend intern aufgerufen (nicht öffentlich geroutet, außer
  `/webhooks/*`, die eigene HMAC-Verifikation haben).
- **Pro Tenant:** eigene GoTrue-Instanz mit eigenem JWT-Secret — Tenants sind
  vollständig voneinander isoliert, kein gemeinsames Auth-System.
- **CMS (Redakteure):** eigenes Sitzungs-Cookie (JWT, HS256, 8 Stunden), bewusst
  nicht NextAuth — dort gibt es genau einen Admin aus der `.env`, hier beliebig
  viele Nutzer aus der Datenbank, jeder an genau einen Mandanten gebunden. Der
  Mandant kommt ausschließlich aus der Sitzung, nie aus der URL.

  Das Cookie allein ist kein Zugang: bei jedem Aufruf wird gegen `cms_users`
  geprüft, ob das Konto noch existiert und nicht gesperrt ist, und Name, Adresse
  und Rolle kommen aus der Datenbank statt aus dem Token. Ohne diese Prüfung
  bliebe ein gelöschter Redakteur bis zum Ablauf des Tokens arbeitsfähig — und
  auffallen würde es erst an der einzigen Stelle mit Fremdschlüssel auf
  `cms_users`: dem Bild-Upload, mit einer Datenbankmeldung, die niemandem hilft.
