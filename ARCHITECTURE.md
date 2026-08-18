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

## Docker-Sicherheitsmodell

Der Provisioning Agent hat **keinen direkten Zugriff** auf `/var/run/docker.sock`.
Stattdessen läuft ein `docker-socket-proxy` (Tecnativa) dazwischen, der nur
folgende API-Gruppen freischaltet: `CONTAINERS`, `IMAGES`, `NETWORKS`, `VOLUMES`,
`BUILD`, `POST`, `INFO`, `PING`, `EXEC`. Alles andere (Swarm, Secrets, Configs,
Nodes, System, Plugins) ist deaktiviert. `EXEC` ist bewusst aktiviert, weil der
Buildx-Builder-Container es für den Build-Prozess benötigt — das ist eine
bewusst in Kauf genommene, im Vergleich zum vollen Socket aber stark
eingeschränkte Rechteausweitung.

## Auth-Modell

- **Dashboard:** Single-Admin, NextAuth-Credentials-Login (bcrypt-Hash aus `.env`),
  Middleware schützt `/dashboard/*` und `/api/tenants/*`.
- **Provisioning Agent:** Shared-Secret-Header (`X-Agent-Secret`), nur vom
  Dashboard-Backend intern aufgerufen (nicht öffentlich geroutet, außer
  `/webhooks/*`, die eigene HMAC-Verifikation haben).
- **Pro Tenant:** eigene GoTrue-Instanz mit eigenem JWT-Secret — Tenants sind
  vollständig voneinander isoliert, kein gemeinsames Auth-System.
