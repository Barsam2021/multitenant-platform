# Backup- und Restore-Plan

Status: **umgesetzt** (alle vier Phasen). Dieses Dokument beschreibt den
Ausgangszustand, die gefundenen Fehler und was daraus geworden ist. Der
Betriebsstand steht in [OPERATIONS.md](OPERATIONS.md#backups).

Verwandte Dokumente: [OPERATIONS.md](OPERATIONS.md) (Betrieb),
[../SETUP.md](../SETUP.md) (Erstinstallation), [CVE-PLAN.md](CVE-PLAN.md).

---

## 1. Kurzfassung

Ein tägliches Backup **existiert bereits** und ist vollständig verdrahtet:
`backups/backup-script.sh` läuft per `/etc/cron.d/multitenant-backup` jede Nacht
um 03:00, `bootstrap.sh` installiert den Cron-Eintrag. Gesichert werden
Postgres-Globals, `admin_dashboard` und jede `kunde_*`-Datenbank, MinIO und die
Konfiguration — verschlüsselt mit `age`, hochgeladen per `rclone`.

Die Arbeit war deshalb **kein Neubau**, sondern das Schließen von zehn Lücken.
Vier davon waren Fehler im laufenden Code — zwei erst bei der Umsetzung
gefunden, und der letzte ist der schwerwiegendste im ganzen Aufbau:

- **B-10** `restore-script.sh` konnte **keinen einzigen Restore durchführen**.
  Schlimmer noch: der `db`-Modus droppte die Zieldatenbank, spielte dann nichts
  ein und meldete trotzdem „wiederhergestellt." mit Exitcode 0. Nachgewiesen
  und behoben, siehe unten.
- **B-9** Über das Dashboard gestartete Backups und Restore-Tests scheiterten
  am Socket-Proxy (`EXEC: 0`).
- **B-2** Der Restore-Test lehnte genau die Dateinamen ab, die das
  Backup-Skript für Datenbanken erzeugt.
- **B-1** Der age-Key liegt nur auf dem Server, gegen dessen Verlust gesichert
  wird. Ohne Off-Site-Kopie sind alle Backups unlesbare Bytes.

---

## 2. Ausgangszustand (vor dieser Arbeit)

### 2.1 Was schon lief

| Baustein | Ort | Bewertung |
|---|---|---|
| Tägliches Backup 03:00 | `backups/cron.d-multitenant-backup` | vorhanden, von `bootstrap.sh:93-97` installiert |
| Backup-Lauf | `backups/backup-script.sh` | Globals → DBs (`-Fc`) → MinIO → Config, je Schritt eigener Fehlerpfad |
| Verschlüsselung | `age -r $BACKUP_AGE_PUBLIC_KEY` | asymmetrisch, Server braucht den privaten Key für das Backup **nicht** |
| Off-Site-Ablage | `rclone copy` nach `$RCLONE_REMOTE_PATH` | Anbieter frei (B2, S3, SFTP …) |
| Echter Restore | `backups/restore-script.sh` | Modi `list\|globals\|db\|config\|minio`, mit Tippbestätigung „JA" |
| Restore-Test | `backups/restore-test-script.sh` | Wegwerf-DB `<db>_restoretest`, prüft Tabellen **und** Zeilen |
| Alarm bei Fehlschlag | `send_alert()` im Backup-Skript | Resend-Mail an `ADMIN_EMAIL` |
| Protokoll | Tabelle `backups` (`core-postgres/init-scripts/05_backups.sql`) | eine Zeile pro Artefakt |
| Steuerung/UI | `provisioning-agent/src/routes/backups.ts`, `dashboard/src/app/dashboard/backups/page.tsx` | Liste, „Jetzt sichern", „Restore-Test" |

### 2.2 Kennzahlen davor

- **RPO** (maximaler Datenverlust): bis zu 24 h — es gibt kein WAL-Archiv,
  nur den nächtlichen Dump.
- **RTO** (Zeit bis Wiederherstellung): unbestimmt, weil rein manuell über die
  Kommandozeile und nirgends gestoppt.
- **Aufbewahrung**: lokal 3 Tage (`BACKUP_RETENTION_DAYS=3`), remote nur wenn
  `BACKUP_REMOTE_RETENTION_DAYS` gesetzt ist — die Variable fehlt in
  `.env.example`, ist also faktisch unbegrenzt oder ungeregelt.

---

## 3. Die gefundenen Lücken

### B-1 — Der Schlüssel liegt im brennenden Haus  (Schwere: kritisch)

`BACKUP_AGE_IDENTITY_FILE=/opt/multitenant-platform/backups/age-identity.txt`
(`.env.example:111`). Das Backup enthält die `.env`, verschlüsselt mit dem
age-Key — dessen privater Teil ausschließlich auf demselben Server liegt.
Stirbt der Server, liegen im Object Storage nur noch Bytes, die niemand mehr
entschlüsseln kann. `OPERATIONS.md:331` benennt das Risiko, aber es gibt kein
Verfahren, das die Kopie erzwingt oder ihr Vorhandensein prüft.

**Behoben:** DR-Bundle als bewusster, dokumentierter Schritt —
`age-identity.txt` + `rclone.conf` + `.env` in einen Passwortmanager oder ein
zweites, getrenntes Konto. Dazu eine tägliche Prüfung im Agent, die laut
wird, wenn `BACKUP_DR_BUNDLE_CONFIRMED_AT` in der `.env` fehlt oder älter als
180 Tage ist — und ebenso, wenn die Identity-Datei auf dem Server gar nicht
existiert, denn dann ist ein Restore schon heute unmöglich.

### B-2 — Restore-Test aus dem Dashboard lehnt alle DB-Dumps ab  (Schwere: hoch)

`provisioning-agent/src/routes/backups.ts:74` prüft
`/^[a-zA-Z0-9_.-]+\.sql\.gz\.age$/`. Das Backup-Skript erzeugt Datenbanken
aber als `-Fc`-Dump, also `<db>_<ts>.dump.age`; nur die Globals sind
`.sql.gz.age`. Das Dashboard schickt den Dateinamen aus der `backups`-Tabelle
(`page.tsx:104-110`) und bekommt für jede Datenbank ein `400 invalid filename`.
Der Knopf, mit dem geprüft werden soll, ob die Backups etwas taugen,
funktioniert für den wichtigsten Fall nicht.

**Behoben:** Regex auf `\.(dump|sql\.gz)\.age$` erweitern — dieselbe Prüfung,
die `restore-test-script.sh:34` schon korrekt macht.

### B-3 — `encrypt_failed` verletzt den CHECK-Constraint  (Schwere: mittel)

`backup-script.sh` schreibt bei fehlgeschlagener Verschlüsselung den Status
`encrypt_failed`. `05_backups.sql:9` erlaubt aber nur
`('ok','dump_failed','upload_failed')`. Der INSERT scheitert, das Skript
protokolliert nur eine Warnung — der Fehlerfall hinterlässt in der Tabelle
also **keine** Spur. Genau der Zustand, den die Tabelle sichtbar machen soll.

**Behoben:** Migration `23_backups_status.sql`: Constraint um
`encrypt_failed` und `restore_test_ok`/`restore_test_failed` erweitern.

### B-4 — Kein Alarm, wenn das Backup gar nicht erst läuft  (Schwere: hoch)

`send_alert()` feuert nur aus dem laufenden Skript heraus. Fällt der Cron aus
(Server aus, `cron` nach `bootstrap.sh` nie neu geladen, Skript nicht
ausführbar), passiert schlicht nichts — und Stille sieht genauso aus wie Erfolg.

**Behoben:** Totmannschalter im Agent. Täglicher Check gegen
`SELECT max(created_at) FROM backups WHERE status='ok'`; ist der letzte
erfolgreiche Lauf älter als 36 h, Alarm über `lib/alert.ts` (existiert bereits,
inkl. Dedupe-Fenster).

### B-5 — Restore ist nur ein Kommandozeilen-Vorgang  (Schwere: mittel)

`restore-script.sh` ist gut, aber der Betreiber muss im Ernstfall SSH haben,
den Pfad kennen und die richtige Reihenfolge im Kopf haben. Im Dashboard gibt
es keinen Weg zurück — und `GET /backups` liest die `backups`-Tabelle, die
nach einem Totalverlust selbst weg ist. Was tatsächlich im Object Storage
liegt, sieht man nur über `restore-script.sh list`.

**Behoben:** `GET /backups/remote` im Agent (`rclone lsjson`), im Dashboard
als zweite Spalte „im Object Storage vorhanden". Der schreibende Restore
bleibt bewusst CLI-only — ein Knopf, der die Produktivdatenbank überschreibt,
gehört nicht hinter ein Web-Login.

### B-6 — Kein automatischer Restore-Test  (Schwere: mittel)

Der Test existiert, muss aber von Hand angestoßen werden. `OPERATIONS.md:328`
sagt selbst: „Ein Backup, das nie zurückgespielt wurde, ist kein Backup."

**Behoben:** wöchentlicher Lauf im Agent (Sonntag, versetzt zum Backup),
rotierend über die Tenants, Ergebnis in `backups` als eigene Zeile, Alarm bei
Fehlschlag.

### B-7 — Aufbewahrung ohne Generationen  (Schwere: mittel)

3 Tage lokal, remote ungeregelt. Ein Schaden, der erst nach einer Woche
auffällt (schleichende Korruption, versehentliches `DELETE`, Ransomware), ist
dann nicht mehr rückholbar.

**Behoben:** Großvater-Vater-Sohn — 7 Tage täglich, 4 Wochen wöchentlich,
6 Monate monatlich; umgesetzt über `rclone`-Präfixe `daily/`, `weekly/`,
`monthly/` und `--min-age`-Löschläufe. `BACKUP_REMOTE_RETENTION_DAYS` und die
neuen Variablen in `.env.example` dokumentieren.

### B-8 — Dokumentation weicht vom Code ab  (Schwere: gering)

`OPERATIONS.md:328-329` behauptet, der Restore-Test schreibe sein Ergebnis in
die `backups`-Tabelle. Tatsächlich schrieb `routes/backups.ts` nur ins
Audit-Log. Mit B-6 stimmt der Satz — vorher nicht.

### B-9 — Backup und Restore-Test aus dem Dashboard scheiterten immer  (Schwere: hoch)

*Erst bei der Umsetzung gefunden, im Plan nicht vorgesehen.*

`routes/backups.ts` startete beide Skripte per `execFileP('bash', …)` ohne
eigene Umgebung, also mit der des Agents — inklusive
`DOCKER_HOST=tcp://docker-socket-proxy:2375`. Am Proxy steht aber `EXEC: 0`
(`provisioning-agent/docker-compose.yml:26`), und beide Skripte arbeiten
ausschließlich über `docker exec core-postgres pg_dump …`. Jeder Aufruf lief
damit in ein 403.

Aus dem Cron fiel das nie auf: der läuft auf dem Host, ganz ohne `DOCKER_HOST`.
Über das Dashboard funktionierte dagegen weder „Backup jetzt starten" noch
„Restore-Test" — und weil `POST /backups/run` sofort `{status:'started'}`
zurückgibt und den Fehler nur ins Agent-Log schreibt, sah die Oberfläche dabei
zufrieden aus.

**Behoben:** eigenes `SCRIPT_ENV` mit `DOCKER_HOST=unix:///var/run/docker.sock`
für diese Kindprozesse — dieselbe Ausnahme, die `lib/nixpacks.ts:117` für
BuildKit schon macht. Der Socket ist ohnehin gemountet, zusätzliche Rechte
entstehen dadurch nicht.

### B-10 — Der Restore konnte nie funktionieren  (Schwere: kritisch)

*Erst bei der Umsetzung gefunden. Der schwerwiegendste Befund.*

`restore-script.sh` gibt den Pfad der entschlüsselten Datei aus `fetch()` über
**stdout** zurück und fängt ihn mit `PLAIN=$(fetch "$FN" "$TMP")` auf. Die
Funktion `log()` schrieb aber ebenfalls nach stdout. `$PLAIN` enthielt damit
zwei Zeilen:

```
[restore] Lade kunde_foo_20260810-030000.dump.age ...
/tmp/restore-1234/kunde_foo_20260810-030000.dump
```

Jedes nachfolgende `pg_restore < "$PLAIN"`, `gunzip -c "$PLAIN"` und
`tar xzf "$PLAIN"` lief damit auf einen Dateinamen, den es nicht gibt.

Der `db`-Modus macht daraus einen Datenverlust: er trennt alle Verbindungen,
droppt die Datenbank und legt sie leer neu an — **bevor** er den Dump anfasst.
Der anschließende Fehler wird von `|| log "WARNUNG: pg_restore meldete Fehler"`
aufgefangen, das Skript läuft weiter, meldet „Datenbank … wiederhergestellt."
und endet mit Exitcode 0.

Nachgestellt mit Stubs für `rclone`, `age` und `docker`, alte Fassung gegen
neue, identische Bedingungen:

```
=== ALTE Fassung ===
[restore] WARNUNG: pg_restore meldete Fehler — Ausgabe pruefen
[restore] Datenbank kunde_foo wiederhergestellt.
Exitcode: 0
--- pg_restore-Eingang: (nichts angekommen)

=== NEUE Fassung ===
[restore] Datenbank kunde_foo wiederhergestellt (42 Tabellen).
Exitcode: 0
--- pg_restore-Eingang: ECHTER-DUMP-INHALT
```

**Behoben, dreifach:**

1. `log()` und `die()` schreiben nach stderr. Der Rückgabewert von `fetch()`
   ist damit wieder ausschließlich der Pfad.
2. Fehlt die Datei im Object Storage, bricht das Skript ab, **bevor** die
   Datenbank angefasst wird (vorher: erst droppen, dann scheitern).
3. Nach dem Einspielen wird die Tabellenzahl geprüft. Null Tabellen ist jetzt
   ein Abbruch mit Hinweis auf den noch entschlüsselten Dump — ein leerer
   Erfolg ist beim Restore der gefährlichste Ausgang, weil er die Suche nach
   der Ursache beendet, bevor sie beginnt.

### B-11 — Beim Löschen blieb jedes Mal eine Datei liegen  (Schwere: hoch)

*Gefunden durch den Prüfstand zur Budget-Einhaltung.*

Die Löschschleife für einen kompletten Lauf las die Pfadliste mit
`while IFS= read -r p; do … done < <(printf '%s' "$paths" | tr ',' '\n')`.
Die Liste endet ohne Zeilenumbruch, und `read` liefert für das letzte Feld
zwar den Wert, gibt aber einen Fehlercode zurück — der Schleifenrumpf lief für
dieses Feld nie. **Von jedem gelöschten Lauf blieb genau eine Datei liegen.**

Das ist kein kosmetischer Fehler: Der Bestand wäre Nacht für Nacht um eine
verwaiste Datei gewachsen, bis das Budget doch gerissen wäre — schleichend und
ohne erkennbare Ursache.

**Behoben:** `while IFS= read -r p || [ -n "$p" ]`. Zusätzlich löst eine
teilweise fehlgeschlagene Löschung jetzt ein Neu-Einlesen des echten Bestands
aus, statt mit einer zu niedrigen Belegungszahl weiterzurechnen.

### B-12 — Die Budgetprüfung kam zu spät und schätzte  (Schwere: kritisch)

*Aufgeworfen durch eine Rückfrage beim Review, bestätigt durch den Prüfstand.*

Der erste Entwurf lud hoch und räumte **danach** auf. Zwischenzeitlich lagen
alter Bestand und neuer Lauf gleichzeitig beim Anbieter — bei drei
aufbewahrten Läufen zu je 3 GB kurzzeitig 12 GB. Für ein Gratiskontingent mit
harter Grenze ist das wertlos.

Der zweite Entwurf prüfte vorher, schätzte die Größe des kommenden Laufs aber
aus dem jüngsten vorhandenen. War der selbst unvollständig — weil eine frühere
Nacht abgebrochen war —, fiel die Schätzung beliebig zu klein aus. Der
Prüfstand zeigte den Ausgang: Das Skript löschte den **letzten vollständigen
Lauf**, um Platz für einen zu schaffen, der gar nicht hineinpasste, und ließ
einen unvollständigen zurück.

**Behoben durch einen zweistufigen Ablauf.** Phase 1 erzeugt und
verschlüsselt alles lokal und misst die *echte* Größe. Phase 2 entscheidet
damit ohne Schätzung: Passt der Lauf nicht ins Budget, bleibt alles unberührt
und es gibt einen Alarm. Passt er, wird genau so viel Altbestand entfernt wie
nötig — notfalls alles — und erst dann hochgeladen.

Nachgewiesen mit einem Prüfstand, der nach **jedem** Upload die Gesamtgröße
misst:

| Szenario | Ergebnis |
|---|---|
| 6 Läufe, Budget 10 MB | 3 Läufe behalten (`KEEP_RUNS` greift), Maximum 9,0 MB |
| 6 Läufe, Budget 4 MB | 1 Lauf behalten (Budget greift), Maximum 3,0 MB |
| Budget kleiner als ein Lauf | nichts gelöscht, nichts hochgeladen, Alarm |
| Budget im Betrieb gesenkt | konvergiert nach unten, kein Upload über der Grenze |

---

## 4. Zielbild

```
03:00  cron ──▶ backup-script.sh
                 ├─ globals, admin_dashboard, kunde_*  (-Fc)
                 ├─ MinIO, Config
                 ├─ age-verschlüsselt ──▶ rclone ──▶ daily/ | weekly/ | monthly/
                 └─ jede Zeile ──▶ Tabelle `backups`

04:30  Agent ──▶ Totmannschalter: letzter ok-Lauf älter als 36 h? ──▶ alert()

So 05:00  Agent ──▶ Restore-Test (rotierend, eine DB pro Woche)
                 └─ Ergebnis ──▶ `backups` + Alarm bei Fehlschlag

jederzeit  Dashboard ──▶ Liste lokal + Object Storage, „Jetzt sichern",
                          „Restore-Test", Datum des letzten grünen Tests
Ernstfall  CLI     ──▶ restore-script.sh  (globals → config → DBs → minio)
```

**Kennzahlen:** RPO 24 h (unverändert — WAL-Archivierung siehe §7). Das RTO
ist weiterhin **ungemessen**: der Restore funktioniert jetzt nachweislich, aber
wie lange er auf echten Datenmengen braucht, weiß niemand, bis es jemand einmal
mit der Uhr macht. Das ist die nächste offene Aufgabe, siehe §7.

---

## 5. Was umgesetzt wurde

### Phase 1 — Die Fehler im laufenden Code

| Datei | Änderung |
|---|---|
| `provisioning-agent/src/routes/backups.ts` | `BACKUP_FILENAME_RE` akzeptiert `.dump.age` **und** `.sql.gz.age` (B-2); `SCRIPT_ENV` biegt `DOCKER_HOST` für die Skript-Kindprozesse auf den rohen Socket um (B-9) |
| `core-postgres/init-scripts/23_backups_status.sql` | neu: CHECK-Constraint um `encrypt_failed`, `restore_test_ok`, `restore_test_failed` erweitert; zwei Indizes für die neuen Abfragen (B-3) |
| `backups/restore-script.sh` | `log()`/`die()` nach stderr, Abbruch vor dem `DROP`, Tabellenprüfung nach dem Restore (B-10) |

### Phase 2 — Nicht mehr blind sein

| Datei | Änderung |
|---|---|
| `provisioning-agent/src/lib/backupHealth.ts` | neu: `checkBackupFreshness()` (Totmannschalter **und** Prüfung je Datenbank), `checkDisasterRecoveryReadiness()`, `listRemoteBackups()` |
| `provisioning-agent/src/index.ts` | tägliche Gesundheitsprüfung 3 min nach Start, danach im 24-h-Takt |
| `provisioning-agent/src/routes/backups.ts` | `GET /backups/remote` (rclone `lsjson -R`), Antwort `502` statt `500`, wenn der Anbieter klemmt |
| `dashboard/src/app/api/backups/remote/route.ts` | neu |
| `dashboard/src/app/dashboard/backups/page.tsx` | Panel „Im Object Storage" mit Bestand je Generation |
| `.env.example`, `provisioning-agent/docker-compose.yml` | neue Variablen — und durchgereicht, sonst hätte ein Eintrag in der `.env` keine Wirkung |
| `SETUP.md` | DR-Bundle als konkrete Befehlsfolge statt Verweis auf ein Skript, das es im Repo nicht gibt |

Der Freshness-Check prüft zwei Dinge statt einem. Neben „läuft überhaupt noch
etwas" auch „fehlt einer *einzelnen* Datenbank ein frisches Backup" — der
unangenehmere Fall: ein Tenant scheitert jede Nacht, alle anderen laufen durch,
und die jüngste Zeile in `backups` ist deshalb taufrisch. Beide Fälle haben
eigene Alarmtexte und eigene Dedupe-Schlüssel.

### Phase 3 — Der Test, der von allein läuft

| Datei | Änderung |
|---|---|
| `provisioning-agent/src/lib/backupHealth.ts` | `runScheduledRestoreTest()` + `runScheduledRestoreTestIfDue()`; gemeinsame Sperre für geplante und manuelle Läufe |
| `provisioning-agent/src/index.ts` | alle 6 h prüfen, ob wieder ein Test fällig ist |
| `dashboard/.../backups/page.tsx` | Testergebnisse als eigene, farbig markierte Zeilen |
| `docs/OPERATIONS.md` | §Backups auf den tatsächlichen Stand gezogen (B-8) |

Zwei Entscheidungen, die Ärger sparen: Der Takt kommt aus der Datenbank, nicht
aus einem Zähler im Speicher — ein Agent-Neustart ist bei Deployments Alltag und
würde einen In-Memory-Takt jedes Mal zurücksetzen. Und die Sperre liegt im
Modul, nicht in der Route: vorher hätte ein geplanter Lauf nicht gesehen, dass
im Dashboard gerade jemand denselben Test angestoßen hat.

### Phase 4 — Generationen

| Datei | Änderung |
|---|---|
| `backups/backup-script.sh` | Zielordner aus dem Datum: `monthly/` am Ersten, `weekly/` sonntags, sonst `daily/`; Retention je Ordner |
| `backups/restore-script.sh` | `resolve_remote_path()` findet eine Datei in allen drei Ordnern und im Altbestand |

`--max-depth 1` bei jedem `rclone delete` ist hier kein Detail: `rclone delete`
arbeitet rekursiv, und ohne die Begrenzung nähme der Aufruf für `daily/` mit
seinen 7 Tagen auch `weekly/` und `monthly/` mit — ein Verlust, der erst
auffällt, wenn man ein altes Backup braucht.

Aufrufer geben weiterhin nur den Dateinamen an. Das Dashboard kennt ohnehin nur
den, und ein Restore-Befehl aus einer alten Notiz funktioniert dadurch weiter.

---

## 5a. Prüfstand

Ausgeführt, nicht behauptet:

| Prüfung | Ergebnis |
|---|---|
| `tsc --noEmit` (provisioning-agent) | 0 Fehler |
| `tsc --noEmit` (dashboard) | 0 Fehler |
| `next lint` (dashboard) | keine Warnungen |
| `npm run build` (dashboard) | erfolgreich |
| `bash -n` für alle geänderten Skripte | Syntax ok |
| Restore mit Stubs für `rclone`/`age`/`docker` | Dump kommt bei `pg_restore` an; alte Fassung nachweislich nicht |
| Restore mit fehlender Datei | bricht ab, **null** `DROP DATABASE`-Aufrufe |

Was ein Testlauf hier **nicht** leisten kann: der Totmannschalter und der
wöchentliche Restore-Test sind zeitgesteuert und brauchen eine laufende
Installation. Ihre Abnahme steht in §6a.

## 6. Betrieb: der Ernstfall in sechs Schritten

Reihenfolge ist nicht optional — sie steht so schon im Kopf von
`restore-script.sh` und gilt unverändert:

1. `.env` und `age-identity.txt` aus dem **Off-Site-DR-Bundle** zurückholen.
2. `./backups/restore-script.sh globals` — ohne Rollen scheitert jeder
   folgende Dump an `OWNER TO` und an jedem `GRANT`.
3. `./backups/restore-script.sh config <datei>` — Traefik-Zertifikate,
   `kunden-instances`.
4. `admin_dashboard`, danach jede `kunde_*`-Datenbank.
5. `./backups/restore-script.sh minio <datei>`.
6. `docker compose up -d` für alle Stacks, dann `scripts/smoke-test.sh`.

---

## 6a. Inbetriebnahme und Abnahme

Die Änderungen greifen erst nach diesen drei Schritten:

```bash
cd /opt/multitenant-platform
git pull
./scripts/migrate.sh                       # Migration 23 einspielen
docker compose -f provisioning-agent/docker-compose.yml up -d --build
docker compose -f dashboard/docker-compose.yml up -d --build
```

Neue Einträge in der `.env` (Vorlage: `.env.example`) — ohne sie gelten die
Defaults aus dem Code, außer beim DR-Bundle:

```
BACKUP_DR_BUNDLE_CONFIRMED_AT=<Datum, an dem das Bundle abgelegt wurde>
```

Fehlt dieser Eintrag, alarmiert der Agent ab dem ersten Lauf — das ist Absicht.

**Abnahme, in dieser Reihenfolge:**

1. Im Dashboard „Backup jetzt starten" — lief vor B-9 nie durch, jetzt schon.
2. Auf einer `kunde_*`-Zeile „Restore-Test" — lief vor B-2 nie durch.
3. Panel „Im Object Storage" zeigt Dateien und ihre Generation.
4. `./backups/restore-script.sh list` zeigt `daily/`-Pfade.
5. Cron testweise auskommentieren → nach 36 h kommt „Backup überfaellig".
6. Nach spätestens 7 Tagen steht eine `restore_test_ok`-Zeile in der Liste,
   ohne dass jemand etwas angeklickt hat.

Schritt 5 und 6 brauchen Zeit und lassen sich hier nicht abkürzen. Wer sie
überspringt, hat den Totmannschalter nicht geprüft, sondern nur eingebaut —
und ein ungeprüfter Alarm ist genau das, was in §3 unter B-4 steht.

---

## 7. Bewusst nicht umgesetzt

- **WAL-Archivierung / Point-in-Time-Recovery.** Würde das RPO von 24 h auf
  Minuten drücken, kostet aber eine dauerhafte Archivstrecke und laufenden
  Speicher auf einem 8-GB-VPS. Vorschlag: erst dann, wenn ein Tenant das
  fachlich braucht — als eigener Plan, nicht nebenbei.
- **Restore per Knopfdruck im Dashboard.** Ein Web-Login, das die
  Produktivdatenbank überschreiben kann, vergrößert die Angriffsfläche mehr,
  als es im Ernstfall Zeit spart.
- **Zweiter Backup-Anbieter.** Sinnvoll, aber erst wenn das DR-Bundle
  tatsächlich abgelegt ist — zwei Kopien nützen nichts, wenn der Schlüssel für
  beide fehlt.
- **Gemessenes RTO.** Ein Restore der größten Tenant-Datenbank mit der Uhr
  daneben, Ergebnis nach OPERATIONS.md. Braucht eine Installation mit echten
  Datenmengen; im Repo lässt sich das nicht beantworten.
- **Ein Alarm, wenn der Object Storage leer ist.** `GET /backups/remote` zeigt
  es im Dashboard an, aber niemand schaut dort nachts hin. Der Totmannschalter
  fragt bisher nur die `backups`-Tabelle, also den Server — nicht den Anbieter.
