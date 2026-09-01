/**
 * TC-REST-05 (P1) — Claims der Tenant-JWTs.
 *
 * Der `role`-Claim ist das, worauf PostgREST `SET ROLE` macht. Stuende dort die
 * clusterweite `service_role` statt `service_role_<slug>`, landete jeder Tenant
 * in derselben BYPASSRLS-Rolle (P0-2b).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { signTenantJwt, tenantRoleName } = require('../dist/lib/jwt');

const SECRET = 'a'.repeat(64);

test('[P1] TC-REST-05 role-Claim ist tenant-spezifisch, nie clusterweit', () => {
  const anon = jwt.verify(signTenantJwt(SECRET, 'anon', 'up2-site'), SECRET);
  const svc = jwt.verify(signTenantJwt(SECRET, 'service_role', 'up2-site'), SECRET);
  assert.equal(anon.role, 'anon_up2-site');
  assert.equal(svc.role, 'service_role_up2-site');
  assert.notEqual(anon.role, 'anon');
  assert.notEqual(svc.role, 'service_role');
});

test('[P1] TC-REST-05 iss ist gesetzt, exp und aud bewusst nicht', () => {
  // Langlebige API-Keys nach Supabase-Konvention. Widerruf laeuft ausschliesslich
  // ueber Rotation des Tenant-Secrets. Aendert sich das, muss dieser Test brechen.
  const decoded = jwt.decode(signTenantJwt(SECRET, 'anon', 'x'), { complete: true });
  assert.equal(decoded.header.alg, 'HS256');
  assert.equal(decoded.payload.iss, 'multitenant-platform');
  assert.equal(decoded.payload.exp, undefined);
  assert.equal(decoded.payload.aud, undefined);
});

test('[P1] TC-REST-05 Token eines Tenants ist unter fremdem Secret ungueltig', () => {
  const token = signTenantJwt(SECRET, 'anon', 'tenant-a');
  assert.throws(() => jwt.verify(token, 'b'.repeat(64)), /invalid signature/);
});

test('[P1] TC-REST-05 tenantRoleName folgt der Namenskonvention', () => {
  assert.equal(tenantRoleName('anon', 'foo'), 'anon_foo');
  assert.equal(tenantRoleName('authenticated', 'foo'), 'authenticated_foo');
  assert.equal(tenantRoleName('service_role', 'foo'), 'service_role_foo');
});
