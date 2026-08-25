# Tenant-Migration: up2-site

Einmalige Portierung des alten Supabase-Schemas in die Tenant-Datenbank
`kunde_up2-site`. Kein Bestandteil des Plattform-Setups — nach erfolgreichem
Import kann dieser Ordner weg.

## Einspielen

```bash
cd /opt/multitenant-platform
docker exec -i core-postgres psql -U postgres -d "kunde_up2-site" \
  -v ON_ERROR_STOP=1 < tenant-migrations/up2-site/01_schema.sql
```

`01_schema.sql` ist idempotent, mehrfaches Ausfuehren ist gefahrlos.
Getestet gegen Postgres 16 mit nachgebauten Tenant-Rollen.

## Daten

Die COPY-Bloecke des Original-Dumps sind bewusst nicht enthalten:
`COPY ... FROM stdin` gehoert zum psql-Client-Protokoll und laeuft in keinem
Web-SQL-Editor. Datenexport aus der alten Quelle stattdessen mit
`pg_dump --data-only --column-inserts`, danach einspielen — erst Schema,
dann Daten (Fremdschluessel submissions -> client_public).

## Bewusst nicht uebernommen

- `CREATE SCHEMA public` — existiert bereits
- Trigger `newsletter_on_publish` — ruft `supabase_functions.http_request()`,
  ein Schema das es nur bei gehostetem Supabase gibt. Der Bearer-Token aus
  dem alten Trigger gehoert rotiert.
- `is_admin()` — braucht `auth.uid()` und eine `profiles`-Tabelle, beides hier
  nicht vorhanden. Wortlaut steht als Kommentar in 01_schema.sql.
