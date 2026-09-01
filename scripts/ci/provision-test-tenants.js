/**
 * Legt die beiden Testmandanten des CI-Laufs an.
 *
 * WICHTIG: Dieses Skript bildet das Provisioning NICHT nach, sondern ruft die
 * echten Funktionen des Agents auf (`provisionTenantDatabaseSchema`,
 * `writeTenantCompose`). Eine Nachbildung wuerde die Tests wertlos machen — sie
 * pruefte dann das Testskript statt die Plattform.
 *
 * Zwei Mandanten, weil sich Mandantentrennung nur mit einem zweiten pruefen
 * laesst: A ist im Vollausbau (DB + Rollen + GoTrue + PostgREST), B hat nur
 * Datenbank und Rollen und dient als Nachbar, dessen Daten unerreichbar bleiben
 * muessen.
 */
const path = require('node:path');
const agent = path.join('/opt/multitenant-platform', 'provisioning-agent', 'dist', 'lib', 'tenantDatabase.js');
const { provisionTenantDatabaseSchema, writeTenantCompose } = require(agent);

const A = process.env.CI_TENANT_A;
const B = process.env.CI_TENANT_B;

async function main() {
  for (const [slug, pw] of [[A, process.env.CI_TENANT_A_PW], [B, process.env.CI_TENANT_B_PW]]) {
    if (!slug || !pw) throw new Error('CI_TENANT_* nicht gesetzt — scripts/ci/env.sh nicht gesourct?');
    process.stdout.write(`provisioniere kunde_${slug} ... `);
    await provisionTenantDatabaseSchema({ slug, authenticatorPassword: pw });
    console.log('ok');
  }

  // Nur Tenant A bekommt laufende Dienste. Die Datei entsteht aus dem echten
  // Template (provisioning-agent/templates/tenant-compose.yml) — damit testet
  // die Pipeline die tatsaechlich ausgelieferte Konfiguration, nicht eine
  // CI-Kopie, die davon abdriften kann.
  const dir = await writeTenantCompose(A, 'starter', process.env.CI_TENANT_A_JWT_SECRET, process.env.CI_TENANT_A_PW);
  console.log(`tenant-compose geschrieben: ${dir}/docker-compose.yml`);
}

main().catch((err) => {
  console.error('Provisioning fehlgeschlagen:', err.message);
  process.exit(1);
});
