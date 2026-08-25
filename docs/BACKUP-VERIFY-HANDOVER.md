# Backup-Verifikation — Arbeitsstand

Aufgenommen am 2026-08-25 aus einer Analyse von `main` (`6834981`).
Zweck: eine Claude-Code-Session **auf der VPS** soll hier weitermachen können,
ohne die Recherche zu wiederholen.

## Ausgangsfrage

1. Werden Backups nur lokal gespeichert oder auch off-site?
2. Wie lässt sich beweisen, dass ein Restore tatsächlich funktioniert?

## Antwort auf (1): beides, mit einem Vorbehalt

`backups/backup-script.sh`, Funktion `encrypt_and_upload`: jede Datei wird mit
`age` verschlüsselt, das Klartext-Original sofort gelöscht, **erst** per rclone
nach `$RCLONE_REMOTE_PATH` hochgeladen, **dann** die verschlüsselte Kopie nach
`backups/files/` verschoben. Jedes Backup liegt also an zwei Orten.

- Die lokale Kopie ist nur Bequemlichkeit — sie liegt auf genau der Maschine,
  gegen deren Verlust gesichert wird, und verfällt nach
  `BACKUP_RETENTION_DAYS` (Default 3).
- Scheitert der Upload, bleibt die Datei trotzdem lokal, Status `upload_failed`,
  Alarm-Mail. Danach existiert das Backup **nur** noch lokal.
- Ob das Remote wirklich off-site liegt, entscheidet allein
  `RCLONE_REMOTE_PATH`. Der Code prüft das nicht.
- Im Remote liegen age-verschlüsselte Bytes. Privater Key
  (`backups/age-identity.txt`) und `.env` liegen sonst nur auf dem Server —
  ohne Off-Site-DR-Bundle ist das Remote im Ernstfall wertlos.

## Antwort auf (2): `backups/verify-backups.sh`

Neu in diesem Branch. Per Default rein lesend, ändert nichts.

```bash
cd /opt/multitenant-platform
./backups/verify-backups.sh                     # Stufe 0-3
./backups/verify-backups.sh --with-restore-test # zusätzlich Stufe 2
```

Ampel am Ende, Exit 0 = grün, 1 = Warnungen, 2 = kritisch.

| Stufe | Prüft | Status |
|---|---|---|
| 0 | Werkzeuge, age-Keypair, Cron, Logalter, `backups`-Tabelle | im Skript |
| 1 | Remote-Inventar: pro Kategorie eine aktuelle Datei? | im Skript |
| 2 | DB-Restore in Wegwerf-DB, Tabellen **und** Zeilen | im Skript (Flag) |
| 3 | MinIO- und Config-Archiv entschlüsseln, Inhalt prüfen | im Skript |
| 4 | Restore auf fremder Maschine aus Remote + DR-Bundle | **Handarbeit** |

Der wichtigste Einzelcheck steht in Stufe 0: `age-keygen -y` auf das
Identity-File und Vergleich mit `BACKUP_AGE_PUBLIC_KEY`. Passen die nicht
zusammen, verschlüsselt jedes Backup fehlerfrei gegen einen Schlüssel, den
niemand besitzt — und nichts in der bestehenden Pipeline merkt das.

Stufe 3 deckt ab, was sonst **kein** Skript je anfasst: `restore-test-script.sh`
akzeptiert nur `*.dump.age` und `*.sql.gz.age`, also niemals die MinIO- und
Config-Archive.

### Stufe 4 — noch offen

Der einzige echte Beweis. Wegwerf-VM, darauf **nur** rclone-Credentials plus
`age-identity.txt` und `.env` aus dem Off-Site-Bundle (nicht vom Produktivserver
kopieren, sonst testet man das Bundle nicht). Dann `bootstrap.sh` und die
Reihenfolge aus dem Header von `restore-script.sh`:
globals → config → `admin_dashboard` → jede `kunde_*` → minio → `docker compose up`.

Erfolgskriterium: im Dashboard sind die Env-Vars eines Kunden lesbar. Das
beweist, dass der `ENCRYPTION_MASTER_KEY` durchgekommen ist — der Punkt, an dem
ein Restore am ehesten still scheitert.

## Drei offene Bugs (bewusst noch nicht gefixt)

1. **Restore-Test-Button im Dashboard ist für jede Datenbank tot.**
   `provisioning-agent/src/routes/backups.ts:76` validiert
   `/^[a-zA-Z0-9_.-]+\.sql\.gz\.age$/`, seit der Umstellung auf `pg_dump -Fc`
   heißen DB-Backups aber `*.dump.age` → `400 invalid filename`. Nur
   `globals_*` kommt durch. Das Shell-Skript kann beide Formate.
2. **`encrypt_failed` kann nie in der Tabelle landen.** `backup-script.sh:86`
   schreibt diesen Status, der CHECK-Constraint in
   `core-postgres/init-scripts/05_backups.sql` erlaubt nur
   `('ok','dump_failed','upload_failed')`. Das INSERT scheitert und wird als
   Log-Warnung geschluckt. Auch das TS-Interface in
   `dashboard/src/app/dashboard/backups/page.tsx:15` kennt den Status nicht.
3. **`BACKUP_REMOTE_RETENTION_DAYS` ist nirgends dokumentiert** — weder in
   `.env.example` noch in SETUP.md. Ohne die Variable wächst das Remote
   unbegrenzt.

## Nächste Schritte auf der VPS

1. `./backups/verify-backups.sh` laufen lassen, Ampel auswerten.
2. Bei Grün/Gelb: `--with-restore-test` für alle Tenants.
3. Danach die drei Bugs oben fixen.
4. Stufe 4 als eigenen Termin planen.
