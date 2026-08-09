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

DELETE FROM projects WHERE tenant_slug IS NULL;
