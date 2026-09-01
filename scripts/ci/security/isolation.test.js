/**
 * Mandantentrennung — die vier Ebenen aus ANALYSE_1.md §2, jede mit einem
 * NEGATIVTEST. Ein Positivtest beweist hier nichts: dass Tenant A seine eigenen
 * Daten sieht, sagt nichts darueber, ob er auch die von B sieht.
 *
 * Laeuft gegen den isolierten CI-Stack (docker-compose.ci.yml), niemals gegen
 * die Live-VPS — scripts/ci/assert-not-production.sh bricht das ab.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('/opt/multitenant-platform/provisioning-agent/node_modules/pg');

const A = process.env.CI_TENANT_A;
const B = process.env.CI_TENANT_B;
const PW_A = process.env.CI_TENANT_A_PW;
const PW_B = process.env.CI_TENANT_B_PW;
const MASTER = process.env.MASTER_DB_PASSWORD;
const BOUNCER = process.env.PGBOUNCER_HOST || 'pgbouncer';

/** Verbindung ueber PgBouncer — derselbe Weg, den PostgREST und GoTrue nehmen. */
function conn(user, password, db) {
  return new Client({ host: BOUNCER, port: 5432, user, password, database: db, connectionTimeoutMillis: 10_000 });
}

async function tryConnect(user, password, db) {
  const c = conn(user, password, db);
  try {
    await c.connect();
    const { rows } = await c.query('SELECT current_user, current_database()');
    await c.end();
    return { ok: true, ...rows[0] };
  } catch (err) {
    await c.end().catch(() => {});
    return { ok: false, error: err.message };
  }
}

let admin;
before(async () => {
  admin = new Client({ host: BOUNCER, port: 5432, user: 'postgres', password: MASTER, database: 'postgres' });
  await admin.connect();
});
after(async () => { await admin?.end().catch(() => {}); });

// --------------------------------------------------------------- Ebene 1
test('[P0] TC-ISO-01 authenticator eines Tenants kommt nicht in die fremde Datenbank', async () => {
  const res = await tryConnect(`authenticator_${A}`, PW_A, `kunde_${B}`);
  assert.equal(res.ok, false, `authenticator_${A} durfte sich mit kunde_${B} verbinden — Isolation Ebene 1 ist offen`);
  // REVOKE ALL ON DATABASE ... FROM PUBLIC (P0-2a) ist der Grund.
  assert.match(res.error, /permission denied|nicht berechtigt|no pg_hba|authentication/i);
});

test('[P0] TC-ISO-01 der eigene authenticator kommt in die eigene Datenbank', async () => {
  // Gegenprobe: schluege auch das fehl, waere der Test oben wertlos, weil er
  // dann nur beweist, dass ueberhaupt nichts funktioniert.
  const res = await tryConnect(`authenticator_${A}`, PW_A, `kunde_${A}`);
  assert.equal(res.ok, true, `authenticator_${A} kommt nicht in die eigene DB: ${res.error}`);
});

