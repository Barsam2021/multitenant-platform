# Backup testen — der Abnahmeplan

Einrichtung: [BACKUP-EINRICHTEN.md](BACKUP-EINRICHTEN.md). Dieses Dokument
beantwortet die andere Frage: **Woher weißt du, dass es wirklich funktioniert?**

Ein Backup, das nie zurückgespielt wurde, ist kein Backup — es ist eine
Vermutung. Die folgenden neun Tests machen aus der Vermutung eine Tatsache.
Dauer: etwa 45 Minuten, plus eine halbe Stunde Wartezeit bei Test 8.

## Bevor du anfängst

Mehrere Tests verändern vorübergehend die `.env`. Sicherungskopie anlegen —
und zwar so, dass du am Ende zweifelsfrei zurückkommst:

```bash
cd /opt/multitenant-platform
cp .env .env.vor-test
```

Am Ende steht die Rücksetz-Checkliste. **Die ist nicht optional.** Ein Test,
der versehentlich dauerhaft scharf bleibt, ist schlimmer als kein Test.

Noch eine Eigenheit dieses Projekts: Der Agent liegt in einem Unterverzeichnis,
die `.env` aber im Wurzelverzeichnis. Compose findet sie deshalb nur mit
`--env-file` — genau so machen es auch `bootstrap.sh` und `redeploy.sh`. Ohne
den Zusatz startet der Container zwar, bekommt deine geänderten Werte aber
nicht zu sehen, und der Test misst dann nichts. Der Neustart-Befehl lautet
daher überall:

```bash
(cd /opt/multitenant-platform/provisioning-agent && docker compose --env-file /opt/multitenant-platform/.env up -d)
```

---

## Test 1 — Landet überhaupt etwas beim Anbieter?

```bash
./backups/backup-script.sh
```

Die Ausgabe muss enden mit:

```
Backup vollstaendig: Globals, N Datenbanken, MinIO, Config.
```

Darüber steht die Selbstabrechnung, z. B.
`Neuer Lauf: 820 MB in 5 Dateien.`

Gegenprobe beim Anbieter — das ist der eigentliche Beweis, nicht die
Erfolgsmeldung des Skripts:

```bash
./backups/restore-script.sh list
```

**Bestanden**, wenn dort Globals, jede `kunde_*`-Datenbank, MinIO und Config
mit aktuellem Zeitstempel stehen.

---

## Test 2 — Ist die Sicherung lesbar, nicht nur vorhanden?

Vorhandensein sagt nichts. Nimm einen Datenbank-Dateinamen aus Test 1:

```bash
./backups/restore-test-script.sh kunde_beispiel_20260820-030000.dump.age
```

Das lädt die Datei, entschlüsselt sie, spielt sie in eine **Wegwerf-Datenbank**
und zählt Tabellen und Zeilen. Produktivdaten werden nicht berührt.

**Bestanden** bei:

```
RESTORE_TEST_RESULT:OK:<Tabellen>:<Zeilen>
```

Steht dort `OK:0:0` oder bricht es ab, ist die Sicherung wertlos — dann hier
aufhören und der Ursache nachgehen.

---

## Test 3 — Lässt sich das DR-Bundle entschlüsseln?

**Der wichtigste Test des ganzen Plans, und der am häufigsten übersprungene.**

Alles andere setzt voraus, dass du im Ernstfall an den age-Schlüssel kommst.
Ein Bundle, dessen Passphrase falsch notiert ist, merkst du sonst genau
einmal — wenn es zu spät ist.

Auf **deinem eigenen Rechner**, nicht auf dem Server:

```bash
age -d ~/Downloads/dr-bundle-2026-08-20.tar.gz.age | tar tz
```

Du wirst nach der Passphrase gefragt. **Bestanden**, wenn genau diese drei
Zeilen erscheinen:

```
backups/age-identity.txt
backups/rclone.conf
.env
```

Schlägt es fehl: Bundle neu erzeugen (Schritt 6 der Einrichtung) und diesen
Test wiederholen, bevor du weitermachst.

---

## Test 4 — Hält die Speichergrenze, wenn nichts mehr passt?

Wir setzen das Budget künstlich unter die Größe eines einzelnen Laufs. Das
Skript muss dann **alles unangetastet lassen**.

Vorher den Ist-Stand festhalten:

```bash
rclone --config backups/rclone.conf size r2:multitenant-backup
```

