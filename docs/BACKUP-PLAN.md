# Backup- und Restore-Plan

Status: Planungsdokument. Der Ist-Zustand ist im Repo vorhanden und wird hier
bewertet; die Maßnahmen sind noch nicht umgesetzt.

Verwandte Dokumente: [OPERATIONS.md](OPERATIONS.md) (Betrieb),
[../SETUP.md](../SETUP.md) (Erstinstallation), [CVE-PLAN.md](CVE-PLAN.md).

---

## 1. Kurzfassung

Ein tägliches Backup **existiert bereits** und ist vollständig verdrahtet:
`backups/backup-script.sh` läuft per `/etc/cron.d/multitenant-backup` jede Nacht
um 03:00, `bootstrap.sh` installiert den Cron-Eintrag. Gesichert werden
Postgres-Globals, `admin_dashboard` und jede `kunde_*`-Datenbank, MinIO und die
Konfiguration — verschlüsselt mit `age`, hochgeladen per `rclone`.

Der Plan ist deshalb **kein Neubau**, sondern das Schließen von sieben Lücken.
Zwei davon sind Fehler, die das System heute schon in einem Ernstfall aus der
Bahn werfen würden:

- **B-1** Der age-Key liegt nur auf dem Server, gegen dessen Verlust gesichert
  wird. Ohne Off-Site-Kopie sind alle Backups unlesbare Bytes.
- **B-2** Der Restore-Test aus dem Dashboard ist für Datenbanken tot: der
  Agent lehnt genau die Dateinamen ab, die das Backup-Skript erzeugt.

---

## 2. Ist-Zustand

### 2.1 Was läuft

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

### 2.2 Kennzahlen heute

- **RPO** (maximaler Datenverlust): bis zu 24 h — es gibt kein WAL-Archiv,
  nur den nächtlichen Dump.
- **RTO** (Zeit bis Wiederherstellung): unbestimmt, weil rein manuell über die
  Kommandozeile und nirgends gestoppt.
- **Aufbewahrung**: lokal 3 Tage (`BACKUP_RETENTION_DAYS=3`), remote nur wenn
  `BACKUP_REMOTE_RETENTION_DAYS` gesetzt ist — die Variable fehlt in
  `.env.example`, ist also faktisch unbegrenzt oder ungeregelt.

---

## 3. Lücken

### B-1 — Der Schlüssel liegt im brennenden Haus  (Schwere: kritisch)

`BACKUP_AGE_IDENTITY_FILE=/opt/multitenant-platform/backups/age-identity.txt`
(`.env.example:111`). Das Backup enthält die `.env`, verschlüsselt mit dem
age-Key — dessen privater Teil ausschließlich auf demselben Server liegt.
Stirbt der Server, liegen im Object Storage nur noch Bytes, die niemand mehr
entschlüsseln kann. `OPERATIONS.md:331` benennt das Risiko, aber es gibt kein
Verfahren, das die Kopie erzwingt oder ihr Vorhandensein prüft.

**Maßnahme:** DR-Bundle als bewusster, dokumentierter Schritt —
`age-identity.txt` + `rclone.conf` + `.env` in einen Passwortmanager oder ein
zweites, getrenntes Konto. Dazu ein Startup-Check im Agent, der laut wird,
wenn `BACKUP_DR_BUNDLE_CONFIRMED_AT` in `.env` älter als 180 Tage ist oder fehlt.

### B-2 — Restore-Test aus dem Dashboard lehnt alle DB-Dumps ab  (Schwere: hoch)

`provisioning-agent/src/routes/backups.ts:74` prüft
`/^[a-zA-Z0-9_.-]+\.sql\.gz\.age$/`. Das Backup-Skript erzeugt Datenbanken
aber als `-Fc`-Dump, also `<db>_<ts>.dump.age`; nur die Globals sind
`.sql.gz.age`. Das Dashboard schickt den Dateinamen aus der `backups`-Tabelle
(`page.tsx:104-110`) und bekommt für jede Datenbank ein `400 invalid filename`.
Der Knopf, mit dem geprüft werden soll, ob die Backups etwas taugen,
funktioniert für den wichtigsten Fall nicht.

