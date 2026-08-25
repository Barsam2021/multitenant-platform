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

Lokale Kopien in `backups/files` verfallen nach `BACKUP_RETENTION_DAYS`
(Default 3). Fürs Remote gibt es **kein** implizites Limit: ohne
`BACKUP_REMOTE_RETENTION_DAYS` (Tage) löscht `backup-script.sh` dort nie etwas
— der Object-Storage wächst unbegrenzt.

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

## Schritt 8 — Besucher-Analytics aktivieren

Die Analytics lesen den Accesslog von Traefik. Auf einer **bestehenden**
Installation muss Traefik dafür einmal mit der neuen Konfiguration neu gestartet
werden (bei einer Neuinstallation ist das schon erledigt):

```bash
mkdir -p /opt/multitenant-platform/traefik/logs
cd /opt/multitenant-platform/traefik && docker compose up -d

# Migrationen nachziehen (19_optional_database.sql, 20_analytics.sql)
cd /opt/multitenant-platform && ./scripts/migrate.sh

# Prüfen, dass Zeilen ankommen:
tail -1 /opt/multitenant-platform/traefik/logs/access.log
```

Der Provisioning Agent liest die Datei jede Minute selbstständig ein; für einen
sofortigen Lauf:

```bash
docker exec provisioning-agent wget -qO- --post-data='' \
  --header="X-Agent-Secret: $PROVISIONING_AGENT_SECRET" \
  http://localhost:3001/analytics/ingest
```

Rotation übernimmt der Agent selbst (ab 200 MB, per SIGUSR1 an Traefik) — es
braucht **kein** logrotate.

## Schritt 9 — CMS-Modul einrichten (optional)

Nur nötig, wenn Endkunden ihre Inhalte selbst pflegen sollen. Ohne diese Schritte
läuft alles andere unverändert weiter.

**1. Migrationen und Schlüssel**

```bash
cd /opt/multitenant-platform && ./scripts/migrate.sh   # 21_cms.sql, 22_cms_config_role.sql

# Zwei getrennte Geheimnisse erzeugen und in die .env eintragen:
openssl rand -hex 32   # -> CMS_ENCRYPTION_KEY
openssl rand -hex 32   # -> CMS_SESSION_SECRET
```

`CMS_ENCRYPTION_KEY` ist bewusst **nicht** `ENCRYPTION_MASTER_KEY`: der CMS-Dienst
steht offen im Internet und soll bei einer Kompromittierung keine MinIO- und
JWT-Secrets der Tenants entschlüsseln können.

**2. Passwort der Konfigurationsrolle setzen**

Migration 22 legt die Rolle `cms_config` an, aber ohne Passwort — bis hier kann
sie sich nicht anmelden:

```bash
CMS_DB_PW=$(openssl rand -hex 24)
docker exec -i core-postgres psql -U postgres -d admin_dashboard \
  -c "ALTER ROLE cms_config WITH PASSWORD '$CMS_DB_PW';"
echo "CMS_DATABASE_URL=postgres://cms_config:$CMS_DB_PW@core-postgres:5432/admin_dashboard"
```

Die ausgegebene Zeile in die `.env` übernehmen.

**3. Medien-Auslieferung**

Hochgeladene Bilder liegen im MinIO-Bucket des Kunden, der von außen nicht
erreichbar ist. Dafür braucht es einen Traefik-Router auf MinIO — als Datei unter
`traefik/dynamic/media.yml`:

```yaml
http:
  routers:
    media:
      rule: "Host(`media.example.com`)"          # an PLATFORM_DOMAIN anpassen
      entryPoints: [websecure]
      service: media-svc
      tls:
        certResolver: myresolver
  services:
    media-svc:
      loadBalancer:
        servers:
          - url: "http://core-minio:9000"
```

Dazu `MEDIA_PUBLIC_BASE_URL=https://media.example.com` in die `.env`. Das
Präfix `public/` im Bucket eines Kunden schaltet der Provisioning Agent beim
Aktivieren des CMS selbst öffentlich lesbar — **nur** dieses Präfix, alles
andere bleibt privat. Schlägt das fehl, meldet das Dashboard es als Warnung
samt dem Befehl zum Nachholen.

**4. Dienst starten**

```bash
cd /opt/multitenant-platform/cms && docker compose --env-file ../.env up -d --build
```

Schritt 1–4 gehen auch in einem Rutsch — das Skript erzeugt die fehlenden
Schlüssel, setzt das Passwort für `cms_config`, legt den Medien-Router an und
startet alles neu:

```bash
./scripts/redeploy.sh --init-cms
```