Budget auf 1 MB setzen und Backup starten:

```bash
sed -i 's/^BACKUP_MAX_TOTAL_BYTES=.*/BACKUP_MAX_TOTAL_BYTES=1000000/' .env
./backups/backup-script.sh
```

**Bestanden**, wenn die Ausgabe sinngemäß meldet:

```
FEHLER: Der Lauf (820 MB) passt nicht in das Budget von 0 MB
```

und der Bestand danach **unverändert** ist:

```bash
rclone --config backups/rclone.conf size r2:multitenant-backup
```

Das ist die Zusicherung, auf die es ankommt: lieber kein neues Backup als ein
halbes, für das die alten geopfert wurden.

```bash
# ZURÜCKSETZEN
sed -i 's/^BACKUP_MAX_TOTAL_BYTES=.*/BACKUP_MAX_TOTAL_BYTES=9000000000/' .env
```

---

## Test 5 — Räumt es auf, statt über die Grenze zu gehen?

Jetzt die andere Richtung: Budget knapp über einen Lauf, aber unter zwei. Das
Skript muss alte Läufe entfernen, **bevor** es hochlädt.

Größe eines Laufs ermitteln (aus Test 1) und ungefähr das 1,5-fache eintragen —
bei 820 MB also etwa 1,2 GB:

```bash
sed -i 's/^BACKUP_MAX_TOTAL_BYTES=.*/BACKUP_MAX_TOTAL_BYTES=1200000000/' .env
./backups/backup-script.sh
./backups/backup-script.sh
```

**Bestanden**, wenn im Log Zeilen wie `Aeltesten Lauf entfernt: …` auftauchen
und am Ende nur noch **ein** Lauf beim Anbieter liegt:

```bash
./backups/restore-script.sh list
rclone --config backups/rclone.conf size r2:multitenant-backup
```

Die Größe muss unter 1,2 GB liegen — zu keinem Zeitpunkt darüber.

```bash
# ZURÜCKSETZEN
sed -i 's/^BACKUP_MAX_TOTAL_BYTES=.*/BACKUP_MAX_TOTAL_BYTES=9000000000/' .env
```

---

## Test 6 — Meldet sich das System, wenn das Backup ausbleibt?

Der Totmannschalter ist der Alarm, der dich rettet, wenn der Cron stillschweigend
nicht mehr läuft. Er wartet normalerweise 36 Stunden — die drehen wir auf null.

```bash
sed -i 's/^BACKUP_MAX_AGE_HOURS=.*/BACKUP_MAX_AGE_HOURS=0/' .env
(cd /opt/multitenant-platform/provisioning-agent && docker compose --env-file /opt/multitenant-platform/.env up -d)
docker logs -f provisioning-agent
```

Die Prüfung läuft **3 Minuten nach dem Start**. **Bestanden**, wenn im Log
erscheint:

```
[ALERT] Backup ueberfaellig
```

Ist `RESEND_API_KEY` gesetzt, kommt zusätzlich eine Mail an `ADMIN_EMAIL` —
prüfe das Postfach, denn genau dieser Weg muss im Ernstfall funktionieren.

```bash
# ZURÜCKSETZEN
sed -i 's/^BACKUP_MAX_AGE_HOURS=.*/BACKUP_MAX_AGE_HOURS=36/' .env
(cd /opt/multitenant-platform/provisioning-agent && docker compose --env-file /opt/multitenant-platform/.env up -d)
```

---

## Test 7 — Merkt es, wenn der Schlüssel fehlt?

Ohne die age-Identity ist kein Restore möglich. Das darf nicht erst im
Ernstfall auffallen.

```bash
mv backups/age-identity.txt backups/age-identity.txt.test
(cd /opt/multitenant-platform/provisioning-agent && docker compose --env-file /opt/multitenant-platform/.env up -d)
docker logs -f provisioning-agent
```

**Bestanden** bei `[ALERT] Restore nicht moeglich: age-Identity fehlt`
(nach 3 Minuten).

```bash
# ZURÜCKSETZEN — unbedingt, sonst schlägt das nächste Backup fehl!
mv backups/age-identity.txt.test backups/age-identity.txt
(cd /opt/multitenant-platform/provisioning-agent && docker compose --env-file /opt/multitenant-platform/.env up -d)
```

