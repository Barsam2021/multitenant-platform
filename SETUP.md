# Setup — von 0 auf lauffähig

> **Hinweis zu diesem Dokument:** Der Code und `bootstrap.sh` verweisen an
> mehreren Stellen auf nummerierte Referenzdokumente (`01_architecture_blueprint.md`,
> `02_vps_bootstrap_guide.md`, `04_backup_system.md`, `09_disaster_recovery_runbook.md`,
> `10_env_reference.md`, `11_web_ui_specification.md`). Diese Dateien existieren im
> aktuellen Repo-Stand nicht (wahrscheinlich lokale Notizen, nie committet). Dieses
> SETUP.md fasst das zusammen, was aus Code, `.env.example` und `bootstrap.sh`
> tatsächlich rekonstruierbar ist. Falls du (Repo-Owner) die Originaldateien noch
> hast: ergänzen und diesen Hinweis entfernen.

## Voraussetzungen

- Frischer Ubuntu- oder Debian-Server (root/sudo-Zugriff), öffentlich erreichbar
  über eine eigene Domain
- Domain mit DNS bei Cloudflare (für DNS-01-Zertifikate und Cloudflare Tunnel)
- GitHub-Account (für die Deployment-Pipeline, optional aber empfohlen)
- Node.js 20.x lokal, falls du Dashboard/Agent außerhalb von Docker entwickeln willst
  (für den reinen Betrieb reicht Docker auf dem Server)

## Schritt 1 — Repo klonen

```bash
git clone <this-repo-url> /opt/multitenant-platform
cd /opt/multitenant-platform
```

## Schritt 2 — `.env` anlegen

```bash
cp .env.example .env
nano .env
```

Trage **alle** `CHANGE_ME`-Werte ein. Secrets generierst du am besten mit:

```bash
openssl rand -hex 32
```

Details zu jeder Variable stehen als Kommentar direkt in `.env.example` —
insbesondere:

- `ENCRYPTION_MASTER_KEY`: verschlüsselt alle sensiblen Werte (Env-Vars der
  Kundenprojekte, MinIO-Secrets) in der DB. **Bei Verlust dieses Keys sind alle
  verschlüsselten Werte in der Datenbank unbrauchbar** — sicher aufbewahren
  (Passwort-Manager, nicht nur auf dem Server selbst).
- `PLATFORM_DOMAIN`: deine Basis-Domain. Alle Tenant-Subdomains
  (`<slug>.<PLATFORM_DOMAIN>`) und der Webhook-Endpunkt
  (`webhooks.<PLATFORM_DOMAIN>`) hängen davon ab. Für DNS: ein Wildcard-A-Record
  (`*.PLATFORM_DOMAIN` → Server-IP) einmalig anlegen.
- `GITHUB_PAT`: Fine-grained Personal Access Token mit Scope „Webhooks: Read & write“,
  nur für Repos, die du selbst verbinden willst. Ohne Token: Webhooks müssen
  manuell in GitHub eingetragen werden (die URL zeigt das Dashboard bei
  Projekt-Erstellung an).
- `HETZNER_SBX_USER` / `HETZNER_SBX_PASS`: nur relevant, falls du Backups auf eine
  Hetzner Storage Box legst. Für andere Object-Storage-Anbieter `rclone config`
  entsprechend anpassen (siehe Schritt 6).

## Schritt 3 — Bootstrap ausführen

```bash
sudo ./bootstrap.sh
```

Das Skript ist idempotent (mehrfach ausführbar) und macht:

1. System-Pakete installieren, Firewall (UFW: nur 22/80/443 offen) konfigurieren
2. Docker Engine installieren
3. Verzeichnisstruktur + Docker-Netzwerk (`traefik-net`) anlegen
4. `.env` prüfen (bricht ab, falls sie fehlt)
5. Core-Infrastruktur starten: Traefik, PostgreSQL+PgBouncer, MinIO, Uptime Kuma,
   Cloudflare Tunnel
6. Provisioning Agent bauen & starten
7. Dashboard bauen & starten

## Schritt 4 — Cloudflare Tunnel verbinden

Das Dashboard und Uptime Kuma sind absichtlich **nicht** über offene Ports
erreichbar. Im Cloudflare Zero Trust Dashboard:

1. Tunnel anlegen, Token in `CLOUDFLARE_TUNNEL_TOKEN` (`.env`) eintragen
2. Ingress-Regeln ergänzen:
   - `admin.<PLATFORM_DOMAIN>` → `http://admin-dashboard:3000`
   - `status-vps.<PLATFORM_DOMAIN>` → läuft über Traefik/Let's Encrypt (normaler
     A-Record, **nicht** über den Tunnel — siehe Hinweis in Uptime-Kuma-Setup unten)

## Schritt 5 — Admin-Zugang für das Dashboard anlegen

Das Dashboard nutzt Credentials-Auth (kein OAuth), Passwort-Hash liegt in der `.env`:

```bash
node -e "console.log(require('bcryptjs').hashSync('DEIN_PASSWORT', 12))"
```

Ergebnis in `ADMIN_PASSWORD_HASH` eintragen, `ADMIN_EMAIL` entsprechend setzen,
Container neu starten. Login unter `https://admin.<PLATFORM_DOMAIN>`.

## Schritt 6 — Backups einrichten

```bash
rclone config    # Remote für deinen Object-Storage-Anbieter anlegen
```

Danach `backups/backup-script.sh` als Cron einrichten (empfohlen: täglich).
Verschlüsselung läuft über `age` — den Public Key in `BACKUP_AGE_PUBLIC_KEY`
eintragen, den privaten Identity-File **niemals** ins Repo committen (ist über
`.gitignore` bereits ausgeschlossen: `backups/age-identity.txt`).

Restore einmal testen:

```bash
./backups/restore-test-script.sh
```

## Schritt 7 — Uptime Kuma initialisieren

Uptime Kuma muss beim ersten Aufruf einmalig über den eigenen Setup-Wizard
initialisiert werden:

- Datenbank-Wahl: **SQLite empfohlen** (der `mem_limit: 128m` im Compose-File ist
  für die eingebettete MariaDB-Variante zu knapp bemessen)
- Admin-Zugangsdaten müssen exakt `UPTIME_KUMA_USERNAME` / `UPTIME_KUMA_PASSWORD`
  aus der `.env` entsprechen, sonst kann der Provisioning Agent keine Monitore
  automatisch anlegen

## Schritt 8 — Health-Check

```bash
docker exec provisioning-agent wget -qO- \
  --header="X-Agent-Secret: $PROVISIONING_AGENT_SECRET" \
  http://localhost:3001/health
```

Danach testweise einen Smoke-Test fahren:

```bash
./scripts/smoke-test.sh
```

## Bekannte offene Punkte (siehe auch README „Sicherheitsdesign")

- SMTP für GoTrue (Tenant-Auth-Mails) ist aktuell nicht verdrahtet
  (`GOTRUE_MAILER_AUTOCONFIRM: true`) — für echten Betrieb mit E-Mail-Bestätigung
  muss das auf einen echten SMTP-Provider (z. B. Resend) umgestellt werden.
- Resource-Tier-Werte (`STARTER_*`, `BUSINESS_*`, `PREMIUM_*` in `.env.example`)
  sind Platzhalter für eine 16GB-VPS-Planung, nicht final für 8GB kalkuliert.
- Container-Hardening (`read_only`, `cap_drop: ALL`, `no-new-privileges`,
  `pids_limit`) ist für die generierten Tenant-Compose-Templates noch nicht
  vollständig durchgezogen.
