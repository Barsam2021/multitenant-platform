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

- **optional** eine eigene PostgreSQL-Datenbank (über zentralen PgBouncer-Pool)
  samt PostgREST- und GoTrue-Instanz. Wer nur eine Landingpage betreibt, bekommt
  keine — das spart pro Kunde zwei dauerhaft laufende Container (~200 MB RAM)
  und ist jederzeit nachrüstbar, ohne den Tenant neu anzulegen
- eigenen MinIO-Bucket mit eigenen IAM-Credentials (S3-kompatibler Storage)
- eine eigene Deployment-Pipeline: GitHub-Repo verbinden → Push löst automatisch
  einen Build (Nixpacks) und einen Deploy auf einer eigenen Subdomain aus,
  inkl. abgesicherter Rollback-Funktion. Kein echtes Blue-Green: zwischen dem
  Umschalten des alten und dem Gesundwerden des neuen Containers liegen
  typischerweise 3–15 Sekunden Downtime
- automatisches TLS über Traefik + Let's Encrypt (DNS-01 via Cloudflare)
- Besucher-Analytics pro Domain: Aufrufe, Besucher, meistbesuchte Seiten und
  Herkunft — gezählt aus dem Traefik-Accesslog, ohne Cookies, ohne
  Tracking-Script in der Kunden-App und ohne gespeicherte IP-Adressen
- Uptime-Monitoring (Uptime Kuma) und täglich per Cron laufende, age-verschlüsselte
  Backups nach Object Storage (rclone) — inklusive Postgres-Globals, aller
  Datenbanken, MinIO und der Konfiguration; Restore ist skriptiert und getestet

Verwaltet wird alles über ein zentrales Next.js-Dashboard mit Tenant-Verwaltung,
Table-/SQL-Editor, Deployment-Historie mit Live-Logs, Besucherstatistik, Domain-
und Environment-Variable-Verwaltung sowie Audit-Log.

Dazu kommt ein **CMS für die Endkunden** (`cms/`): der Kunde meldet sich unter
`cms.<domain>/<slug>` an und pflegt seine Inhalte selbst — Beiträge schreiben,
Bilder hochladen. Schemagetrieben, weil jedes Kundenprojekt anders aussieht: der
Betreiber gibt im Dashboard einzelne Tabellen als Sammlungen frei, die Felder
werden aus dem Postgres-Schema vorbelegt und lassen sich danach beschriften,
ausblenden und im Typ hochstufen. Zugriff hat der Kunde ausschließlich auf die
freigegebenen Tabellen — das ist auf Datenbankebene erzwungen (eigene, pro
Tabelle berechtigte Rolle), nicht nur in der Oberfläche. Entwurf und offene
Punkte: [docs/CMS-PLAN.md](./docs/CMS-PLAN.md).

## Tech-Stack

| Bereich | Technologie |
|---|---|
| Dashboard | Next.js 15 (App Router), React 19, TypeScript, NextAuth v5 |
| CMS (Endkunden) | Next.js 15, eigene Session (JWT-Cookie), sharp + MinIO für Uploads |
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

Für alles danach — Update einspielen, einen Branch testen:

```bash
./scripts/redeploy.sh <branch>   # ziehen, migrieren, neu bauen, neu starten
./scripts/redeploy.sh --status   # nur nachsehen, was läuft
```

## Sicherheitsdesign (kurz)

- Der Provisioning Agent spricht nicht direkt mit dem Docker-Socket, sondern über
  einen `docker-socket-proxy` in einem eigenen `internal`-Netzwerk, zu dem nur der
  Agent Zugriff hat. `EXEC` und `VOLUMES` sind abgeschaltet. Zur ehrlichen
  Einordnung: die API-Gruppen-Flags des Proxys filtern nur Pfad und Methode, nicht
  den Request-Body — `POST` + `CONTAINERS` ist für sich genommen root-äquivalent.
  Die wirksame Grenze ist die Netzwerktrennung, nicht die Flags.
- `kunden.minio_secret_key_encrypted` und `project_env_vars.value_encrypted` werden
  mit AES-256-GCM verschlüsselt in der Datenbank abgelegt. **Nicht** verschlüsselt
  sind derzeit `kunden.gotrue_jwt_secret`, `kunden.authenticator_password`,
  `kunden.anon_jwt`, `kunden.service_role_jwt` und `projects.webhook_secret` — diese
  stehen im Klartext in der Datenbank (offener Punkt, siehe unten).
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


## Ehrlicher Sicherheitsstand

Dieses Repository wurde am 10.08.2026 auf Commit `0430f9c` einem vollständigen
Production-Readiness-Audit unterzogen. Die dort gefundenen P0-Befunde sind in
Sprint 21 behoben: Netzwerk-Isolation des Socket-Proxys und der Kundencontainer,
Tenant-Isolation auf Datenbankebene (`REVOKE CONNECT` plus Rollen pro Tenant),
Advisory Lock beim Provisioning, wertbasierte Secret-Maskierung und
wiederherstellbare Backups.

Offen, und hier bewusst dokumentiert statt beschönigt:

- Es existiert **keine Testsuite**. Sieben der elf schwersten Audit-Befunde wären
  von vier Integrationstests gefunden worden (Tenant-Isolation, Backup-Restore,
  Deploy-Concurrency, Route-Vertrag).
- `kunden.gotrue_jwt_secret`, `kunden.authenticator_password` und
  `projects.webhook_secret` liegen im Klartext in der Datenbank.
- Der Tabellen-Editor im Dashboard behandelt zusammengesetzte Primärschlüssel
  noch nicht korrekt (offener Punkt P1-2).
- Die Plattform ist für 5–10 Tenants auf einem 8-GB-VPS ausgelegt. Darüber
  braucht es mehr RAM oder eine zweite Maschine.
- `next-auth` läuft als Beta mit Caret-Range.

Wer das Repo als Referenz liest: die Architektur-Entscheidungen sind in
[ARCHITECTURE.md](./ARCHITECTURE.md) begründet, die bekannten Grenzen stehen hier.
