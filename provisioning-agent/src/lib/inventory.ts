/**
 * Versionsinventar (docs/CVE-PLAN.md, Ebene A/B/C).
 *
 * Zwei Wahrheiten, absichtlich beide:
 *   - Die Compose-Dateien sagen, was gepinnt IST.
 *   - Die Docker-API sagt, was tatsaechlich LAEUFT.
 * Sie weichen voneinander ab, sobald jemand ein Update nicht ausgerollt hat.
 * Gefuehrt wird deshalb der laufende Stand, die Pins kommen als Vergleich
 * daneben — sonst faellt genau dieser Fall nie auf.
 */
import { Client as PGClient } from 'pg';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

const execFileP = promisify(execFile);

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;
// Ueberschreibbar, damit sich das Einlesen der Compose-Pins ohne laufende
// Installation pruefen laesst. Im Betrieb bleibt es beim festen Pfad.
const ROOT = process.env.PLATFORM_ROOT || '/opt/multitenant-platform';

function adminClient(): PGClient {
  // P1-4: ohne 'error'-Listener ist ein Verbindungsabbruch eine uncaught
  // exception und damit das Prozessende.
  const client = new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
  client.on('error', (err) => console.error('pg client error (inventory):', err.message));
  return client;
}

export type Scope = 'platform' | 'tenant' | 'project';

export interface Component {
  scope: Scope;
  projectId: string | null;
  target: string;
  kind: 'image' | 'npm' | 'deb' | 'apk' | 'other';
  name: string;
  version: string;
  pinnedVersion?: string | null;
}

/**
 * Compose-Dateien, die zur Plattform selbst gehoeren, und ihre Zuordnung.
 * `tenant` sind die Dienste, die je Mandant hochgefahren werden — der
 * Betreiber kann sie aktualisieren, betroffen sind aber alle Tenants.
 */
const COMPOSE_SOURCES: { file: string; scope: Scope }[] = [
  { file: 'traefik/docker-compose.yml', scope: 'platform' },
  { file: 'core-postgres/docker-compose.yml', scope: 'platform' },
  { file: 'minio/docker-compose.yml', scope: 'platform' },
  { file: 'cloudflared/docker-compose.yml', scope: 'platform' },
  { file: 'monitoring/uptime-kuma/docker-compose.yml', scope: 'platform' },
  { file: 'provisioning-agent/docker-compose.yml', scope: 'platform' },
  { file: 'provisioning-agent/templates/tenant-compose.yml', scope: 'tenant' },
];

/** Zerlegt eine Image-Referenz in Name und Version. */
export function splitImageRef(ref: string): { name: string; version: string } {
  // Der Doppelpunkt eines Registry-Ports (registry:5000/foo) darf nicht als
  // Tag-Trenner gelesen werden: nur ein Doppelpunkt NACH dem letzten Slash
  // trennt den Tag ab.
  const lastSlash = ref.lastIndexOf('/');
  const lastColon = ref.lastIndexOf(':');
  if (lastColon > lastSlash) {
    return { name: ref.slice(0, lastColon), version: ref.slice(lastColon + 1) };
  }
  return { name: ref, version: 'latest' };
}

/**
 * Gepinnte Images aus den Compose-Dateien im Repo.
 *
 * Bewusst per Zeilenmuster statt YAML-Parser: die Dateien enthalten
 * `${VAR}`-Interpolationen, die ein Parser aufloesen wollte, und wir brauchen
 * hier nur eine einzige Zeilenart. Eine Abhaengigkeit weniger.
 */
export async function collectPinnedVersions(): Promise<Map<string, { scope: Scope; version: string }>> {
  const pins = new Map<string, { scope: Scope; version: string }>();
  for (const { file, scope } of COMPOSE_SOURCES) {
    const path = `${ROOT}/${file}`;
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*image:\s*["']?([^\s"'#]+)["']?/);
      if (!m) continue;
      const { name, version } = splitImageRef(m[1]);
      pins.set(name, { scope, version });
    }
  }
  return pins;
}

interface RunningContainer {
  name: string;
  image: string;
}

/**
 * Was tatsaechlich laeuft. Geht ueber DOCKER_HOST, also den Socket-Proxy —
 * CONTAINERS=1 ist dort freigegeben (provisioning-agent/docker-compose.yml).
 */
