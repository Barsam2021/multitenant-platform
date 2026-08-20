# Backup einrichten — Schritt für Schritt

Für den Fall, dass noch **nichts** eingerichtet ist. Von null bis zur ersten
geprüften Off-Site-Sicherung. Dauer: etwa 30 Minuten.

Alle Serverbefehle laufen als `root` auf dem VPS, im Verzeichnis
`/opt/multitenant-platform`. Verbinde dich also zuerst:

```bash
ssh root@<deine-server-ip>
cd /opt/multitenant-platform
```

Wenn ein Schritt eine andere Ausgabe liefert als beschrieben: **nicht
weitermachen**, sondern erst klären. Ein Backup, das halb eingerichtet ist,
ist gefährlicher als gar keins — es sieht aus, als wäre es da.

---

## Schritt 1 — Speicherplatz beim Anbieter anlegen (im Browser)

Empfehlung: **Cloudflare R2**. 10 GB kostenlos, keine Gebühren fürs
Herunterladen — und das zählt genau dann, wenn du im Ernstfall alles auf
einmal zurückholst.

1. <https://dash.cloudflare.com> öffnen, links **R2** anklicken.
2. **Create bucket** → Name: `multitenant-backup` → Location: *Automatic* →
   **Create bucket**.
3. Zurück in der R2-Übersicht: **Manage R2 API Tokens** → **Create API Token**.
4. Permissions: **Object Read & Write**. Unter *Specify bucket* den eben
   angelegten Bucket auswählen. → **Create API Token**.
5. Jetzt werden dir drei Dinge **einmalig** angezeigt. Kopiere sie in einen
   Notizzettel, du brauchst sie in Schritt 3:
   - **Access Key ID**
   - **Secret Access Key**
   - **Endpoint** in der Form `https://<account-id>.r2.cloudflarestorage.com`

> Alternative: Backblaze B2 (ebenfalls 10 GB gratis). Dann in Schritt 3 als
> Storage-Typ `b2` wählen statt `s3`, und Account ID + Application Key
> eintragen. Alles Übrige ist identisch.

---

## Schritt 2 — Code und Werkzeuge auf den Server holen

```bash
cd /opt/multitenant-platform
git fetch origin
git checkout claude/backup-cve-tracking-0oc43i
git pull
```

Prüfen, ob die beiden Werkzeuge da sind, die das Backup braucht:

```bash
command -v rclone && command -v age
```

Erwartete Ausgabe: zwei Pfade, z. B. `/usr/bin/rclone` und `/usr/bin/age`.

Fehlt eines davon:

```bash
apt update && apt install -y rclone age
```

---

## Schritt 3 — Server mit dem Speicher verbinden

```bash
rclone config --config /opt/multitenant-platform/backups/rclone.conf
```

Es startet ein Frage-Antwort-Dialog. Antworten der Reihe nach:

| Frage | Antwort |
|---|---|
| `n/s/q>` | `n`  (new remote) |
| `name>` | `r2` |
| `Storage>` | `s3` |
| `provider>` | `Cloudflare` |
| `env_auth>` | `1`  (Zugangsdaten eingeben) |
| `access_key_id>` | dein Access Key aus Schritt 1 |
| `secret_access_key>` | dein Secret aus Schritt 1 |
| `region>` | `auto` |
| `endpoint>` | `https://<account-id>.r2.cloudflarestorage.com` |
| alles Weitere | Enter (Standard) |
| `y/e/d>` | `y`  (speichern) |
| `e/n/d/r/c/s/q>` | `q`  (beenden) |

Rechte setzen — die Datei enthält deine Zugangsdaten:

```bash
chmod 600 /opt/multitenant-platform/backups/rclone.conf
```

**Verbindung testen:**

```bash
rclone --config /opt/multitenant-platform/backups/rclone.conf lsd r2:
```

Erwartet: eine Zeile mit `multitenant-backup`. Kommt eine Fehlermeldung,
stimmen Schlüssel oder Endpoint nicht — zurück zu Schritt 1.

---

## Schritt 4 — Verschlüsselungsschlüssel erzeugen

Jede Sicherung wird auf dem Server verschlüsselt, bevor sie ihn verlässt. Der
Anbieter sieht nur unlesbare Bytes.

```bash
age-keygen -o /opt/multitenant-platform/backups/age-identity.txt
chmod 600 /opt/multitenant-platform/backups/age-identity.txt
```

Die Ausgabe enthält eine Zeile wie:

```
Public key: age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
```

**Diesen Public Key kopieren.** Er kommt gleich in die `.env`.

---

## Schritt 5 — Konfiguration eintragen

