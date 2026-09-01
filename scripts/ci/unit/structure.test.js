/**
 * Struktur-Tests gegen den Quellbaum. Brauchen weder Docker noch Datenbank und
 * laufen in Millisekunden — deshalb stehen sie in der ersten Stufe der Pipeline.
 *
 * TC-ADM-01 (P0) schliesst die Luecke aus ANALYSE_1.md A5: heute ruft jede
 * Dashboard-API-Route ihren eigenen auth()-Guard auf, aber nichts erzwingt das
 * fuer eine NEUE Route. Der Test scannt das Verzeichnis, statt eine gepflegte
 * Liste zu fuehren — sonst verliert er seinen Wert genau dann, wenn er
 * gebraucht wird.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const API_DIR = path.join(REPO, 'dashboard', 'src', 'app', 'api');

/** Route-Dateien, die bewusst keinen eigenen Guard haben. */
const GUARD_EXEMPT = [
  // Der NextAuth-Catch-all IST der Login-Endpunkt — ein auth()-Guard davor
  // wuerde die Anmeldung selbst aussperren.
  path.join('auth', '[...nextauth]', 'route.ts'),
];

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name === 'route.ts') out.push(full);
  }
  return out;
}

/** Zerlegt eine Route-Datei in ihre exportierten HTTP-Handler. */
function handlerBodies(source) {
  const marker = new RegExp(`export\\s+(?:async\\s+)?function\\s+(${HTTP_METHODS.join('|')})\\b`, 'g');
  const hits = [...source.matchAll(marker)];
  return hits.map((hit, i) => ({
    method: hit[1],
    body: source.slice(hit.index, i + 1 < hits.length ? hits[i + 1].index : source.length),
  }));
}

const routeFiles = walk(API_DIR);

test('[P0] TC-ADM-01 der Routen-Scan findet ueberhaupt Routen', () => {
  // Schutz gegen den stillsten Fehlerfall dieses Tests: ein umbenanntes
  // Verzeichnis laesst ihn sonst gruen durchlaufen, ohne etwas zu pruefen.
  assert.ok(routeFiles.length >= 40, `nur ${routeFiles.length} Route-Dateien gefunden`);
});

test('[P0] TC-ADM-01 jeder HTTP-Handler einer Dashboard-API-Route prueft die Session', () => {
  const offenders = [];
  for (const file of routeFiles) {
    const rel = path.relative(API_DIR, file);
    if (GUARD_EXEMPT.includes(rel)) continue;
    const source = fs.readFileSync(file, 'utf8');
    const handlers = handlerBodies(source);
    if (handlers.length === 0) {
      offenders.push(`${rel}: kein exportierter HTTP-Handler erkannt`);
      continue;
    }
    for (const { method, body } of handlers) {
      if (!/\bauth\(\)/.test(body)) offenders.push(`${rel}: ${method} ohne auth()`);
    }
  }
  assert.deepEqual(offenders, [], `Routen ohne Session-Pruefung:\n  ${offenders.join('\n  ')}`);
});

test('[P0] TC-ADM-01 die Ausnahmeliste bleibt so kurz wie dokumentiert', () => {
  // Waechst sie, ist das eine bewusste Entscheidung und gehoert in den Diff —
  // nicht in eine stillschweigende Erweiterung.
  assert.equal(GUARD_EXEMPT.length, 1);
  for (const rel of GUARD_EXEMPT) {
    assert.ok(fs.existsSync(path.join(API_DIR, rel)), `Ausnahme zeigt ins Leere: ${rel}`);
  }
});

/**
 * TC-PROV-06 (P1) — der Slug ist die Wurzel aller abgeleiteten Namen
 * (DB kunde_<slug>, Rollen, Bucket, Container, Netz). Weicht eine Stelle vom
 * Muster ab, entstehen Namen, die eine andere Stelle nicht mehr wiederfindet.
 */
const SLUG_PATTERN_FILES = [
  'provisioning-agent/src',
  'dashboard/src',
  'cms/src',
];

test('[P1] TC-PROV-06 alle Slug-Regexe im Code verwenden dasselbe Muster', () => {
  const expected = '/^[a-z0-9-]+$/';
  const wrong = [];
  for (const rel of SLUG_PATTERN_FILES) {
    const base = path.join(REPO, rel);
    if (!fs.existsSync(base)) continue;
    const files = [];
    (function collect(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) collect(full);
        else if (/\.tsx?$/.test(e.name)) files.push(full);
      }
    })(base);

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      source.split('\n').forEach((line, i) => {
        if (!/slug/i.test(line)) return;
        for (const m of line.matchAll(/\/\^\[[^\]]*\]\+\$\//g)) {
          if (m[0] !== expected) {
            wrong.push(`${path.relative(REPO, file)}:${i + 1} ${m[0]}`);
          }
        }
      });
    }
  }
  assert.deepEqual(wrong, [], `abweichende Slug-Muster:\n  ${wrong.join('\n  ')}`);
});

/**
 * TC-STOR-01 (P0, TEILABDECKUNG) — die MinIO-Policy je Mandant.
 *
 * Der volle Test ("Tenant A kommt nicht an Bucket B") braucht die
 * MinIO-Provisionierung, und die liegt in index.ts mitten im Request-Handler
 * von POST /tenants — nicht ohne Serverstart aufrufbar. Bis das herausgeloest
 * ist (offener Punkt in CI-SETUP.md), prueft dieser Test wenigstens, dass die
 * erzeugte Policy den Zugriff auf die beiden EIGENEN ARNs begrenzt. Eine
 * Aufweichung auf `arn:aws:s3:::*` faellt damit sofort auf.
 */
test('[P0] TC-STOR-01 die MinIO-Policy nennt ausschliesslich die eigenen Bucket-ARNs', () => {
  const source = fs.readFileSync(path.join(REPO, 'provisioning-agent', 'src', 'index.ts'), 'utf8');
  const arns = [...source.matchAll(/`arn:aws:s3:::([^`]+)`/g)].map((m) => m[1]);
  assert.ok(arns.length >= 2, 'keine Bucket-ARNs in der Policy gefunden — Codestelle umgebaut?');
  for (const arn of arns) {
    assert.match(
      arn,
      /^kunde-\$\{tenantSlug\}-storage(\/\*)?$/,
      `Policy-ARN ist nicht auf den eigenen Bucket begrenzt: ${arn}`
    );
  }
  // Wildcards, die jeden Bucket einschliessen wuerden.
  assert.ok(!/arn:aws:s3:::\*/.test(source), 'Policy enthaelt einen Alles-Wildcard');
});

test('[P0] TC-STOR-01 Bucket- und Policy-Namen bleiben an den Slug gebunden', () => {
  const source = fs.readFileSync(path.join(REPO, 'provisioning-agent', 'src', 'index.ts'), 'utf8');
  assert.match(source, /kunde-\$\{tenantSlug\}-storage/, 'Bucket-Namensschema geaendert');
  assert.match(source, /kunde-\$\{tenantSlug\}-policy/, 'Policy-Namensschema geaendert');
});
