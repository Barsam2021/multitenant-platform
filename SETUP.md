# Setup — von 0 auf lauffähig

> **Hinweis zu diesem Dokument:** Frühere Versionen von Code und `bootstrap.sh`
> verwiesen an mehreren Stellen auf nummerierte Referenzdokumente
> (`01_architecture_blueprint.md`, `02_vps_bootstrap_guide.md`,
> `04_backup_system.md`, `09_disaster_recovery_runbook.md`, `10_env_reference.md`,
> `11_web_ui_specification.md`). Diese Dateien existieren im Repo nicht
> (wahrscheinlich lokale Notizen, nie committet) — die Verweise im Code wurden
> entfernt und zeigen jetzt auf tatsächlich vorhandene Stellen (`.env.example`,
> dieses SETUP.md, Code-Kommentare). Dieses SETUP.md fasst das zusammen, was aus
> Code, `.env.example` und `bootstrap.sh` tatsächlich rekonstruierbar ist.

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
- `BACKUP_AGE_PUBLIC_KEY` / `BACKUP_AGE_IDENTITY_FILE`, `RCLONE_CONFIG`,
  `RCLONE_REMOTE_PATH`: fürs Backup-System (Schritt 6) — Storage-Anbieter frei
  wählbar über `rclone config` (Backblaze B2, S3, Hetzner Storage Box, SFTP, ...).

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

Das Dashboard ist absichtlich **nicht** über offene Ports erreichbar — nur über
den Cloudflare Tunnel mit Zero-Trust-Auth davor. Uptime Kuma dagegen läuft ganz
normal über Traefik/Let's Encrypt auf einem offenen Port (443), mit eigenem
Login davor (Schritt 7): im Cloudflare Zero Trust Dashboard:

1. Tunnel anlegen, Token in `CLOUDFLARE_TUNNEL_TOKEN` (`.env`) eintragen
2. Ingress-Regel für das Dashboard ergänzen:
   - `admin.<PLATFORM_DOMAIN>` → `http://admin-dashboard:3000`
3. Für `status-vps.<PLATFORM_DOMAIN>` (Uptime Kuma) ist **keine** Tunnel-Regel
   nötig — ein normaler A-Record auf die Server-IP reicht, Traefik übernimmt
   TLS und Routing selbst (siehe `monitoring/uptime-kuma/docker-compose.yml`).

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

Der tägliche Cron wird von `bootstrap.sh` automatisch nach
`/etc/cron.d/multitenant-backup` installiert (03:00, Log unter
`/var/log/mt-backup.log`). Gesichert werden Postgres-Globals, alle Datenbanken
(`-Fc`), MinIO und die Konfiguration inklusive `.env`.

Verschlüsselung läuft über `age` — den Public Key in `BACKUP_AGE_PUBLIC_KEY`
eintragen, den privaten Identity-File **niemals** ins Repo committen (ist über
`.gitignore` bereits ausgeschlossen: `backups/age-identity.txt`).

> **Ohne Off-Site-Kopie des age-Keys und der `.env` gibt es kein
> wiederherstellbares Backup.** Beide liegen sonst ausschließlich auf genau dem
> Server, gegen dessen Verlust gesichert wird — die Dateien im Object Storage
> sind dann unlesbare Bytes. `sprint21-06-p0-5-backups.sh` erzeugt dafür ein
> passphrasenverschlüsseltes DR-Bundle; das gehört in einen Passwort-Manager
> oder auf ein verschlüsseltes Offline-Medium, **nicht** in dasselbe
> rclone-Remote.

Restore einmal testen (Dateiname aus `./backups/restore-script.sh list`):

```bash
./backups/restore-test-script.sh kunde_beispiel_20260810-030000.dump.age
```

Echter Restore (überschreibt Daten, Reihenfolge beachten):

```bash
./backups/restore-script.sh globals
./backups/restore-script.sh db kunde_beispiel_20260810-030000.dump.age
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

- SMTP für GoTrue (Tenant-Auth-Mails) läuft über `RESEND_API_KEY` in der `.env`
  (`GOTRUE_MAILER_AUTOCONFIRM: "false"` im Tenant-Compose-Template — Registrierung
  verlangt also eine Bestätigungsmail). Ist `RESEND_API_KEY` nicht gesetzt, wird
  die Mail nie zugestellt und kein Tenant-User kann sich bestätigen — der Agent
  loggt dafür eine Warnung beim Tenant-Anlegen, ändert das Verhalten aber nicht
  automatisch. Für Betrieb ohne SMTP-Anbindung `RESEND_API_KEY` einfach nicht
  setzen und stattdessen manuell in `kunden-instances/<slug>/docker-compose.yml`
  `GOTRUE_MAILER_AUTOCONFIRM` auf `"true"` setzen, bevor der `auth`-Container
  gestartet wird.
- Resource-Tier-Werte (`STARTER_*`, `BUSINESS_*`, `PREMIUM_*` in `.env.example`)
  sind Platzhalter für eine 16GB-VPS-Planung, nicht final für 8GB kalkuliert.
- Container-Hardening (`read_only`, `cap_drop: ALL`, `no-new-privileges`,
  `pids_limit`) ist für die generierten Tenant-Compose-Templates noch nicht
  vollständig durchgezogen.
