/**
 * Drift-Waechter auf die gerenderte Tenant-Konfiguration.
 *
 * Die Datei wurde von der ECHTEN writeTenantCompose() aus dem echten Template
 * erzeugt (scripts/ci/provision-test-tenants.js). Geprueft werden genau die
 * Einstellungen, deren stille Aenderung die Mandantentrennung oeffnen oder die
 * Plattform sporadisch kaputtmachen wuerde.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const A = process.env.CI_TENANT_A;
const compose = fs.readFileSync(`/opt/multitenant-platform/kunden-instances/${A}/docker-compose.yml`, 'utf8');

test('[P0] TC-TAR-04 die Anon-Rolle von PostgREST ist tenant-eigen', () => {
  // P0-2b: stuende hier die clusterweite `anon`, landeten alle Mandanten in
  // derselben Rolle.
  assert.match(compose, new RegExp(`PGRST_DB_ANON_ROLE:\\s*"anon_${A}"`));
  assert.match(compose, new RegExp(`GOTRUE_JWT_DEFAULT_GROUP_NAME:\\s*"authenticated_${A}"`));
  assert.match(compose, new RegExp(`GOTRUE_JWT_ADMIN_ROLES:\\s*"service_role_${A}"`));
});

test('[P0] TC-TAR-04 die DB-Verbindung laeuft als authenticator des Mandanten ueber PgBouncer', () => {
  assert.match(compose, new RegExp(`postgres://authenticator_${A}:[^@]+@pgbouncer:5432/kunde_${A}`));
  assert.ok(!compose.includes('postgres://postgres:'), 'Tenant-Dienste duerfen nie als Superuser verbinden');
});

test('[P1] TC-AUTH-02 Self-Signup ist im Template abgeschaltet', () => {
  assert.match(compose, /GOTRUE_DISABLE_SIGNUP:\s*"true"/);
  assert.match(compose, /GOTRUE_MAILER_AUTOCONFIRM:\s*"false"/);
});

test('[P1] TC-POOL-02 Prepared Statements sind aus (PgBouncer laeuft im Transaction-Mode)', () => {
  // P1-10: sonst sporadische 500er mit "prepared statement does not exist".
  assert.match(compose, /PGRST_DB_PREPARED_STATEMENTS:\s*"false"/);
});

test('[P1] TC-TAR-04 keine unersetzte Template-Variable ist uebrig geblieben', () => {
  const rest = compose.match(/\$\{[A-Z_]+\}/g);
  assert.equal(rest, null, `unersetzte Platzhalter: ${rest}`);
});