DNS: `cms.<PLATFORM_DOMAIN>` und `media.<PLATFORM_DOMAIN>` zeigen auf die VPS-IP
(der Wildcard-A-Record aus Schritt 3 deckt beides ab).

**5. Pro Kunde freischalten**

Im Dashboard unter Projekt → **CMS**: aktivieren, Tabellen als Sammlungen
freigeben, Felder beschriften, Zugang für den Kunden anlegen. Der Kunde meldet
sich dann unter `https://cms.<PLATFORM_DOMAIN>/<slug>` an.

Wird ein Zugang gelöscht, gesperrt oder neu angelegt, endet die Sitzung im
Browser des Kunden beim nächsten Aufruf — er landet auf der Anmeldeseite. Das
Sitzungs-Cookie allein genügt nicht mehr, der Nutzer wird bei jedem Aufruf
gegen `cms_users` geprüft. Vorher blieb eine solche Sitzung bis zu acht Stunden
scheinbar gültig und brach erst beim Bild-Upload mit einer Datenbankmeldung ab
(`cms_media_uploaded_by_fkey`), weil das die einzige Stelle ist, die auf
`cms_users` verweist.

## Einen neuen Stand ausrollen

Für alles nach der Erstinstallation — Branch testen, Update einspielen:

```bash
./scripts/redeploy.sh                  # aktuellen Branch neu bauen und starten
./scripts/redeploy.sh <branch>         # auf einen Branch wechseln und ausrollen
./scripts/redeploy.sh --status         # nur nachsehen, nichts anfassen
./scripts/redeploy.sh --all <branch>   # zusätzlich Traefik/Postgres/MinIO neu starten
```

**Beim ersten Mal auf einem Server, dessen Stand das Skript noch nicht kennt:**
`git fetch` aktualisiert nur die Remote-Refs — die Datei liegt danach noch nicht
im Arbeitsverzeichnis. Also einmal von Hand auschecken, danach übernimmt das
Skript:

```bash
git checkout <branch>
./scripts/redeploy.sh
```

Das Skript zieht den Branch, fährt die Infrastruktur hoch, wartet auf Postgres,
spielt Migrationen ein, baut Agent/Dashboard/CMS neu, startet die
Tenant-Instanzen (nur die mit aktiver Datenbank — siehe Migration 19) und die
Kunden-App-Container, und meldet am Ende, was läuft und was nicht.

`--all` ist bewusst nicht der Standard: `core-postgres` neu zu starten trennt
jede Tenant-Verbindung, und ein Traefik-Neustart bedeutet ein paar Sekunden ohne
Reverse Proxy für alle Kundenseiten.

Zurück auf den alten Stand kommst du mit demselben Befehl:

```bash
./scripts/redeploy.sh main
```

## Schritt 10 — Health-Check

```bash
docker exec provisioning-agent curl -s http://localhost:3001/health
```

`/health` ist der einzige Endpunkt des Agents ohne Secret-Prüfung — der
Docker-Healthcheck kennt das Secret nicht, und eine Route hinter der Prüfung hätte
ihm dauerhaft 401 geliefert. Der Container hätte dann als `unhealthy` gegolten,
obwohl er einwandfrei arbeitet. Öffentlich erreichbar ist der Pfad nicht: der
Traefik-Router des Agents nimmt ausschließlich `/webhooks`.

Danach testweise einen Smoke-Test fahren:

```bash
./scripts/smoke-test.sh
```

## Wenn Cloudflare davor steht

Wird die Plattform über Cloudflare veröffentlicht (Proxy aktiv, „orange Wolke"),
sieht Traefik als Gegenstelle nicht den Besucher, sondern eine Cloudflare-Edge-IP.
Zwei Dinge hängen davon ab und sind entsprechend auf den Header `Cf-Connecting-Ip`
umgestellt: das Rate-Limiting und die Besucherzählung. Beides funktioniert auch
ohne Cloudflare — dann fehlt der Header und die TCP-Gegenstelle ist die richtige
Quelle.

Wer prüfen will, was tatsächlich ankommt:

```bash
docker logs --since 2m global-traefik 2>&1 | grep -o '"ClientAddr":"[^"]*"' | sort -u | head
```

Erscheinen dort `188.114.96.x`, `172.67.x` oder `104.16.x`, ist der Proxy aktiv.

## Weiterbetrieb

Alles, was nach der Einrichtung kommt — Diagnose, Prüfbefehle, typische Symptome
und ihre Ursachen —, steht in [docs/OPERATIONS.md](./docs/OPERATIONS.md).

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
