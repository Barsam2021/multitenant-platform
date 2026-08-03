import { writeFile, unlink } from 'fs/promises';

const DYNAMIC_DIR = '/opt/multitenant-platform/traefik/dynamic';

/**
 * Schreibt/aktualisiert einen Traefik File-Provider-Router für eine Custom Domain.
 * Traefik v3 watcht dieses Verzeichnis (`--providers.file.watch=true`, siehe
 * 02_vps_bootstrap_guide.md § 5.1) — kein Container-Neustart nötig.
 *
 * WICHTIG: hostname und containerName werden NIE in einen Shell-Befehl interpoliert,
 * nur in eine YAML-Struktur (Template-Literal ist hier unkritisch, da direkt in eine
 * Datei geschrieben wird, nicht an eine Shell übergeben — siehe CLAUDE.md § 1.1 vs § 2.2).
 */
export async function writeCustomDomainRouter(
  projectSlug: string,
  hostname: string,
  containerName: string,
  containerPort = 3000
): Promise<void> {
  if (!/^[a-z0-9.-]+$/.test(hostname)) {
    throw new Error('invalid hostname for traefik router');
  }
  if (!/^[a-z0-9-]+$/.test(projectSlug)) {
    throw new Error('invalid project slug for traefik router');
  }

  const routerName = `app-${projectSlug}-custom`;
  const serviceName = `app-${projectSlug}`;

  const yaml = `http:
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
          - url: "http://${containerName}:${containerPort}"
`;

  await writeFile(`${DYNAMIC_DIR}/${projectSlug}.yml`, yaml, 'utf8');
}

export async function removeCustomDomainRouter(projectSlug: string): Promise<void> {
  if (!/^[a-z0-9-]+$/.test(projectSlug)) {
    throw new Error('invalid project slug for traefik router removal');
  }
  await unlink(`${DYNAMIC_DIR}/${projectSlug}.yml`).catch(() => {
    /* Datei existiert nicht — ignorieren */
  });
}
