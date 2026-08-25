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

## Stand nach der VPS-Session vom 2026-08-25: alle vier Punkte erledigt

### Die eigentliche Diskrepanz (Stufe 0b KRIT vs. Stufe 1 OK)

Beim ersten Lauf von `verify-backups.sh` zeigte Stufe 0b "jüngstes Backup
371h alt, RPO verletzt" für alle drei Tenants, obwohl Stufe 1 taggenau frische
Dateien im Remote fand. Ursache: `record_backup()` in `backup-script.sh` schrieb
die INSERTs über `psql -c "... :'var' ..."` — psql interpoliert `:'var'`
**nicht** im `-c`-Modus, nur wenn das SQL über stdin gelesen wird. Jedes INSERT
scheiterte seit der Umstellung auf `pg_dump -Fc` (~10.08.) mit
`syntax error at or near ":"`, nur als Log-Zeile geschluckt. Die Backups selbst
liefen die ganze Zeit fehlerfrei — nur die Tabelle war blind.

**Fix:** `record_backup()` schickt das SQL jetzt per Heredoc über stdin statt
per `-c`, und ein gescheitertes INSERT löst jetzt `fail()` statt nur `log()`
aus — ein künftiges Logging-Problem alarmiert damit tatsächlich. Verifiziert:
echter `backup-script.sh`-Lauf → Tabelle korrekt befüllt →
`verify-backups.sh --with-restore-test` → **GELB**, alle drei DBs erfolgreich
in Wegwerf-DBs restored (Tabellen **und** Zeilen geprüft).

### Die drei ursprünglich dokumentierten Bugs — gefixt

1. **Restore-Test-Regex** in `provisioning-agent/src/routes/backups.ts`
   akzeptiert jetzt `.dump.age` **und** `.sql.gz.age`.
2. **`encrypt_failed`** ist jetzt im CHECK-Constraint erlaubt (Migration
   `core-postgres/init-scripts/23_fix_backups_status.sql`, live angewendet)
   und im TS-Interface in `dashboard/src/app/dashboard/backups/page.tsx`
   nachgezogen.
3. **`BACKUP_REMOTE_RETENTION_DAYS=14`** ist gesetzt (`.env`,
   `.env.example`) und in SETUP.md dokumentiert.

### Neuer Befund beim Testen: Dashboard-Buttons sind komplett tot

Mit gefixter Regex schlug der Restore-Test-Endpoint (direkt über die
Agent-API mit `x-agent-secret` getestet) immer noch fehl:
`unable to upgrade to tcp, received 403`. Ursache: `docker-socket-proxy` hat
`EXEC: 0` (bewusste Härtung, Kommentar in
`provisioning-agent/docker-compose.yml` referenziert einen Sicherheits-Audit —
`docker exec` über den Proxy wäre sonst praktisch root-äquivalent).
`backup-script.sh` **und** `restore-test-script.sh` basieren aber komplett auf
`docker exec`.

Test bestätigt: **beide** Dashboard-Buttons ("Backup jetzt starten" und
"Restore-Test") sind seit dieser Härtung tot, nicht nur wegen der Regex. Der
nächtliche Cron-Job läuft unabhängig davon mit vollem Docker-Zugriff auf dem
Host und ist davon nie betroffen gewesen — verifiziert, GELB.

Ein echter Architektur-Fix (z. B. ein eng beschränkter Ausführungspfad nur für
Backup-Kommandos) ist eine eigene Sicherheitsabwägung und wurde bewusst nicht
spontan umgesetzt. Stattdessen: beide Buttons in
`dashboard/src/app/dashboard/backups/page.tsx` sind jetzt klar als
`disabled` markiert mit Tooltip/Hinweistext ("nur über Cron verfügbar"),
damit niemand einen toten Klick für einen echten Fehlschlag hält.

## Nächste Schritte

1. ~~`./backups/verify-backups.sh` laufen lassen~~ — erledigt, GELB.
2. ~~`--with-restore-test` für alle Tenants~~ — erledigt, alle drei OK.
3. ~~Die drei Bugs oben fixen~~ — erledigt.
4. **Stufe 5 (neu, offen):** Dashboard-Buttons für Backup/Restore-Test
   funktionsfähig machen, ohne die EXEC=0-Härtung aufzuweichen. Eigener
   Termin, eigene Sicherheitsabwägung — nicht spontan ändern.
5. Stufe 4 (Restore auf fremder Maschine, nur aus Remote + Off-Site-Bundle)
   als eigenen Termin planen — weiterhin offen, siehe oben.
