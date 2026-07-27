# Multi-Tenant VPS Platform

Selbstgehostete Multi-Tenant-Plattform (Supabase- + Vercel-Alternative) auf einem einzelnen
16 GB Hetzner-VPS: geteilte Postgres/PgBouncer/MinIO-Engine, pro Kunde eigener PostgREST- +
GoTrue-Container, automatisiertes Provisioning, Nixpacks-basierte Deployment Engine und ein
Next.js-Admin-Dashboard.

## Architektur

Siehe [`docs/01_architecture_blueprint.md`](docs/01_architecture_blueprint.md) für die
vollständige Topologie. Kurzfassung:

- **Ingress:** Traefik v3 (öffentlich, 80/443) + Cloudflare Tunnel (Admin, kein offener Port)
- **DB/Auth/Storage:** 1x geteilter PostgreSQL/PgBouncer-Stack, MinIO; pro Kunde eigene DB +
  eigener PostgREST- + GoTrue-Container
- **Deployment Engine:** Nixpacks-basierter Vercel-Ersatz — Git-Push → Build → Blue-Green-Deploy
- **Orchestrierung:** Provisioning Agent (interne HTTP-API) + Next.js-Dashboard + Uptime-Kuma

## Ordnerstruktur

```
provisioning-agent/   Node.js/TypeScript — Tenant-Provisioning + Deployment Engine
dashboard/             Next.js Admin-Dashboard
traefik/, core-postgres/, minio/, monitoring/, cloudflared/   Core-Infra-Compose-Files
kunden-instances/       Generiert zur Laufzeit — NICHT im Repo (siehe .gitignore)
deployments/            Build-Artefakte — NICHT im Repo
docs/                   Architektur-Dokumentation
```

## Setup (frischer Server)

```bash
git clone git@github.com:<dein-user>/<repo>.git /opt/multitenant-platform
cd /opt/multitenant-platform
cp .env.example .env
nano .env   # ALLE CHANGE_ME-Werte durch echte Secrets ersetzen (openssl rand -hex 32)
sudo ./bootstrap.sh
```

Das Script ist idempotent — bei Fehlern einfach erneut ausführen, bereits laufende Dienste
werden nicht neu erstellt.

## Sicherheit

- **Keine Secrets im Repo.** `.env` ist global gitignored. `.env.example` enthält nur
  Platzhalter.
- **Generierte Kunden-Configs** (`kunden-instances/*/docker-compose.yml`) enthalten echte
  JWT-Secrets und DB-Passwörter und werden zur Laufzeit vom Provisioning Agent erzeugt — nie
  committen.
- Coding-Konventionen (verbotene Patterns, Secret-Handling, Shell-Escaping): siehe
  [`CLAUDE.md`](CLAUDE.md).

## Deployment Engine testen

```bash
curl -X POST http://provisioning-agent:3001/projects \
  -H "Content-Type: application/json" -H "X-Agent-Secret: $PROVISIONING_AGENT_SECRET" \
  -d '{"tenantSlug":"<bestehender-tenant>","slug":"<projekt-slug>","repoUrl":"<git-repo>","defaultBranch":"main"}'
```

Details: [`deployment-engine/README.md`](deployment-engine/README.md) (Endpoints, Rollback,
Webhook-Setup).

## Lizenz

Privat/proprietär — kein Open-Source-Lizenz-Grant impliziert durch die öffentliche
Sichtbarkeit dieses Repos.
