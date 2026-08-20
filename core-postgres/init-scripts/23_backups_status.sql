\connect admin_dashboard

-- Backup-Status: erlaubte Werte an das anpassen, was tatsaechlich geschrieben wird.
--
-- 05_backups.sql erlaubte nur ('ok','dump_failed','upload_failed'). backup-script.sh
-- schreibt aber seit jeher auch 'encrypt_failed' (encrypt_and_upload(), Zweig
-- "Verschluesselung fehlgeschlagen"). Dieser INSERT verletzte den CHECK-Constraint,
-- scheiterte still — record_backup() protokolliert nur eine Warnung — und der
-- Fehlerfall hinterliess damit ausgerechnet in der Tabelle keine Spur, die ihn
-- sichtbar machen soll.
--
-- Neu dazu kommen die Ergebnisse des automatischen Restore-Tests
-- (lib/backupHealth.ts). Sie stehen bewusst als eigene Zeilen in derselben
-- Tabelle statt in einer neuen: die Backups-Ansicht ist chronologisch, und ein
-- fehlgeschlagener Restore-Test gehoert genau dorthin, wo auch das Backup steht,
-- auf das er sich bezieht.
ALTER TABLE backups DROP CONSTRAINT IF EXISTS backups_status_check;
ALTER TABLE backups ADD CONSTRAINT backups_status_check CHECK (
    status IN (
        'ok',
        'dump_failed',
        'upload_failed',
        'encrypt_failed',
        'restore_test_ok',
        'restore_test_failed'
    )
);

-- Der Totmannschalter (checkBackupFreshness) fragt bei jedem Lauf nach dem
-- juengsten erfolgreichen Backup, der Restore-Test-Planer nach der am laengsten
-- ungetesteten Datenbank. Beides sind (status, created_at)-Zugriffe; der
-- vorhandene Index liegt nur auf created_at.
CREATE INDEX IF NOT EXISTS idx_backups_status_created_at
    ON backups (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_backups_db_name_created_at
    ON backups (db_name, created_at DESC);
