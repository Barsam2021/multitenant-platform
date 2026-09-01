/**
 * TC-MON-03 (P1) — Versionsinventar (docs/CVE-PLAN.md).
 * Eine falsche Zerlegung der Image-Referenz macht den CVE-Abgleich still wertlos.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { splitImageRef, classifyContainer, hasDrift } = require('../dist/lib/inventory');

test('[P1] TC-MON-03 Image-Referenzen werden korrekt zerlegt', () => {
  assert.deepEqual(splitImageRef('traefik:v3.7'), { name: 'traefik', version: 'v3.7' });
  assert.deepEqual(splitImageRef('postgres:16.14-bookworm'), { name: 'postgres', version: '16.14-bookworm' });
  assert.deepEqual(splitImageRef('minio/minio:RELEASE.2025-09-07T16-13-09Z-cpuv1'), {
    name: 'minio/minio', version: 'RELEASE.2025-09-07T16-13-09Z-cpuv1',
  });
  // Registry-Port darf nicht als Tag gelesen werden
  assert.deepEqual(splitImageRef('registry:5000/foo'), { name: 'registry:5000/foo', version: 'latest' });
  // Digest-Referenz: der Doppelpunkt im Digest ist kein Tag-Trenner
  assert.deepEqual(splitImageRef('foo@sha256:abc123'), { name: 'foo', version: 'sha256:abc123' });
});

test('[P1] TC-MON-03 fehlender Tag wird als "latest" gemeldet, nicht als sicher', () => {
  assert.equal(splitImageRef('nginx').version, 'latest');
});

test('[P1] TC-MON-03 Container werden dem richtigen Bereich zugeordnet', () => {
  assert.deepEqual(classifyContainer('api-up2-site', 'postgrest/postgrest:v14.15'), { scope: 'tenant', slug: 'up2-site' });
  assert.deepEqual(classifyContainer('auth-sofre', 'supabase/gotrue:v2.193.1'), { scope: 'tenant', slug: 'sofre' });
  assert.deepEqual(classifyContainer('global-traefik', 'traefik:v3.7'), { scope: 'platform', slug: null });
  assert.deepEqual(classifyContainer('app-meinprojekt', 'app-meinprojekt:abc'), { scope: 'project', slug: 'meinprojekt' });
});

test('[P1] TC-MON-03 Slug mit Bindestrich-Suffix wird nicht faelschlich gekuerzt', () => {
  const known = new Set(['up2-site']);
  assert.equal(classifyContainer('app-up2-site', 'x', known).slug, 'up2-site');
  // Ohne bekannten Slug wird ein angehaengter 8-Hex-Block als Deploy-Suffix gelesen
  assert.equal(classifyContainer('app-projekt-a1b2c3d4', 'x').slug, 'projekt');
});

test('[P1] TC-MON-03 Drift nur bei abweichender Pin-Version', () => {
  assert.equal(hasDrift({ pinnedVersion: 'v3.7', version: 'v3.6' }), true);
  assert.equal(hasDrift({ pinnedVersion: 'v3.7', version: 'v3.7' }), false);
  assert.equal(hasDrift({ pinnedVersion: null, version: 'v3.7' }), false);
});
