/**
 * TC-DEPL-06 (P2) — Build-Fehlerhinweise, und die Laengenkappung des Logs (P3-6).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectBuildErrorHint } = require('../dist/lib/buildErrorHints');
const { truncateBuildLog } = require('../dist/lib/cleanup');

test('[P2] TC-DEPL-06 bekannte Fehlerklassen bekommen einen Klartext-Hinweis', () => {
  assert.match(detectBuildErrorHint('npm ERR! missing script: build') || '', /build.*start.*Script|Script/i);
  assert.match(detectBuildErrorHint('npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve') || '', /ERESOLVE/);
  assert.match(detectBuildErrorHint('Error: Cannot find module "sharp"') || '', /Modul/i);
  assert.match(detectBuildErrorHint('You are using Node.js 16.20.0. For Next.js, Node.js version') || '', /Node-Version/i);
});

test('[P2] TC-DEPL-06 unbekannte Fehler liefern null statt eines falschen Hinweises', () => {
  assert.equal(detectBuildErrorHint('irgendein unbekannter Fehler'), null);
  assert.equal(detectBuildErrorHint(''), null);
});

test('[P3] TC-DEPL-06 kurzes Log bleibt unveraendert, langes behaelt Anfang und Ende', () => {
  assert.equal(truncateBuildLog('kurz'), 'kurz');
  // Schwelle ist 1 MB; darunter wird bewusst nicht gekuerzt.
  const long = 'A'.repeat(600_000) + 'MITTE' + 'B'.repeat(600_000) + 'ENDE-MARKE';
  const out = truncateBuildLog(long);
  assert.ok(out.length < long.length);
  assert.ok(out.startsWith('AAAA'), 'Anfang muss erhalten bleiben');
  assert.ok(out.endsWith('ENDE-MARKE'), 'das Ende traegt den eigentlichen Fehler');
  assert.match(out, /gekürzt/);
});
