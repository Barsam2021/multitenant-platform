import { writeFile, unlink, readdir } from 'fs/promises';

const DYNAMIC_DIR = '/opt/multitenant-platform/traefik/dynamic';

// Namen der geteilten Middlewares. Referenziert werden sie mit dem Suffix
// @file, weil sie aus dem File-Provider kommen und auch von Routern aus
// Docker-Labels erreichbar sein muessen.
export const PUBLIC_RATE_LIMIT = 'public-ratelimit';
export const API_RATE_LIMIT = 'api-ratelimit';
const RATE_LIMIT_FILE = 'aa-rate-limit.yml';

/**
 * Legt die geteilten Rate-Limit-Middlewares an.
 *
 * Warum ueberhaupt auf dieser Ebene: bis hierher gab es Bremsen nur im
 * Provisioning Agent, also hinter dem Agent-Secret. Alles, was tatsaechlich im
 * offenen Internet steht — die Seiten der Kunden und die freigeschalteten
 * PostgREST-/GoTrue-Endpunkte — nahm beliebig viele Anfragen an. Da Postgres,
 * PgBouncer und der Arbeitsspeicher der Maschine von ALLEN Mandanten geteilt
 * werden, trifft eine einzige Kunden-API unter Last nicht nur ihren eigenen
 * Kunden, sondern die ganze Plattform.
 *
 * Zwei Stufen, weil die Kosten pro Anfrage sich um Groessenordnungen
 * unterscheiden: eine ausgelieferte Seite kostet fast nichts, eine
 * PostgREST-Abfrage laeuft in die gemeinsame Datenbank.
 *
 * average/burst gelten in Traefik je Quell-IP (sourceCriterion standardmaessig
 * request.host bzw. die Client-IP hinter den Forwarded-Headern). Die Werte sind
 * bewusst hoch genug, dass normales Surfen — eine Seite mit 40 Assets, ein
 * schneller Klickpfad — sie nie erreicht.
 *
 * Idempotent, wird bei jedem Agent-Start geschrieben: die Datei liegt in einem
 * Verzeichnis, das nicht versioniert ist (siehe .gitignore), und darf nach
 * einem Neuaufsetzen nicht fehlen.
 */
export async function ensureRateLimitMiddlewares(): Promise<void> {
  const yaml = `# Automatisch erzeugt vom Provisioning Agent — nicht von Hand editieren.
# Geteilte Rate-Limit-Middlewares fuer alles, was oeffentlich erreichbar ist.
http:
  middlewares:
    ${PUBLIC_RATE_LIMIT}:
      rateLimit:
        average: 50
        burst: 100
        period: 1s
    ${API_RATE_LIMIT}:
      rateLimit:
        average: 20
        burst: 40
        period: 1s
`;
  await writeFile(`${DYNAMIC_DIR}/${RATE_LIMIT_FILE}`, yaml, 'utf8');
}

/**
 * Wandelt einen Hostnamen in ein dateisystem- und YAML-sicheres Fragment um.
 * "www.kunde.at" -> "www_kunde_at"
 */
