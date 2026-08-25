-- backup-script.sh:encrypt_and_upload schreibt bei fehlgeschlagener age-
-- Verschluesselung den Status 'encrypt_failed'. Der urspruengliche Constraint
-- aus 05_backups.sql kannte ihn nicht -> das INSERT scheitert an der
-- Constraint-Verletzung und wird nur als Log-Warnung geschluckt, statt den
-- echten Fehler in der Tabelle sichtbar zu machen.
--
-- Idempotent, gefahrlos mehrfach ausfuehrbar.
\connect admin_dashboard

ALTER TABLE backups DROP CONSTRAINT IF EXISTS backups_status_check;

ALTER TABLE backups ADD CONSTRAINT backups_status_check
  CHECK (status IN ('ok','dump_failed','upload_failed','encrypt_failed'));
