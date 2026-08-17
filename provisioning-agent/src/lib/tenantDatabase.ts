import { Client } from 'pg';
import format from 'pg-format';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';

const execFileP = promisify(execFile);
const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

/**
 * Alles, was die OPTIONALE Datenbank-/Auth-Ebene eines Tenants ausmacht:
 * Postgres-DB, Rollen, docker-compose.yml, PostgREST- und GoTrue-Container.
 *
 * Warum optional: ein Kunde mit einer reinen Landingpage braucht davon nichts.
 * Trotzdem liefen bis hierher fuer JEDEN Tenant zwei Container dauerhaft mit
 * (PostgREST ~64 MB, GoTrue ~128 MB) plus zwei PgBouncer-Pools. Auf einer
 * 8-GB-VPS ist das der Unterschied zwischen ~10 und ~25 Kunden.
 *
 * Der Code lag vorher inline in index.ts POST /tenants und war damit nur beim
 * Anlegen eines Tenants erreichbar. Hier extrahiert, damit ihn auch das
 * nachtraegliche Einschalten (POST /tenants/:slug/database) nutzen kann —
 * dieselbe Reihenfolge, dieselben Sicherheits-Schritte (REVOKE vor GRANT), kein
 * zweiter, leicht abweichender Provisioning-Pfad.
 */

export function tenantDir(slug: string): string {
  return `/opt/multitenant-platform/kunden-instances/${slug}`;
}

export function tenantComposeFile(slug: string): string {
  return `${tenantDir(slug)}/docker-compose.yml`;
}

export function tenantComposeExists(slug: string): boolean {
  return existsSync(tenantComposeFile(slug));
}

/**
 * Schreibt die docker-compose.yml des Tenants aus dem Template. Wird sowohl beim
 * ersten Provisioning als auch beim Wieder-Einschalten aufgerufen — beim
 * Wieder-Einschalten deshalb, weil sich Tarif-Limits oder RESEND_API_KEY
 * zwischenzeitlich geaendert haben koennen.
 */
export async function writeTenantCompose(
  slug: string,
  tariff: string,
  jwtSecret: string,
  authenticatorPassword: string
): Promise<string> {
  const tierPrefix = (['starter', 'business', 'premium'].includes(tariff) ? tariff : 'starter').toUpperCase();
  const postgrestMem = process.env[`${tierPrefix}_POSTGREST_MEM`] || '64m';
  const postgrestCpus = process.env[`${tierPrefix}_POSTGREST_CPUS`] || '0.25';
  const gotrueMem = process.env[`${tierPrefix}_GOTRUE_MEM`] || '128m';
  const gotrueCpus = process.env[`${tierPrefix}_GOTRUE_CPUS`] || '0.25';

  const template = await readFile('/app/templates/tenant-compose.yml', 'utf8');
  const compose = template
    .replace(/\$\{SLUG\}/g, slug)
    .replace(/\$\{JWT_SECRET\}/g, jwtSecret)
    .replace(/\$\{AUTH_PW\}/g, authenticatorPassword)
    .replace(/\$\{AUTH_ROLE\}/g, `authenticator_${slug}`)
    .replace(/\$\{PLATFORM_DOMAIN\}/g, process.env.PLATFORM_DOMAIN as string)
    .replace(/\$\{POSTGREST_MEM\}/g, postgrestMem)
    .replace(/\$\{POSTGREST_CPUS\}/g, postgrestCpus)
    .replace(/\$\{GOTRUE_MEM\}/g, gotrueMem)
    .replace(/\$\{GOTRUE_CPUS\}/g, gotrueCpus)
    // P1-7: hier stand bisher hart '' — RESEND_API_KEY wurde nie tatsächlich
    // durchgereicht, GOTRUE_SMTP_PASS war deshalb bei JEDEM Tenant leer und
    // GoTrue konnte nie eine Bestätigungsmail verschicken (bei
    // GOTRUE_MAILER_AUTOCONFIRM=false heisst das: kein Tenant-User konnte sich
    // je registrieren). RESEND_API_KEY ist eine globale Plattform-Variable
    // (.env.example), keine pro-Tenant-Einstellung — resend_api_key_encrypted
    // in kunden bleibt bewusst ungenutzt (siehe routes/secrets.ts Kommentar).
    .replace(/\$\{RESEND_API_KEY\}/g, process.env.RESEND_API_KEY || '')
    .replace(/\$\{TENANT_NAME\}/g, slug);

  if (!process.env.RESEND_API_KEY) {
    console.warn(
      `RESEND_API_KEY nicht gesetzt — GoTrue-Bestätigungsmails für Tenant "${slug}" ` +
      `werden fehlschlagen, kein User kann sich registrieren, bis .env ergänzt und ` +
      `der auth-Container neu gestartet wird.`
    );
  }

  const dir = tenantDir(slug);
  await mkdir(dir, { recursive: true });
  await writeFile(tenantComposeFile(slug), compose);
  return dir;
}