Dieselbe Prüfung mahnt auch ein veraltetes DR-Bundle an. Zum Ausprobieren
`BACKUP_DR_BUNDLE_CONFIRMED_AT` leeren, Agent neu starten, Alarm
`Off-Site-DR-Bundle unbestaetigt` abwarten — und das Datum danach wieder
eintragen.

---

## Test 8 — Prüft das System sich selbst, ohne dass du etwas tust?

Der automatische Restore-Test läuft normalerweise wöchentlich. Für die Abnahme
setzen wir das Intervall auf null; der Agent prüft 30 Minuten nach dem Start,
ob wieder einer fällig ist.

```bash
sed -i 's/^BACKUP_RESTORE_TEST_INTERVAL_DAYS=.*/BACKUP_RESTORE_TEST_INTERVAL_DAYS=0/' .env
(cd /opt/multitenant-platform/provisioning-agent && docker compose --env-file /opt/multitenant-platform/.env up -d)
```

Dann eine halbe Stunde warten und nachsehen:

```bash
docker logs provisioning-agent | grep -i restore
```

**Bestanden** bei `Geplanter Restore-Test: …` gefolgt von `Restore-Test ok: …`.
Im Dashboard erscheint dazu eine grün markierte Zeile
**„Restore-Test bestanden"** zwischen den Sicherungen.

```bash
# ZURÜCKSETZEN
sed -i 's/^BACKUP_RESTORE_TEST_INTERVAL_DAYS=.*/BACKUP_RESTORE_TEST_INTERVAL_DAYS=7/' .env
(cd /opt/multitenant-platform/provisioning-agent && docker compose --env-file /opt/multitenant-platform/.env up -d)
```

---

## Test 9 — Stimmt, was das Dashboard zeigt?

Im Dashboard unter **Backups**:

| Was | Erwartung |
|---|---|
| Panel „Im Object Storage" | Dateizahl und Größe stimmen mit `restore-script.sh list` überein |
| Auslastungsbalken | zeigt „X % von 9 GB belegt", grün |
| Liste | die Sicherungen aus Test 1, plus die Restore-Test-Zeile aus Test 8 |
| Knopf „Backup jetzt starten" | läuft durch (schlug vor der Korrektur von B-9 immer fehl) |
| Knopf „Restore-Test" | läuft auf einer `kunde_*`-Zeile durch (schlug vor B-2 immer fehl) |

Weicht das Panel von `restore-script.sh list` ab, glaube der Kommandozeile:
sie fragt den Anbieter direkt.

---

## Rücksetz-Checkliste

Nach allen Tests — Punkt für Punkt abhaken:

```bash
cd /opt/multitenant-platform
diff .env .env.vor-test && echo "✓ .env ist wieder im Ausgangszustand"
ls -l backups/age-identity.txt && echo "✓ age-Schlüssel liegt wieder da"
(cd /opt/multitenant-platform/provisioning-agent && docker compose --env-file /opt/multitenant-platform/.env up -d)
```

Zeigt `diff` Unterschiede, die du nicht bewusst willst:

```bash
cp .env.vor-test .env
(cd /opt/multitenant-platform/provisioning-agent && docker compose --env-file /opt/multitenant-platform/.env up -d)
```

Zum Abschluss ein letzter normaler Lauf, damit der Endzustand nachweislich
gesund ist:

```bash
./backups/backup-script.sh
./backups/restore-script.sh list
```

Danach `rm .env.vor-test` — die Datei enthält Geheimnisse und hat auf dem
Server nichts verloren.

---

## Was diese Tests *nicht* beweisen

Ehrlichkeit gehört zu einem Abnahmeplan:

- **Der vollständige Ernstfall.** Getestet ist, dass sich einzelne Datenbanken
  zurückspielen lassen. Ob die *gesamte* Plattform auf einem frischen Server
  wieder hochkommt, weiß man erst, wenn man es einmal gemacht hat. Das braucht
  einen zweiten Server und einen halben Tag — und ist die einzige Übung, die
  wirklich alles abdeckt.
- **Wie lange ein Restore dauert.** Das RTO ist ungemessen. Bei der nächsten
  Gelegenheit mit der Uhr danebenstehen und das Ergebnis in
  [OPERATIONS.md](OPERATIONS.md) eintragen.
- **Ob die Alarme dich erreichen.** Test 6 zeigt sie im Log. Ob die Mail auch
  ankommt, hängt an Resend und deinem Spamfilter — deshalb dort das Postfach
  wirklich prüfen und nicht nur das Log.
