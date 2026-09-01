/**
 * TC-DOM-03 (P1) — Hostname-Zerlegung ueber die Public-Suffix-Liste.
 * Am letzten Punkt zu trennen liefert bei "kunde.co.uk" ein falsches Apex und
 * damit eine DNS-Anweisung, die der Kunde nicht eintragen kann.
 */
process.env.VPS_PUBLIC_IP = '192.0.2.10';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { splitHostname, buildInstructions } = require('../dist/lib/dns');

test('[P1] TC-DOM-03 mehrteilige Public Suffixe werden korrekt getrennt', () => {
  assert.deepEqual(splitHostname('kunde-domain.co.uk'), { base: 'kunde-domain.co.uk', sub: null });
  assert.deepEqual(splitHostname('www.kunde-domain.co.uk'), { base: 'kunde-domain.co.uk', sub: 'www' });
  assert.deepEqual(splitHostname('kunde.de'), { base: 'kunde.de', sub: null });
  assert.deepEqual(splitHostname('shop.kunde.de'), { base: 'kunde.de', sub: 'shop' });
});

test('[P1] TC-DOM-03 unbrauchbare Eingaben liefern null statt einer Fantasie-Domain', () => {
  for (const bad of ['', 'localhost', 'de', '...']) {
    assert.equal(splitHostname(bad), null, `${bad} darf nicht als Domain durchgehen`);
  }
});

test('[P1] TC-DOM-03 Apex bekommt A-Record, Subdomain CNAME', () => {
  // Apex-Domains koennen laut DNS-Standard keinen CNAME haben.
  const apex = buildInstructions('kunde.de', 'projekt.plattform.de');
  assert.deepEqual(apex.map((r) => r.type), ['A']);
  assert.equal(apex[0].value, '192.0.2.10');

  const sub = buildInstructions('www.kunde.de', 'projekt.plattform.de');
  assert.equal(sub[0].type, 'CNAME');
  assert.equal(sub[0].value, 'projekt.plattform.de');
  assert.ok(sub.some((r) => r.type === 'A'), 'A-Record als Alternative muss dabei sein');
});
