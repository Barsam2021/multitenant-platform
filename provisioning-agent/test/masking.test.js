/**
 * TC-AUD-02 (P0) — maskSecrets().
 *
 * Der Rueckgabewert landet in `deployments.build_log`, und das Dashboard
 * rendert die Spalte unter "Build-Log anzeigen". Vor P0-4 filterte die Funktion
 * nur sechs feste Variablennamen — SUPABASE_SERVICE_ROLE_KEY (BYPASSRLS) war
 * keiner davon.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { maskSecrets } = require('../dist/lib/crypto');

const leakCheck = (out, secret) =>
  assert.ok(!out.includes(secret), `Secret steht noch im Log: ${out}`);

test('[P0] TC-AUD-02 maskiert Secrets nach Namensmuster', () => {
  const cases = [
    'JWT_SECRET=abcdef123456',
    'SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiJ9.xxx',
    'MINIO_SECRET_KEY=0123456789abcdef',
    'ADMIN_PASSWORD: hunter2hunter2',
    'GITHUB_TOKEN="ghp_abcdefghijklmnop"',
    "CF_DNS_API_TOKEN='tok_liveXYZ'",
    'MY_APIKEY=zzzz9999',
  ];
  for (const line of cases) {
    const out = maskSecrets(line);
    assert.match(out, /\*\*\*/, `nicht maskiert: ${line}`);
    leakCheck(out, line.split(/[:=]/).slice(1).join('').replace(/["']/g, '').trim());
  }
});

test('[P0] TC-AUD-02 maskiert Zugangsdaten in Verbindungs-URLs', () => {
  const out = maskSecrets('postgres://authenticator_kunde:s3hr-geheim@pgbouncer:5432/kunde_x');
  leakCheck(out, 's3hr-geheim');
  assert.match(out, /postgres:\/\/authenticator_kunde:\*\*\*@pgbouncer/);
});

test('[P0] TC-AUD-02 maskiert uebergebene Werte auch ohne Variablennamen', () => {
  // Die zweite Schicht: der Wert taucht mitten in einer npm-Fehlermeldung auf,
  // ohne dass ein Variablenname danebensteht.
  const secret = 'eyJhbGciOiJIUzI1NiJ9.SUPERGEHEIM.sig';
  const out = maskSecrets(`npm ERR! request failed with bearer ${secret} at line 3`, [secret]);
  leakCheck(out, secret);
});

test('[P0] TC-AUD-02 laengeres Secret wird nicht durch ein kuerzeres zerhackt', () => {
  const short = 'abcdefgh';
  const long = 'abcdefgh-und-noch-viel-mehr';
  const out = maskSecrets(`wert=${long}`, [short, long]);
  leakCheck(out, long);
  leakCheck(out, short);
});

test('[P0] TC-AUD-02 zu kurze Werte werden ignoriert statt alles zu zerstoeren', () => {
  // Ein 3-Zeichen-"Secret" wuerde sonst jedes Vorkommen im ganzen Log ersetzen.
  const out = maskSecrets('build ok in abc seconds', ['abc']);
  assert.equal(out, 'build ok in abc seconds');
});

test('[P0] TC-AUD-02 leerer Input bleibt unveraendert', () => {
  assert.equal(maskSecrets(''), '');
});
