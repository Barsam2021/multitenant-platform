-- Datenbank ist ab hier OPTIONAL pro Tenant.
--
-- Bisher bekam jeder Tenant zwangsweise eine eigene Postgres-DB plus zwei
-- dauerhaft laufende Container (PostgREST + GoTrue). Fuer eine reine
-- Visitenkarten-/Landingpage ist das reine Verschwendung: ~200 MB RAM und zwei
-- PgBouncer-Pools pro Kunde, der nie eine Zeile speichert. Auf 8 GB VPS ist das
-- der Unterschied zwischen 10 und 25 Kunden.
--
-- Zwei getrennte Flags, weil "Container laufen" und "Datenbank existiert"
-- unterschiedliche Dinge sind:
--
--   db_provisioned = true  -> CREATE DATABASE + Rollen + docker-compose.yml
--                             existieren. Wird NIE wieder false, ausser der
--                             Tenant wird komplett geloescht. Die Daten des
--                             Kunden haengen daran.
--   db_enabled     = true  -> api-<slug>/auth-<slug> sollen laufen.
--                             Abschalten heisst `docker compose down`:
--                             Container weg, RAM frei, DATENBANK BLEIBT.
--                             Wieder einschalten ist ein `up -d`, kein
--                             Neu-Provisioning.
--
-- Bestandskunden haben beides auf true — sie haben heute eine DB und laufende
-- Container, daran aendert diese Migration nichts.
--
-- Idempotent.
\connect admin_dashboard

ALTER TABLE kunden ADD COLUMN IF NOT EXISTS db_enabled BOOLEAN;
ALTER TABLE kunden ADD COLUMN IF NOT EXISTS db_provisioned BOOLEAN;

UPDATE kunden SET db_enabled = true WHERE db_enabled IS NULL;
UPDATE kunden SET db_provisioned = true WHERE db_provisioned IS NULL;

-- Beide Defaults bewusst true, obwohl neue Tenants ohne DB false brauchen: der
-- Agent setzt die Werte beim INSERT immer explizit (routes/tenants.ts). Waehrend
-- des Rollout-Fensters — Migration ist durch, neues Agent-Image noch nicht —
-- legt der ALTE Agent Tenants weiterhin MIT Datenbank an; ein Default false
-- wuerde die als "keine DB vorhanden" markieren und ein spaeteres Einschalten
-- wuerde CREATE DATABASE auf eine existierende DB werfen.
ALTER TABLE kunden ALTER COLUMN db_enabled SET DEFAULT true;
ALTER TABLE kunden ALTER COLUMN db_provisioned SET DEFAULT true;
ALTER TABLE kunden ALTER COLUMN db_enabled SET NOT NULL;
ALTER TABLE kunden ALTER COLUMN db_provisioned SET NOT NULL;