/** Wartet, bis GoTrue seine DB-Migrationen durch hat und /health antwortet. */
async function waitForGotrue(slug: string): Promise<void> {
  // P2-1: vorher hart `setTimeout(8000)`. Auf einer belasteten VPS ist GoTrue
  // nach 8s noch nicht durch seine DB-Migrationen — das Provisioning scheiterte
  // dann und loeste (vor P0-3) das destruktive Rollback aus. Jetzt echter
  // Readiness-Poll gegen /health, mit 90s Obergrenze fuer langsame Maschinen.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://auth-${slug}:9999/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return;
    } catch { /* Container startet noch */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`GoTrue (auth-${slug}) wurde in 90s nicht bereit — docker logs auth-${slug} pruefen`);
}

/**
 * Legt Datenbank, Rollen und Tenant-Container an. Idempotent ist das NICHT —
 * `CREATE DATABASE` auf eine bestehende DB wirft, und genau das soll es auch:
 * der Aufrufer prueft vorher kunden.db_provisioned.
 */
export async function provisionTenantDatabase(opts: {
  slug: string;
  tariff: string;
  jwtSecret: string;
  authenticatorPassword: string;
}): Promise<void> {
  const { slug, tariff, jwtSecret, authenticatorPassword } = opts;
  const dbName = `kunde_${slug}`;
  const authenticatorRole = `authenticator_${slug}`;

  const master = new Client({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/postgres`,
  });
  master.on('error', (e) => console.error('pg client error (master):', e.message));
  await master.connect();
  try {
    await master.query(format('CREATE DATABASE %I;', dbName));
    // P0-2a (Audit 0430f9c): Postgres vergibt CONNECT auf jede neue Datenbank
    // standardmaessig an PUBLIC. Ohne dieses REVOKE kann sich JEDE Login-Rolle
    // im Cluster — also jeder authenticator_<fremder-slug> — auf diese Tenant-DB
    // verbinden. Zusammen mit den clusterweiten Rollen anon/authenticated/
    // service_role (BYPASSRLS) bedeutet das vollen Lese- und Schreibzugriff auf
    // fremde Tenants. Muss VOR dem Rollen-Template stehen, damit zwischen
    // CREATE DATABASE und REVOKE kein Fenster offen ist.
    await master.query(format('REVOKE ALL ON DATABASE %I FROM PUBLIC;', dbName));
  } finally {
    await master.end().catch(() => {});
  }

  const tenant = new Client({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/${dbName}`,
  });
  tenant.on('error', (e) => console.error('pg client error (tenant):', e.message));
  await tenant.connect();
  try {
    const rolesSql = await readFile(
      '/opt/multitenant-platform/core-postgres/templates/authenticator-role.sql.template',
      'utf8'
    );
    await tenant.query(
      rolesSql
        .replace(/__AUTH_ROLE__/g, authenticatorRole)
        .replace(/__ANON_ROLE__/g, `anon_${slug}`)
        .replace(/__AUTHENTICATED_ROLE__/g, `authenticated_${slug}`)
        .replace(/__SERVICE_ROLE__/g, `service_role_${slug}`)
        .replace(/CHANGE_ME/g, authenticatorPassword)
    );
    await tenant.query(format('CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION %I;', authenticatorRole));
    await tenant.query(format('GRANT ALL ON SCHEMA auth TO %I;', authenticatorRole));
    await tenant.query(format('ALTER ROLE %I IN DATABASE %I SET search_path = auth, public;', authenticatorRole, dbName));
    // P0-2a: Gegenstueck zum REVOKE oben — genau diese eine Rolle darf rein.
    // TEMPORARY ist session-lokal und damit kein Isolationsrisiko.
    await tenant.query(format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I;', dbName, authenticatorRole));
  } finally {
    await tenant.end().catch(() => {});
  }

  const dir = await writeTenantCompose(slug, tariff, jwtSecret, authenticatorPassword);
  await execFileP('docker', ['compose', '-f', `${dir}/docker-compose.yml`, 'up', '-d', 'auth']);
  await waitForGotrue(slug);
  await execFileP('docker', ['compose', '-f', `${dir}/docker-compose.yml`, 'up', '-d', 'api']);
}

/**
 * Container wieder hochfahren, ohne die Datenbank anzufassen. `up -d` statt
 * `start`, weil nach einem `down` keine Container mehr existieren, die man
 * starten koennte.
 */
export async function startTenantServices(slug: string): Promise<void> {
  if (!tenantComposeExists(slug)) {
    throw new Error(`Keine docker-compose.yml fuer Tenant "${slug}" — Datenbank wurde nie provisioniert.`);
  }
  await execFileP('docker', ['compose', '-f', tenantComposeFile(slug), 'up', '-d']);
}

/**
 * Container entfernen, Datenbank BEHALTEN. `down` statt `stop`: gestoppte
 * Container belegen zwar keinen RAM, aber der Sinn der Uebung ist, dass am
 * Ende nichts mehr da ist, was der Docker-Daemon verwaltet. Die Daten des
 * Kunden liegen in Postgres, nicht in diesen Containern — Volumes werden
 * bewusst NICHT mit entfernt (`down` ohne -v).
 */
export async function stopTenantServices(slug: string): Promise<void> {
  if (!tenantComposeExists(slug)) return;
  await execFileP('docker', ['compose', '-f', tenantComposeFile(slug), 'down']);
}
