-- P0-1: Legt die admin_dashboard-Datenbank an.
--
-- Ohne diese Datei bricht der Postgres-Init auf einem frischen Server ab:
-- 02_admin_schema.sql beginnt mit "ALTER TABLE kunden", die Tabelle existierte
-- aber nie, und der Entrypoint faehrt alle .sql-Dateien mit ON_ERROR_STOP=1.
--
-- Laeuft gegen die Default-DB (POSTGRES_DB ist im Compose nicht gesetzt = "postgres").
-- Alle nachfolgenden Skripte wechseln per \connect in admin_dashboard.
SELECT 'CREATE DATABASE admin_dashboard'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'admin_dashboard')\gexec
