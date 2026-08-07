import { writeFile, unlink, readdir } from 'fs/promises';

const DYNAMIC_DIR = '/opt/multitenant-platform/traefik/dynamic';

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