```bash
nano /opt/multitenant-platform/.env
```

Diese Zeilen suchen und ausfüllen (oder unten anfügen, falls nicht vorhanden):

```bash
# Wohin gesichert wird
RCLONE_CONFIG=/opt/multitenant-platform/backups/rclone.conf
RCLONE_REMOTE_PATH=r2:multitenant-backup

# Womit verschlüsselt wird — Public Key aus Schritt 4
BACKUP_AGE_PUBLIC_KEY=age1ql3z7hjy54pw3...
BACKUP_AGE_IDENTITY_FILE=/opt/multitenant-platform/backups/age-identity.txt

# Wie viel aufbewahrt wird — Modus "count" hält das Gratiskontingent ein
BACKUP_RETENTION_DAYS=3
BACKUP_RETENTION_MODE=count
BACKUP_KEEP_RUNS=3
BACKUP_MIN_KEEP_RUNS=2
BACKUP_MAX_TOTAL_BYTES=9000000000

# Überwachung
BACKUP_MAX_AGE_HOURS=36
BACKUP_RESTORE_TEST_INTERVAL_DAYS=7
BACKUP_DR_BUNDLE_MAX_AGE_DAYS=180
```

Speichern mit `Strg+O`, `Enter`, dann `Strg+X`.

### Bleibt das im Gratiskontingent?

`BACKUP_RETENTION_MODE=count` bewahrt die letzten **3 Läufe** auf. Ein „Lauf"
ist alles, was eine Nacht erzeugt: Globals, jede Datenbank, MinIO, Config.
Kommt der vierte dazu, fällt der älteste weg — vollständig, nie nur einzelne
Dateien. Ein Lauf ohne seine Globals wäre im Ernstfall wertlos und sähe
trotzdem wie ein Backup aus.

Zusätzlich greift `BACKUP_MAX_TOTAL_BYTES` (9 GB, bewusst unter den 10 GB von
R2). Wächst deine Datenmenge, werden auch bei nur 3 Läufen weitere fallen
gelassen, bis es wieder passt — aber nie unter `BACKUP_MIN_KEEP_RUNS`. Lieber
einmal über Budget **mit Alarm** als am Ende mit nur einer einzigen Kopie.

Die Rechnung:

```
Größe eines Laufs × 3  ≤  9 GB      →  ein Lauf darf ~3 GB groß sein
```

Nach dem ersten Backup (Schritt 8) siehst du deine echte Größe:

```bash
rclone --config /opt/multitenant-platform/backups/rclone.conf size r2:multitenant-backup
```

Im Dashboard steht dasselbe als Balken: „X % von 9 GB belegt", ab 90 % rot.

Passt es nicht, ist fast immer der MinIO-Spiegel der dicke Posten — er enthält
alle hochgeladenen Kundendateien und wächst mit jedem Upload. Dann entweder
`BACKUP_KEEP_RUNS=2` setzen oder auf bezahlten Speicher wechseln (Hetzner
Storage Box: 1 TB für rund 4 €/Monat).

> **Was das Kontingent nicht belastet:** die Zugriffe selbst. R2 gibt pro Monat
> 1 Mio. Schreib- und 10 Mio. Leseoperationen frei; ein nächtliches Backup
> braucht davon eine Handvoll. Und Downloads sind bei R2 kostenlos — der
> Restore im Ernstfall kostet dich also nichts.

Damit die Alarme per Mail ankommen, müssen `RESEND_API_KEY` und `ADMIN_EMAIL`
gesetzt sein — die stehen weiter oben in derselben Datei und sind für andere
Funktionen ohnehin nötig. Fehlen sie, landen die Alarme nur im Log des Agents.

---

## Schritt 6 — Die Kopie, die den Server verlässt

**Der wichtigste Schritt.** Ohne ihn nützt dir alles Bisherige nichts: Der
Schlüssel aus Schritt 4 liegt auf genau dem Server, gegen dessen Verlust du
sicherst. Stirbt er, sind alle Sicherungen beim Anbieter unlesbar.

```bash
cd /opt/multitenant-platform
tar czf - backups/age-identity.txt backups/rclone.conf .env \
  | age -p > /root/dr-bundle-$(date +%F).tar.gz.age
```

Du wirst nach einer **Passphrase** gefragt (zweimal). Denk dir eine aus und
notiere sie getrennt vom Bundle.

Jetzt die Datei vom Server herunterladen — auf deinem **eigenen Rechner**
ausführen, nicht auf dem Server:

```bash
scp root@<deine-server-ip>:/root/dr-bundle-*.tar.gz.age ~/Downloads/
```

