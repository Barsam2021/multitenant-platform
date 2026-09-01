/**
 * Zusammenspiel PostgREST + GoTrue + PgBouncer + Postgres fuer einen echten,
 * frisch provisionierten Mandanten. Alles im CI-Stack, nichts an der VPS.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { signTenantJwt } = require('/opt/multitenant-platform/provisioning-agent/dist/lib/jwt');

const A = process.env.CI_TENANT_A;
const B = process.env.CI_TENANT_B;
const SECRET_A = process.env.CI_TENANT_A_JWT_SECRET;
const API = `http://api-${A}:3000`;
const AUTH = `http://auth-${A}:9999`;

const anonKey = () => signTenantJwt(SECRET_A, 'anon', A);
const serviceKey = () => signTenantJwt(SECRET_A, 'service_role', A);

async function rest(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}`, apikey: token } : {}),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

test('[P0] TC-REST-01 Tabelle ohne RLS ist mit dem Anon-Key vollstaendig lesbar', async () => {
  // Haelt den in ANALYSE_1.md §2 beschriebenen Ist-Zustand fest: die Plattform
  // erzwingt KEIN RLS. Wird das geaendert (OQ-13), muss dieser Test brechen —
  // und zwar sichtbar, nicht als stille Verhaltensaenderung.
  const res = await rest('/offen?select=*', { token: anonKey() });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json[0].wert, 'oeffentlich');
});

test('[P0] TC-REST-02 RLS begrenzt anon, authenticated sieht die Zeile', async () => {
  const asAnon = await rest('/geschuetzt?select=*', { token: anonKey() });
  assert.equal(asAnon.status, 200, asAnon.text);
  assert.deepEqual(asAnon.json, [], 'anon darf keine Zeile der RLS-Tabelle sehen');

  // service_role_<slug> traegt BYPASSRLS aus dem Rollen-Template.
  const asService = await rest('/geschuetzt?select=*', { token: serviceKey() });
  assert.equal(asService.status, 200, asService.text);
  assert.equal(asService.json.length, 1, 'service_role muss die Zeile sehen');
});

test('[P0] TC-AUTH-03 Token mit fremdem role-Claim wird abgewiesen', async () => {
  // PostgREST macht mit dem role-Claim `SET ROLE`. Ein Claim auf die Rolle
  // eines anderen Mandanten darf nicht durchgehen — auch nicht, wenn er mit
  // dem EIGENEN Secret korrekt signiert ist.
  const fremd = signTenantJwt(SECRET_A, 'service_role', B);
  const res = await rest('/offen?select=*', { token: fremd });
  assert.notEqual(res.status, 200, `fremder role-Claim service_role_${B} wurde akzeptiert: ${res.text}`);
});

test('[P0] TC-AUTH-03 Token mit falschem Secret wird abgewiesen', async () => {
  const gefaelscht = signTenantJwt('f'.repeat(64), 'service_role', A);
  const res = await rest('/offen?select=*', { token: gefaelscht });
  assert.equal(res.status, 401, `falsch signiertes Token wurde akzeptiert: ${res.text}`);
});

test('[P1] TC-REST-04 PostgREST bedient ausschliesslich das Schema public', async () => {
  const res = await rest('/pg_stat_activity?select=*', { token: serviceKey() });
  assert.notEqual(res.status, 200, 'Objekte ausserhalb von public duerfen nicht sichtbar sein');
});

test('[P1] TC-AUTH-02 GoTrue antwortet und hat Self-Signup abgeschaltet', async () => {
  const health = await fetch(`${AUTH}/health`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(health.ok, true, 'GoTrue /health antwortet nicht');

  const res = await fetch(`${AUTH}/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ci-test@ci.invalid', password: 'ein-langes-testpasswort-123' }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.notEqual(res.status, 200, 'Self-Signup ist offen — GOTRUE_DISABLE_SIGNUP greift nicht');
  assert.ok([400, 401, 403, 404, 422].includes(res.status), `unerwarteter Status ${res.status}`);
});