function safeHost(hostname: string): string {
  return hostname.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

export function routerFileName(projectSlug: string, hostname: string): string {
  return `custom-${projectSlug}-${safeHost(hostname)}.yml`;
}

/**
 * Schreibt einen Traefik-File-Provider-Router fuer GENAU EINE Custom Domain.
 *
 * Frueher hiess die Datei "<projectSlug>.yml" — eine Datei pro Projekt. Die zweite
 * Custom-Domain eines Projekts hat die erste damit stillschweigend ueberschrieben,
 * und das Entfernen einer Domain hat alle Router des Projekts geloescht. Jetzt:
 * eine Datei pro Domain, mit eigenem Router- UND Service-Namen (gleiche Service-Namen
 * in mehreren File-Provider-Dateien wuerden in Traefik kollidieren).
 *
 * Traefik watcht das Verzeichnis (--providers.file.watch=true), kein Neustart noetig.
 *
 * hostname/containerName landen ausschliesslich in einer YAML-Datei, nie in einer
 * Shell — beide werden trotzdem streng validiert.
 */
export async function writeCustomDomainRouter(
  projectSlug: string,
  hostname: string,
  containerName: string,
  containerPort = 3000,
  /**
   * Ist gesetzt, wenn diese Domain NICHT die primaere ist: dann liefert der Router
   * keinen Inhalt aus, sondern leitet per 301 auf die primaere Domain um. Ohne das
   * antworten kunde.at und www.kunde.at beide mit derselben Seite — Duplicate Content.
   */
  redirectTo?: string | null
): Promise<string> {
  if (!/^[a-z0-9.-]+$/.test(hostname)) {
    throw new Error('invalid hostname for traefik router');
  }
  if (!/^[a-z0-9-]+$/.test(projectSlug)) {
    throw new Error('invalid project slug for traefik router');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerName)) {
    throw new Error('invalid container name for traefik router');
  }
  if (redirectTo && !/^[a-z0-9.-]+$/.test(redirectTo)) {
    throw new Error('invalid redirect target');
  }
  const port = Number(containerPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid container port: ${containerPort}`);
  }

  const key = `${projectSlug}-${safeHost(hostname)}`;
  const routerName = `custom-${key}`;
  const serviceName = `custom-${key}-svc`;
  const fileName = routerFileName(projectSlug, hostname);

  // certResolver httpresolver = HTTP-01. Bewusst nicht myresolver (DNS-01 via
  // Cloudflare): Custom-Domains liegen per Definition ausserhalb unseres eigenen
  // Cloudflare-Accounts, DNS-01 kann dort nicht validieren.
  const header = `# Automatisch erzeugt vom Provisioning Agent — nicht von Hand editieren.
# Projekt: ${projectSlug}
# Domain:  ${hostname}
`;

  // Der Router braucht auch im Redirect-Fall ein gueltiges Zertifikat: die
  // Weiterleitung passiert NACH dem TLS-Handshake, ein Browser wuerde sonst
  // vorher eine Zertifikatswarnung zeigen.
  const yaml = redirectTo
    ? header + `http:
  middlewares:
    ${routerName}-redirect:
      redirectRegex:
        regex: "^https?://[^/]+/(.*)"
        replacement: "https://${redirectTo}/\${1}"
        permanent: true
  routers:
    ${routerName}:
      rule: "Host(\`${hostname}\`)"
      entryPoints:
        - websecure
      middlewares:
        - ${routerName}-redirect
        - ${PUBLIC_RATE_LIMIT}
      service: ${serviceName}
      tls:
        certResolver: httpresolver
  services:
    ${serviceName}:
      loadBalancer:
        servers:
          - url: "http://${containerName}:${port}"
`
    : header + `http:
  routers:
    ${routerName}:
      rule: "Host(\`${hostname}\`)"
      entryPoints:
        - websecure
      middlewares:
        - ${PUBLIC_RATE_LIMIT}
      service: ${serviceName}
      tls:
        certResolver: httpresolver
  services:
    ${serviceName}:
      loadBalancer:
        servers:
          - url: "http://${containerName}:${port}"
`;

  await writeFile(`${DYNAMIC_DIR}/${fileName}`, yaml, 'utf8');
  return fileName;
}

/** Entfernt den Router GENAU EINER Domain. */
export async function removeCustomDomainRouter(
  projectSlug: string,
  hostname: string
): Promise<void> {
  const fileName = routerFileName(projectSlug, hostname);
  await unlink(`${DYNAMIC_DIR}/${fileName}`).catch(() => {
    /* nicht vorhanden — egal */
  });
}

/** Entfernt eine Router-Datei anhand des in der DB gespeicherten Namens. */
export async function removeRouterFile(fileName: string): Promise<void> {
  if (!fileName || !/^[a-zA-Z0-9._-]+\.yml$/.test(fileName)) return;
  await unlink(`${DYNAMIC_DIR}/${fileName}`).catch(() => {});
}

/**
 * P1-6: Router fuer den PostgREST- oder GoTrue-Container EINES Tenants — nur
 * gesetzt, wenn der Kunde in `kunden.postgrest_public_enabled` bzw.
 * `auth_public_enabled` (Migration 02, bis jetzt nie gelesen) zugestimmt hat.
 * Beide Container liegen sonst ausschliesslich im Docker-internen `traefik-net`
 * und sind von aussen gar nicht adressierbar — genau das Problem, das die
 * Dashboard-Anzeige "POSTGREST_URL: http://api-<slug>:3000" verschleiert hat.
 *
 * DNS-01 (myresolver) statt HTTP-01: die Hostnamen liegen unter der eigenen
 * PLATFORM_DOMAIN (Wildcard-Zertifikat via Cloudflare bereits vorhanden),
 * anders als bei Custom-Domains von Kunden.
 */
export function tenantServiceRouterFileName(kind: 'postgrest' | 'auth', tenantSlug: string): string {
  return `tenant-${kind}-${tenantSlug}.yml`;
}

export async function writeTenantServiceRouter(
  kind: 'postgrest' | 'auth',
  tenantSlug: string,
  hostname: string
): Promise<string> {
  if (!/^[a-z0-9-]+$/.test(tenantSlug)) throw new Error('invalid tenant slug for traefik router');
  if (!/^[a-z0-9.-]+$/.test(hostname)) throw new Error('invalid hostname for traefik router');

  const containerName = kind === 'postgrest' ? `api-${tenantSlug}` : `auth-${tenantSlug}`;
  const containerPort = kind === 'postgrest' ? 3000 : 9999;
  const routerName = `tenant-${kind}-${tenantSlug}`;
  const fileName = tenantServiceRouterFileName(kind, tenantSlug);

  const yaml = `# Automatisch erzeugt vom Provisioning Agent — nicht von Hand editieren.
# Tenant:  ${tenantSlug}
# Dienst:  ${kind === 'postgrest' ? 'PostgREST' : 'GoTrue'}
http:
  routers:
    ${routerName}:
      rule: "Host(\`${hostname}\`)"
      entryPoints:
        - websecure
      middlewares:
        - ${API_RATE_LIMIT}
      service: ${routerName}-svc
      tls:
        certResolver: myresolver
  services:
    ${routerName}-svc:
      loadBalancer:
        servers:
          - url: "http://${containerName}:${containerPort}"
`;

  await writeFile(`${DYNAMIC_DIR}/${fileName}`, yaml, 'utf8');
  return fileName;
}

/**
 * Schreibt die Router der oeffentlich freigeschalteten Tenant-Dienste neu.
 *
 * Diese Dateien entstehen nur beim Umschalten der Freigabe und wurden danach
 * nie wieder angefasst. Aendert sich ihr Inhalt im Code — so wie jetzt mit der
 * Rate-Limit-Middleware —, bleiben bestehende Installationen stillschweigend
 * auf dem alten Stand: die Datei ist da, sie sieht unauffaellig aus, und die
 * Bremse fehlt trotzdem. Genau dieser Fall ist im Lasttest aufgefallen.
 *
 * Laeuft beim Agent-Start, idempotent.
 */
export async function resyncTenantServiceRouters(
  tenants: { slug: string; postgrestHost: string | null; authHost: string | null }[]
): Promise<number> {
  let written = 0;
  for (const tenant of tenants) {
    if (tenant.postgrestHost) {
      await writeTenantServiceRouter('postgrest', tenant.slug, tenant.postgrestHost)
        .then(() => { written++; })
        .catch((e: any) => console.error(`Router postgrest/${tenant.slug}:`, e.message));
    }
    if (tenant.authHost) {
      await writeTenantServiceRouter('auth', tenant.slug, tenant.authHost)
        .then(() => { written++; })
        .catch((e: any) => console.error(`Router auth/${tenant.slug}:`, e.message));
    }
  }
  return written;
}

export async function removeTenantServiceRouter(kind: 'postgrest' | 'auth', tenantSlug: string): Promise<void> {
  const fileName = tenantServiceRouterFileName(kind, tenantSlug);
  await unlink(`${DYNAMIC_DIR}/${fileName}`).catch(() => {});
}

/**
 * P1-1j: alle Router eines Projekts entfernen — beim Loeschen von Projekt oder Tenant.
 * Ohne das bleiben Router zurueck, die auf nicht mehr existierende Container zeigen.
 */
export async function removeAllRoutersForProject(projectSlug: string): Promise<number> {
  if (!/^[a-z0-9-]+$/.test(projectSlug)) return 0;
  let removed = 0;
  try {
    const files = await readdir(DYNAMIC_DIR);
    for (const f of files) {
      if (f === `${projectSlug}.yml` || f.startsWith(`custom-${projectSlug}-`)) {
        await unlink(`${DYNAMIC_DIR}/${f}`).catch(() => {});
        removed++;
      }
    }
  } catch {
    /* Verzeichnis nicht lesbar — ignorieren */
  }
  return removed;
}