Diese Datei gehört in deinen Passwortmanager oder auf einen verschlüsselten
USB-Stick. **Nicht** in denselben R2-Bucket — wer den Server verliert,
verlöre sonst beides.

Danach auf dem Server aufräumen und das Datum eintragen:

```bash
rm /root/dr-bundle-*.tar.gz.age
nano /opt/multitenant-platform/.env
```

Zeile ergänzen, mit dem heutigen Datum:

```
BACKUP_DR_BUNDLE_CONFIRMED_AT=2026-08-20
```

Das ist kein Wert, den du irgendwo abholst — du bestätigst damit selbst, dass
die Kopie existiert. Der Agent fragt nach 180 Tagen erneut nach.

---

## Schritt 7 — Ausrollen

```bash
cd /opt/multitenant-platform
./scripts/redeploy.sh
```

Das Skript fährt die Datenbank-Migrationen nach und baut Agent und Dashboard
neu. Läuft ein paar Minuten. Am Ende darf keine Zeile mit `FEHLER` stehen;
`WARNUNG` zu einzelnen Tenants ist unkritisch.

Cron-Eintrag prüfen:

```bash
cat /etc/cron.d/multitenant-backup
```

Erwartet: eine Zeile, die um `0 3 * * *` das Backup-Skript startet. Fehlt die
Datei:

```bash
install -m 0644 backups/cron.d-multitenant-backup /etc/cron.d/multitenant-backup
systemctl reload cron
```

---

## Schritt 8 — Beweisen, dass es funktioniert

Nicht auf die Nacht warten. Jetzt einmal von Hand:

```bash
./backups/backup-script.sh
```

Das dauert je nach Datenmenge einige Minuten. Die letzte Zeile muss lauten:

```
Backup vollstaendig: Globals, N Datenbanken, MinIO, Config.
```

Darüber steht eine Zeile wie `Aufbewahrung: 1 Laeufe behalten (820 MB),
0 Laeufe entfernt.` — das ist die Selbstabrechnung gegen dein Budget.

**Was liegt jetzt beim Anbieter?**

```bash
./backups/restore-script.sh list
```

Erwartet: mehrere Zeilen mit `…age` — Globals, jede Datenbank, MinIO, Config.

**Und lässt sich das auch zurückspielen?** Nimm einen Datenbank-Dateinamen aus
der Liste:

```bash
./backups/restore-test-script.sh kunde_beispiel_20260820-030000.dump.age
```

Das spielt die Sicherung in eine Wegwerf-Datenbank, zählt Tabellen und Zeilen
und räumt sie wieder ab. **Deine Produktivdaten werden dabei nicht berührt.**
Erwartet am Ende:

```
RESTORE_TEST_RESULT:OK:<Tabellen>:<Zeilen>
```

Zum Schluss im Dashboard unter **Backups** nachsehen: Oben steht das Panel
„Im Object Storage" mit dem Bestand, darunter die Liste der Sicherungen.

---

## Ab jetzt läuft es allein

| Wann | Was |
|---|---|
| täglich 03:00 | Sicherung hochladen, Läufe über der Grenze entfernen |
| täglich | Alarm, wenn seit 36 h kein Backup erfolgreich war |
| täglich | Alarm, wenn der age-Schlüssel fehlt oder die DR-Bestätigung veraltet |
| wöchentlich | automatischer Restore-Test der am längsten ungeprüften Datenbank |

Du musst nichts mehr anklicken. Melden sollte sich das System nur, wenn etwas
nicht stimmt.

---

## Wenn wirklich etwas passiert

Reihenfolge einhalten, sie ist nicht beliebig:

```bash
# 1. DR-Bundle entpacken (Passphrase aus Schritt 6)
age -d /pfad/zu/dr-bundle-*.tar.gz.age | tar xz -C /opt/multitenant-platform

# 2. Rollen und Passwörter zuerst — sonst scheitert jeder weitere Restore
./backups/restore-script.sh globals

# 3. Konfiguration (Zertifikate, Tenant-Instanzen)
./backups/restore-script.sh config config_<datum>.tar.gz.age

# 4. Datenbanken, admin_dashboard zuerst
./backups/restore-script.sh db admin_dashboard_<datum>.dump.age
./backups/restore-script.sh db kunde_<slug>_<datum>.dump.age

# 5. Dateien der Kunden
./backups/restore-script.sh minio minio_<datum>.tar.gz.age

# 6. Alles wieder starten
./scripts/redeploy.sh
```

Jeder Schritt fragt vorher nach und will ein getipptes `JA`. Der
`db`-Modus überschreibt die Zieldatenbank vollständig.