**Maßnahme:** Regex auf `\.(dump|sql\.gz)\.age$` erweitern — dieselbe Prüfung,
die `restore-test-script.sh:34` schon korrekt macht.

### B-3 — `encrypt_failed` verletzt den CHECK-Constraint  (Schwere: mittel)

`backup-script.sh` schreibt bei fehlgeschlagener Verschlüsselung den Status
`encrypt_failed`. `05_backups.sql:9` erlaubt aber nur
`('ok','dump_failed','upload_failed')`. Der INSERT scheitert, das Skript
protokolliert nur eine Warnung — der Fehlerfall hinterlässt in der Tabelle
also **keine** Spur. Genau der Zustand, den die Tabelle sichtbar machen soll.

**Maßnahme:** Migration `23_backups_status.sql`: Constraint um
`encrypt_failed` und `restore_test_ok`/`restore_test_failed` erweitern.

### B-4 — Kein Alarm, wenn das Backup gar nicht erst läuft  (Schwere: hoch)

`send_alert()` feuert nur aus dem laufenden Skript heraus. Fällt der Cron aus
(Server aus, `cron` nach `bootstrap.sh` nie neu geladen, Skript nicht
ausführbar), passiert schlicht nichts — und Stille sieht genauso aus wie Erfolg.

**Maßnahme:** Totmannschalter im Agent. Täglicher Check gegen
`SELECT max(created_at) FROM backups WHERE status='ok'`; ist der letzte
erfolgreiche Lauf älter als 36 h, Alarm über `lib/alert.ts` (existiert bereits,
inkl. Dedupe-Fenster).

### B-5 — Restore ist nur ein Kommandozeilen-Vorgang  (Schwere: mittel)

`restore-script.sh` ist gut, aber der Betreiber muss im Ernstfall SSH haben,
den Pfad kennen und die richtige Reihenfolge im Kopf haben. Im Dashboard gibt
es keinen Weg zurück — und `GET /backups` liest die `backups`-Tabelle, die
nach einem Totalverlust selbst weg ist. Was tatsächlich im Object Storage
liegt, sieht man nur über `restore-script.sh list`.

**Maßnahme:** `GET /backups/remote` im Agent (`rclone lsjson`), im Dashboard
als zweite Spalte „im Object Storage vorhanden". Der schreibende Restore
bleibt bewusst CLI-only — ein Knopf, der die Produktivdatenbank überschreibt,
gehört nicht hinter ein Web-Login.

### B-6 — Kein automatischer Restore-Test  (Schwere: mittel)

Der Test existiert, muss aber von Hand angestoßen werden. `OPERATIONS.md:328`
sagt selbst: „Ein Backup, das nie zurückgespielt wurde, ist kein Backup."

**Maßnahme:** wöchentlicher Lauf im Agent (Sonntag, versetzt zum Backup),
rotierend über die Tenants, Ergebnis in `backups` als eigene Zeile, Alarm bei
Fehlschlag.

### B-7 — Aufbewahrung ohne Generationen  (Schwere: mittel)

3 Tage lokal, remote ungeregelt. Ein Schaden, der erst nach einer Woche
auffällt (schleichende Korruption, versehentliches `DELETE`, Ransomware), ist
dann nicht mehr rückholbar.

**Maßnahme:** Großvater-Vater-Sohn — 7 Tage täglich, 4 Wochen wöchentlich,
6 Monate monatlich; umgesetzt über `rclone`-Präfixe `daily/`, `weekly/`,
`monthly/` und `--min-age`-Löschläufe. `BACKUP_REMOTE_RETENTION_DAYS` und die
neuen Variablen in `.env.example` dokumentieren.

### B-8 — Dokumentation weicht vom Code ab  (Schwere: gering)

`OPERATIONS.md:328-329` behauptet, der Restore-Test schreibe sein Ergebnis in
die `backups`-Tabelle. Tatsächlich schreibt `routes/backups.ts:82,89,93` nur
ins Audit-Log. Nach B-6 stimmt der Satz — bis dahin nicht.

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

