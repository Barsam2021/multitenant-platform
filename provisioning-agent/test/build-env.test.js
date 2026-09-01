/**
 * TC-DEPL-01 (P0) — Build-Zeit-Env-Filter.
 *
 * Was hier durchrutscht, landet als ENV-Layer im fertigen Image und ist per
 * `docker history app-<slug>:<sha>` lesbar — also auch fuer jeden, der das
 * Image weitergereicht bekommt. Genau dieser Weg gab vor P0-4 den
 * GoTrue-JWT-Secret und den SERVICE_ROLE_KEY (BYPASSRLS) heraus.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isBuildTimeSafe } = require('../dist/lib/nixpacks');

test('[P0] TC-DEPL-01 Denylist-Variablen sind zur Build-Zeit nie sichtbar', () => {
  for (const key of [
    'JWT_SECRET',
    'SUPABASE_SERVICE_ROLE_KEY',
    'MINIO_SECRET_KEY',
    'DATABASE_URL',
    'POSTGRES_PASSWORD',
  ]) {
    assert.equal(isBuildTimeSafe(key), false, `${key} darf nicht in den Build`);
  }
});

test('[P0] TC-DEPL-01 secret-artige Namen bleiben draussen', () => {
  for (const key of [
    'MY_TOKEN',
    'STRIPE_KEY',
    'API_CREDENTIAL',
    'SOME_ACCESS_KEY',
    'APP_PASSWORD',
    'CLIENT_SECRET',
    'KEY',
    'SSH_PRIVATE_KEY',
  ]) {
    assert.equal(isBuildTimeSafe(key), false, `${key} sieht nach Secret aus`);
  }
});

test('[P0] TC-DEPL-01 oeffentliche Framework-Praefixe kommen durch', () => {
  for (const key of [
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_STRIPE_KEY', // Praefix schlaegt die Secret-Heuristik — beabsichtigt
    'VITE_API_URL',
    'PUBLIC_SITE_NAME',
    'REACT_APP_TITLE',
    'NUXT_PUBLIC_BASE',
    'GATSBY_ENV',
    'EXPO_PUBLIC_X',
  ]) {
    assert.equal(isBuildTimeSafe(key), true, `${key} ist per Konvention oeffentlich`);
  }
});

test('[P0] TC-DEPL-01 Praefix schlaegt Denylist NICHT', () => {
  // Die Denylist wird vor der Praefix-Regel geprueft. Waere es andersherum,
  // koennte ein Projekt mit NEXT_PUBLIC_-Praefix jedes Secret ins Image heben.
  assert.equal(isBuildTimeSafe('JWT_SECRET'), false);
  assert.equal(isBuildTimeSafe('NEXT_PUBLIC_JWT_SECRET'), true); // dokumentierter Ist-Zustand, siehe CI-SETUP.md
});

test('[P0] TC-DEPL-01 harmlose Variablen kommen durch', () => {
  for (const key of ['NODE_ENV', 'PORT', 'S3_BUCKET_NAME', 'MINIO_ENDPOINT', 'LOG_LEVEL']) {
    assert.equal(isBuildTimeSafe(key), true, `${key} ist unkritisch`);
  }
});
