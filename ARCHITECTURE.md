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
├── minio/                  S3-kompatibler Object Storage, ein Bucket pro Tenant
├── traefik/                Reverse Proxy + automatisches TLS (Let's Encrypt, DNS-01)
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
Provisioning Agent (POST /tenants)
   ├─ CREATE DATABASE kunde_<slug>          (core-postgres, via PgBouncer)
   ├─ CREATE ROLE authenticator_<slug>       (eingeschränkte Rolle für PostgREST/GoTrue)
   ├─ MinIO: Bucket + IAM-User + Policy anlegen
   ├─ AES-256-GCM: Secrets (JWT, MinIO-Key) verschlüsselt in `kunden`-Tabelle ablegen
   └─ Docker: Container für GoTrue + PostgREST starten
       (Ressourcen-Limits nach Tarif, Healthchecks, eigenes Compose-Template)
```

## Datenfluss: Deployment (Push-to-Deploy)

```
GitHub Push
   │  HMAC-SHA256-signierter Webhook
   ▼
Provisioning Agent (POST /webhooks/github/:projectId)
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