test('[P0] TC-ISO-06 keine Tenant-Datenbank vergibt CONNECT an PUBLIC', async () => {
  const { rows } = await admin.query(`
    SELECT datname, datacl::text AS acl
      FROM pg_database
     WHERE datname LIKE 'kunde\\_%'`);
  assert.ok(rows.length >= 2, 'Testmandanten fehlen — Stack nicht vollstaendig aufgebaut?');
  for (const row of rows) {
    // Ein datacl von NULL bedeutet "Default", und der Default IST CONNECT fuer
    // PUBLIC. Genau deshalb muss hier eine explizite ACL stehen.
    assert.ok(row.acl, `${row.datname} hat keine explizite ACL — PUBLIC darf sich verbinden`);
    assert.ok(!/(^|,)=Tc?\//.test(row.acl), `${row.datname} vergibt Rechte an PUBLIC: ${row.acl}`);
  }
});

// --------------------------------------------------------------- Ebene 2
test('[P0] TC-ISO-02 die Rollen eines Tenants haben in der fremden Datenbank keine Rechte', async () => {
  const c = conn('postgres', MASTER, `kunde_${B}`);
  await c.connect();
  try {
    for (const role of [`anon_${A}`, `authenticated_${A}`, `service_role_${A}`]) {
      const { rows } = await c.query(
        `SELECT has_database_privilege($1, current_database(), 'CONNECT') AS may_connect`, [role]
      );
      assert.equal(rows[0].may_connect, false, `${role} darf sich mit kunde_${B} verbinden`);
    }
  } finally {
    await c.end();
  }
});

test('[P0] TC-ISO-02 authenticator ist NOINHERIT und nicht Mitglied fremder Rollen', async () => {
  // Vor P0-2b war jeder Authenticator Mitglied der clusterweiten Rollen
  // anon/authenticated/service_role — und service_role hat BYPASSRLS.
  const { rows } = await admin.query(
    `SELECT r.rolname, r.rolinherit,
            ARRAY(SELECT g.rolname FROM pg_auth_members m
                    JOIN pg_roles g ON g.oid = m.roleid
                   WHERE m.member = r.oid) AS memberof
       FROM pg_roles r WHERE r.rolname = $1`, [`authenticator_${A}`]);
  assert.equal(rows.length, 1, `authenticator_${A} existiert nicht`);
  assert.equal(rows[0].rolinherit, false, 'authenticator muss NOINHERIT sein');
  for (const g of rows[0].memberof) {
    assert.ok(g.endsWith(`_${A}`), `authenticator_${A} ist Mitglied der fremden/clusterweiten Rolle ${g}`);
  }
});

test('[P0] TC-ISO-02 keine clusterweite Rolle mit BYPASSRLS ist an einen Tenant vergeben', async () => {
  const { rows } = await admin.query(
    `SELECT g.rolname AS grantee_of, m2.rolname AS member
       FROM pg_auth_members am
       JOIN pg_roles g  ON g.oid  = am.roleid
       JOIN pg_roles m2 ON m2.oid = am.member
      WHERE g.rolbypassrls AND m2.rolname LIKE 'authenticator\\_%'`);
  assert.deepEqual(rows, [], `BYPASSRLS-Rolle an einen Tenant-Authenticator vergeben: ${JSON.stringify(rows)}`);
});

// --------------------------------------------------------------- Ebene 3
test('[P0] TC-ISO-03 PgBouncer weist ein falsches Passwort ab statt auf postgres zu mappen', async () => {
  // Der stillste und gefaehrlichste Einzelfehler der Plattform: ohne AUTH_QUERY
  // erzeugt das Image userlist.txt nur aus DB_USER/DB_PASSWORD und pinnt jede
  // unbekannte Rolle auf `postgres` — PostgREST waere dann in JEDER Tenant-DB
  // Superuser. Der Fehler produziert keinen Fehler, sondern Zugriff.
  const res = await tryConnect(`authenticator_${A}`, 'definitiv-falsches-passwort', `kunde_${A}`);
  assert.equal(res.ok, false, 'PgBouncer hat ein falsches Passwort akzeptiert');
});

test('[P0] TC-POOL-01 die Verbindung laeuft als der Tenant-Authenticator, nicht als postgres', async () => {
  const res = await tryConnect(`authenticator_${A}`, PW_A, `kunde_${A}`);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.current_user, `authenticator_${A}`);
  assert.notEqual(res.current_user, 'postgres');
  assert.equal(res.current_database, `kunde_${A}`);
});

test('[P0] TC-ISO-03 der Authenticator des Nachbarn hilft mit seinem eigenen Passwort nicht weiter', async () => {
  const res = await tryConnect(`authenticator_${B}`, PW_B, `kunde_${A}`);
  assert.equal(res.ok, false, `authenticator_${B} kam in kunde_${A}`);
});
