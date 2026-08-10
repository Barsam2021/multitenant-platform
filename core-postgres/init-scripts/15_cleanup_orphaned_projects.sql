-- P2-6 (Audit 0430f9c): Diese Migration hat bei JEDEM Lauf von migrate.sh
-- `DELETE FROM projects WHERE tenant_slug IS NULL` ausgefuehrt. projects.
-- tenant_slug hat ON DELETE SET NULL — jedes Projekt, dessen Tenant gerade
-- geloescht wurde, verschwand beim naechsten Migrationslauf klanglos.
-- Eine Migration ist ein einmaliger Vorgang; ein wiederkehrender Aufraeumjob
-- gehoert in lib/cleanup.ts, nicht hierher.
--
-- Der urspruengliche DELETE ist unten auskommentiert und durch eine reine
-- Meldung ersetzt. Zum echten Aufraeumen: das SELECT ausfuehren und gezielt
-- loeschen.

-- P2-7: projects.tenant_slug hat ON DELETE SET NULL (03_fix_projects_schema.sql).
-- Vor diesem Fix loeschte DELETE /tenants/:slug die kunden-Zeile, ohne die
-- zugehoerigen projects-Zeilen mitzuloeschen - sie blieben mit tenant_slug=NULL
-- zurueck, fallen aus dem JOIN kunden in GET /projects raus und sind seitdem in
-- keiner UI mehr sichtbar, existieren aber weiter in der DB (Container/Router
-- dafuer sind ohnehin schon durch cleanupTenantResources() entfernt worden -
-- das hier ist reines Wegraeumen der verwaisten Zeile selbst).
--
-- index.ts cleanupTenantResources() loescht ab jetzt projects mit, dieser Teil
-- ist nur fuer den Bestand.
--
-- Idempotent (kein Effekt mehr nach dem ersten Lauf).
\connect admin_dashboard

-- P2-6 deaktiviert: DELETE FROM projects WHERE tenant_slug IS NULL;

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM projects WHERE tenant_slug IS NULL;
  IF n > 0 THEN
    RAISE NOTICE 'Hinweis: % verwaiste Projekte (tenant_slug IS NULL). Nicht automatisch geloescht (P2-6). Pruefen mit: SELECT id, slug FROM projects WHERE tenant_slug IS NULL;', n;
  END IF;
END
$$;
