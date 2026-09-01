/**
 * TC-TAR-01 (P1) — Tarif steuert ausschliesslich RAM/CPU (es gibt keine
 * Billing-Logik, siehe TESTPLAN.md §0.1). Ein unbekannter Wert muss auf
 * `starter` fallen statt `undefined` an `docker run --memory` zu reichen.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TARIFF_LIMITS } = require('../dist/lib/deploy');

test('[P1] TC-TAR-01 die drei Tarife haben die dokumentierten Limits', () => {
  assert.deepEqual(TARIFF_LIMITS.starter, { mem: '512m', cpus: '0.5' });
  assert.deepEqual(TARIFF_LIMITS.business, { mem: '512m', cpus: '1' });
  assert.deepEqual(TARIFF_LIMITS.premium, { mem: '1g', cpus: '2' });
});

test('[P1] TC-TAR-01 kein Tarif liegt unter 512m', () => {
  // 256m war zu knapp fuer einen Next.js-Standalone-Server und fuehrte zu
  // OOM-Kills, die im Deploy-Log nur als "Healthcheck FAILED" ankamen.
  for (const [name, limit] of Object.entries(TARIFF_LIMITS)) {
    const mb = limit.mem.endsWith('g') ? parseFloat(limit.mem) * 1024 : parseFloat(limit.mem);
    assert.ok(mb >= 512, `${name} hat nur ${limit.mem}`);
  }
});

test('[P1] TC-TAR-01 unbekannte Tarife fallen auf starter', () => {
  const pick = (t) => TARIFF_LIMITS[t] || TARIFF_LIMITS.starter;
  for (const t of ['enterprise', '', undefined, null, 'STARTER']) {
    assert.deepEqual(pick(t), TARIFF_LIMITS.starter, `Tarif ${t} muss auf starter fallen`);
  }
});
