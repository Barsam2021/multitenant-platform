# Dashboard — Datenbank-Modul (v1)

Erste lauffähige Stufe der Web-UI aus `11_web_ui_specification.md`, Phase 1
(Tenant-Übersicht) + Datenbank-Kernstück: **Table Editor** + **SQL Editor**,
gegen deine bereits laufenden Tenant-DBs (siehe `01_architecture_blueprint.md`).

## Was funktioniert

- Login (NextAuth Credentials, gleiche Env-Vars wie in `10_env_reference.md` § 2 vorgesehen)
- `/dashboard/database` — Liste aller Tenants aus `admin_dashboard.kunden`
- `/dashboard/database/[slug]` — Tabellenliste der jeweiligen Tenant-DB
- `/dashboard/database/[slug]/[table]` — Table Editor: Zeilen browsen (paginiert),
  Inline-Edit per Doppelklick, neue Zeile anlegen, Zeile löschen
- `/dashboard/sql/[slug]` — SQL Editor mit freier Query-Ausführung (⌘/Strg+Enter)

**Verbindung:** Läuft als `postgres`-Superuser direkt gegen `pgbouncer:5432/<db_name>`
(nicht über den eingeschränkten `authenticator`-Role) — analog zu Supabase Studio,
das auch mit vollen Rechten auf die DB zugreift.

## Was noch fehlt (nächste Phasen)

- Auth-User-Verwaltung (GoTrue-Admin-API)
- Storage-Browser (MinIO/S3-API)
- Schema-Editor (Tabellen/Spalten per UI anlegen, nicht nur Daten)
- Git-Connect / Hosting-Flow (Phase 2/3 aus der Web-UI-Spec)

## Setup auf dem VPS

1. Ordner ins Repo/VPS unter `/opt/multitenant-platform/dashboard/` legen.
2. Neue Env-Vars zur zentralen `.env` hinzufügen (zusätzlich zu den
   bestehenden aus `10_env_reference.md`):
   ```bash
   # Admin-Login-Passwort-Hash generieren:
   node -e "console.log(require('bcryptjs').hashSync('DEIN_PASSWORT', 12))"
   ```
   Ergebnis in `ADMIN_PASSWORD_HASH` eintragen. `NEXTAUTH_SECRET` per
   `openssl rand -hex 32` erzeugen (wird hier als `AUTH_SECRET` an NextAuth
   v5 durchgereicht).
3. `NEXTAUTH_URL=https://admin.vps.meine-domain.com` (wie in `10_env_reference.md`).
4. Build & Start:
   ```bash
   cd /opt/multitenant-platform/dashboard
   set -a && source /opt/multitenant-platform/.env && set +a
   docker compose up -d --build
   ```
5. Cloudflare Tunnel Ingress-Rule ergänzen: `admin.vps.meine-domain.com` →
   `http://admin-dashboard:3000` (siehe `02_vps_bootstrap_guide.md` § 5.5) —
   Container läuft im `traefik-net`, kein öffentlicher Port.
6. Login unter `https://admin.vps.meine-domain.com` mit `ADMIN_EMAIL` +
   dem Klartext-Passwort, dessen Hash du in Schritt 2 erzeugt hast.

## Lokale Entwicklung

```bash
npm install
cp .env.example .env.local   # falls vorhanden, sonst manuell Env-Vars setzen
npm run dev
```
Für lokale DB-Verbindung brauchst du entweder einen SSH-Tunnel zum VPS
(`ssh -L 5432:localhost:5432 vps`) oder eine lokale Kopie der Core-Postgres-Instanz.