**Zielkennzahlen:** RPO 24 h (unverändert — WAL-Archivierung siehe §7),
RTO ≤ 60 min für eine einzelne Tenant-Datenbank, ≤ 4 h für die volle Plattform,
beides einmal gemessen und in OPERATIONS.md eingetragen.

---

## 5. Maßnahmen in Reihenfolge

### Phase 1 — Die zwei echten Fehler (ca. ½ Tag)

1. `provisioning-agent/src/routes/backups.ts:74` — Regex auf
   `^[a-zA-Z0-9_.-]+\.(dump|sql\.gz)\.age$`. **(B-2)**
2. Neue Migration `core-postgres/init-scripts/23_backups_status.sql`:
   CHECK-Constraint um `encrypt_failed`, `restore_test_ok`,
   `restore_test_failed` erweitern (per `DROP CONSTRAINT` / `ADD CONSTRAINT`,
   idempotent). **(B-3)**
3. `scripts/migrate.sh` einmal ausführen.

**Abnahme:** „Restore-Test" auf einer `kunde_*`-Zeile im Dashboard läuft durch
und meldet Tabellen- und Zeilenzahl.

### Phase 2 — Nicht mehr blind sein (ca. 1 Tag)

4. `provisioning-agent/src/lib/backupHealth.ts` (neu):
   `checkBackupFreshness()` — letzter `status='ok'`-Eintrag, Schwelle über
   `BACKUP_MAX_AGE_HOURS` (Default 36). **(B-4)**
5. In `index.ts` neben `runCleanup` einhängen — gleiches Muster wie
   `index.ts:598-608`: erster Lauf 5 min nach Start, dann täglich.
6. `GET /backups/remote` in `routes/backups.ts` über `rclone lsjson`,
   im Dashboard als zusätzliche Spalte. **(B-5)**
7. DR-Bundle: `BACKUP_DR_BUNDLE_CONFIRMED_AT` in `.env.example`,
   Startup-Warnung im Agent, Checkliste in `SETUP.md`. **(B-1)**

**Abnahme:** Cron testweise deaktivieren → nach 36 h kommt eine Mail.

### Phase 3 — Der Test, der von allein läuft (ca. 1 Tag)

8. `runScheduledRestoreTest()` in `lib/backupHealth.ts`: nimmt den jüngsten
   `ok`-Dump der am längsten ungetesteten Datenbank, ruft
   `restore-test-script.sh`, schreibt `restore_test_ok` /
   `restore_test_failed` in `backups`, alarmiert bei Fehlschlag. **(B-6)**
9. Spalte `last_restore_test_at` in der Backups-Ansicht.
10. `OPERATIONS.md` §Backups auf den dann tatsächlichen Stand ziehen. **(B-8)**

**Abnahme:** eine Woche laufen lassen, grüner Eintrag ohne manuelles Zutun.

### Phase 4 — Generationen (ca. ½ Tag)

11. `backup-script.sh`: Zielpräfix aus dem Datum ableiten
    (`monthly/` am 1., `weekly/` sonntags, sonst `daily/`).
12. Retention je Präfix über `rclone delete --min-age`.
13. Neue Variablen nach `.env.example` und `SETUP.md`. **(B-7)**

**Abnahme:** `restore-script.sh list` zeigt drei Präfixe; ein 40 Tage altes
Monatsbackup ist noch da, ein 10 Tage altes Tagesbackup nicht mehr.

---

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

## 7. Bewusst nicht im Plan

- **WAL-Archivierung / Point-in-Time-Recovery.** Würde das RPO von 24 h auf
  Minuten drücken, kostet aber eine dauerhafte Archivstrecke und laufenden
  Speicher auf einem 8-GB-VPS. Vorschlag: erst dann, wenn ein Tenant das
  fachlich braucht — als eigener Plan, nicht nebenbei.
- **Restore per Knopfdruck im Dashboard.** Ein Web-Login, das die
  Produktivdatenbank überschreiben kann, vergrößert die Angriffsfläche mehr,
  als es im Ernstfall Zeit spart.
- **Zweiter Backup-Anbieter.** Sinnvoll, aber erst nachdem B-1 gelöst ist —
  zwei Kopien nützen nichts, wenn der Schlüssel für beide fehlt.
