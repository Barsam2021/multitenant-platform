# MultiTenant Platform

Selbstgehostete Alternative zu Supabase/Vercel für mehrere Kunden (Tenants) auf einer
einzigen VPS — inklusive eigenem Verwaltungs-Dashboard, automatisiertem Deployment
(GitHub → laufender Container) und Backup-System.

> **Status:** Portfolio-/Showcase-Projekt. Zeigt den vollständigen Aufbau einer
> Multi-Tenant-Infrastruktur inkl. Provisioning, Deployment-Pipeline, Monitoring und
> Security-Hardening. Kein aktiv betreuter Community-Support, keine offene
> Contribution-Pipeline — siehe [CONTRIBUTING.md](./CONTRIBUTING.md) und
> [LICENSE](./LICENSE).

## Was das Projekt macht

Jeder Tenant (Kunde) bekommt automatisiert:

- eine eigene PostgreSQL-Datenbank (über zentralen PgBouncer-Pool)
- eigene PostgREST- und GoTrue-Instanz (Auth), analog zu Supabase
- eigenen MinIO-Bucket mit eigenen IAM-Credentials (S3-kompatibler Storage)
- eine eigene Deployment-Pipeline: GitHub-Repo verbinden → Push löst automatisch
  einen Build (Nixpacks) und Blue-Green-Deploy auf einer eigenen Subdomain aus,
  inkl. Rollback-Funktion
- automatisches TLS über Traefik + Let's Encrypt (DNS-01 via Cloudflare)
- Uptime-Monitoring (Uptime Kuma) und verschlüsselte, automatisierte Backups
  (age-Verschlüsselung → Object Storage via rclone)

Verwaltet wird alles über ein zentrales Next.js-Dashboard mit Tenant-Verwaltung,
Table-/SQL-Editor, Deployment-Historie mit Live-Logs, Domain- und
Environment-Variable-Verwaltung sowie Audit-Log.

## Tech-Stack

| Bereich | Technologie |
|---|---|
| Dashboard | Next.js 15 (App Router), React 19, TypeScript, NextAuth v5 |
| Provisioning Agent | Node.js/TypeScript, Express, direkte Docker-API-Steuerung |
| Datenbank | PostgreSQL (zentral) + PgBouncer, pro Tenant eigene DB |
| Auth (pro Tenant) | GoTrue |
| REST-API (pro Tenant) | PostgREST |
| Storage | MinIO (S3-kompatibel), pro Tenant eigener Bucket + IAM-Key |
| Reverse Proxy / TLS | Traefik, Let's Encrypt via Cloudflare DNS-01 |
| Deployment-Builds | Nixpacks (Buildpack-artiges Build-System) |
| Monitoring | Uptime Kuma |
| Backups | `age`-Verschlüsselung + `rclone` (Object Storage, z. B. Hetzner Storage Box) |
| Tunnel | Cloudflare Tunnel (Admin-Zugriff ohne offenen Port) |

## Architektur

Siehe [ARCHITECTURE.md](./ARCHITECTURE.md) für eine Übersicht der Module und
wie die Services zusammenspielen.

## Lokal/auf eigenem Server ausprobieren

Für eine vollständige, reproduzierbare Einrichtung von 0 auf einem frischen
Ubuntu/Debian-Server siehe [SETUP.md](./SETUP.md). Kurzfassung:

```bash
git clone <this-repo> /opt/multitenant-platform
cd /opt/multitenant-platform
cp .env.example .env
nano .env                 # echte Werte eintragen
sudo ./bootstrap.sh
```

**Wichtig:** `bootstrap.sh` verlangt bewusst, dass vorher eine ausgefüllte `.env`
existiert — es gibt keine funktionierenden Default-Secrets. Details zu jeder
Variable stehen kommentiert direkt in [`.env.example`](./.env.example).

## Sicherheitsdesign (kurz)

- Kein direkter Docker-Socket-Zugriff für den Provisioning Agent — läuft über einen
  eingeschränkten `docker-socket-proxy` (nur benötigte API-Gruppen freigeschaltet).
- Alle Secrets (JWT, MinIO-Keys, Webhook-Secrets) werden mit AES-256-GCM
  verschlüsselt in der Datenbank abgelegt, nie im Klartext.
- GitHub-Webhooks werden per HMAC-SHA256-Signatur gegen den rohen Request-Body
  verifiziert.
- Rate-Limiting auf drei Stufen (global, Webhooks, sensible Operationen).
- Der SQL-Editor im Dashboard erlaubt bewusst freie Queries (wie Supabase Studio) —
  das ist als Single-Admin-Werkzeug hinter Auth + Cloudflare Zero Trust gedacht,
  **nicht** für Multi-User-Zugriff mit unterschiedlichen Rechten. Wer das
  produktiv mit mehreren Admin-Usern einsetzt, sollte das vor Nutzung anpassen.

Ein öffentlich einsehbares Repo ersetzt keinen unabhängigen Security-Audit —
siehe die Hinweise in [CONTRIBUTING.md](./CONTRIBUTING.md) zu bekannten offenen
Punkten.

## Lizenz

Alle Rechte vorbehalten — siehe [LICENSE](./LICENSE). Der Code ist zu
Demonstrationszwecken öffentlich einsehbar, aber nicht zur Wiederverwendung,
Modifikation oder Weiterverbreitung freigegeben.
