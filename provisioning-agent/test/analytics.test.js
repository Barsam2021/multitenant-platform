/**
 * TC-ANA-01 / TC-ANA-02 (P0) — die Datenschutzzusage aus 20_analytics.sql.
 *
 * Dort steht: "es wird KEINE IP und KEIN User-Agent gespeichert. Ein Besucher
 * ist ein salted Hash [...], wobei das Salt TAEGLICH rotiert." Diese Tests
 * halten genau das nachpruefbar — ohne sie ist die Zusage eine Absicht.
 */
process.env.ANALYTICS_SALT = 'testsalt-fuer-ci-nur-hier';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  visitorHash,
  normalizeHost,
  normalizePath,
  normalizeReferrer,
} = require('../dist/lib/analytics');

const IP = '203.0.113.7';
const UA = 'Mozilla/5.0 (Windows NT 10.0) Chrome/137';

test('[P0] TC-ANA-01 gleicher Besucher am selben Tag ergibt denselben Hash', () => {
  assert.equal(
    visitorHash('2026-08-26', IP, UA, 'kunde.de'),
    visitorHash('2026-08-26', IP, UA, 'kunde.de')
  );
});

test('[P0] TC-ANA-01 derselbe Besucher am Folgetag ist NICHT wiedererkennbar', () => {
  assert.notEqual(
    visitorHash('2026-08-26', IP, UA, 'kunde.de'),
    visitorHash('2026-08-27', IP, UA, 'kunde.de')
  );
});

test('[P0] TC-ANA-01 Hash trennt Besucher, Host und User-Agent', () => {
  const base = visitorHash('2026-08-26', IP, UA, 'kunde.de');
  assert.notEqual(base, visitorHash('2026-08-26', '198.51.100.1', UA, 'kunde.de'));
  assert.notEqual(base, visitorHash('2026-08-26', IP, 'curl/8.5', 'kunde.de'));
  assert.notEqual(base, visitorHash('2026-08-26', IP, UA, 'anderer-kunde.de'));
});

test('[P0] TC-ANA-01 Hash gibt die Eingabe nicht preis', () => {
  const h = visitorHash('2026-08-26', IP, UA, 'kunde.de');
  assert.match(h, /^[0-9a-f]{32}$/);
  assert.ok(!h.includes(IP));
  assert.ok(!h.toLowerCase().includes('mozilla'));
});

test('[P0] TC-ANA-02 Query-String wird verworfen', () => {
  // Sonst ist jeder UTM-Link ein eigener "Pfad" — und der Query-String kann
  // selbst personenbezogen sein (E-Mail in einem Bestaetigungslink).
  assert.equal(normalizePath('/preise?utm_source=news&email=a@b.de'), '/preise');
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath('ohne-slash'), '/ohne-slash');
  assert.equal(normalizePath(''), '/');
});

test('[P0] TC-ANA-02 Pfadlaenge ist gekappt', () => {
  assert.equal(normalizePath('/' + 'a'.repeat(500)).length, 200);
});

test('[P0] TC-ANA-02 Referrer wird auf die Herkunft reduziert', () => {
  // Der volle Referrer-Pfad kann Suchbegriffe oder interne URLs enthalten.
  assert.equal(
    normalizeReferrer('https://www.google.com/search?q=sehr+privater+begriff', 'kunde.de'),
    'https://www.google.com'
  );
  assert.equal(normalizeReferrer('https://kunde.de/impressum', 'kunde.de'), null, 'eigene Seite ist kein Referrer');
  assert.equal(normalizeReferrer('-', 'kunde.de'), null);
  assert.equal(normalizeReferrer(undefined, 'kunde.de'), null);
  assert.equal(normalizeReferrer('kein-gueltiger-url', 'kunde.de'), null);
});

test('[P1] TC-ANA-02 Host wird ohne Port und kleingeschrieben normalisiert', () => {
  assert.equal(normalizeHost('Kunde.DE:443'), 'kunde.de');
  assert.equal(normalizeHost('  kunde.de  '), 'kunde.de');
});