export async function collectRunningContainers(): Promise<RunningContainer[]> {
  const { stdout } = await execFileP(
    'docker',
    ['ps', '--format', '{{.Names}}\t{{.Image}}'],
    { timeout: 30_000, maxBuffer: 1024 * 1024 * 4 }
  );
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, image] = line.split('\t');
      return { name, image };
    })
    .filter((c) => c.name && c.image);
}

/**
 * Ordnet einen laufenden Container einem Scope zu.
 *
 * Kundenprojekte laufen als `app-<slug>` mit dem Image `app-<slug>:<sha>`
 * (lib/deploy.ts). Tenant-Dienste heissen `tenant-auth-<slug>` bzw.
 * `tenant-postgrest-<slug>`. Alles andere ist Plattform.
 */
export function classifyContainer(name: string, image: string): { scope: Scope; slug: string | null } {
  if (/^app-/.test(name) || /^app-/.test(image)) {
    return { scope: 'project', slug: name.replace(/^app-/, '').replace(/-[0-9a-f]{8}$/, '') };
  }
  const tenant = name.match(/^tenant-(?:auth|postgrest)-(.+)$/);
  if (tenant) return { scope: 'tenant', slug: tenant[1] };
  return { scope: 'platform', slug: null };
}

/**
 * Vollstaendiges Inventar erheben und in `components` fortschreiben.
 *
 * Bestehende Zeilen werden nicht geloescht, nur `last_seen` fortgeschrieben:
 * eine Version, die gestern lief und heute nicht mehr, bleibt sichtbar — sonst
 * verschwindet mit dem Update auch die Spur, dass es je anders war.
 */
export async function collectInventory(): Promise<Component[]> {
  const [pins, containers] = await Promise.all([
    collectPinnedVersions(),
    collectRunningContainers().catch((err) => {
      console.error('Container-Liste nicht abrufbar:', err.message);
      return [] as RunningContainer[];
    }),
  ]);

  const db = adminClient();
  await db.connect();
  try {
    // slug -> project_id, fuer die Zuordnung der Kundencontainer.
    const { rows: projectRows } = await db.query<{ id: string; slug: string }>(
      'SELECT id, slug FROM projects'
    );
    const projectIdBySlug = new Map(projectRows.map((r) => [r.slug, r.id]));

    const components: Component[] = [];
    for (const c of containers) {
      const { name, version } = splitImageRef(c.image);
      const { scope, slug } = classifyContainer(c.name, c.image);
      const pin = pins.get(name);
      components.push({
        scope,
        projectId: slug ? projectIdBySlug.get(slug) ?? null : null,
        target: c.name,
        kind: 'image',
        name,
        version,
        // Kundenprojekte haben keinen Pin im Repo — ihr Image entsteht beim
        // Build. `null` heisst hier "kein Sollwert", nicht "Abweichung".
        pinnedVersion: pin ? pin.version : null,
      });
    }

    // Gepinnte Images, zu denen gerade KEIN Container laeuft. Auch das ist
    // eine Aussage: der Dienst ist konfiguriert, aber nicht oben.
    const laufendeNamen = new Set(components.map((c) => c.name));
    for (const [name, pin] of pins) {
      if (laufendeNamen.has(name)) continue;
      components.push({
        scope: pin.scope,
        projectId: null,
        target: '(nicht laufend)',
        kind: 'image',
        name,
        version: pin.version,
        pinnedVersion: pin.version,
      });
    }

    await upsertComponents(db, components);
    return components;
  } finally {
    await db.end();
  }
}

async function upsertComponents(db: PGClient, components: Component[]): Promise<void> {
  for (const c of components) {
    await db
      .query(
        `INSERT INTO components (scope, project_id, target, kind, name, version, pinned_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (scope, target, kind, name, version)
         DO UPDATE SET last_seen = now(), pinned_version = EXCLUDED.pinned_version,
                       project_id = EXCLUDED.project_id`,
        [c.scope, c.projectId, c.target, c.kind, c.name, c.version, c.pinnedVersion ?? null]
      )
      .catch((err) => console.error(`components-Zeile fuer ${c.name} fehlgeschlagen:`, err.message));
  }
}

/** Laeuft etwas anderes, als im Repo gepinnt ist? */
export function hasDrift(c: Component): boolean {
  return !!c.pinnedVersion && c.pinnedVersion !== c.version;
}
