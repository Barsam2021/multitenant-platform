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
import { readFile, mkdtemp, rm, readlink, lstat } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
  // Per Digest referenzierte Images (`foo@sha256:abc…`) zuerst: der Doppelpunkt
  // im Digest ist kein Tag-Trenner. Ohne diesen Zweig hiesse die Komponente
  // "foo@sha256" und die Version waere der blanke Hash.
  const at = ref.indexOf('@');
  if (at > 0) {
    return { name: ref.slice(0, at), version: ref.slice(at + 1) };
  }
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
 * Die Namen sind nicht frei gewaehlt, sondern kommen aus zwei Stellen:
 *   - Kundenprojekte: `app-<slug>` (live) bzw. `app-<slug>-<sha8>` waehrend
 *     eines laufenden Deploys, Image `app-<slug>:<sha12>` (lib/deploy.ts).
 *   - Tenant-Dienste: `api-<slug>` (PostgREST) und `auth-<slug>` (GoTrue),
 *     siehe templates/tenant-compose.yml — dort stehen `container_name:
 *     api-${SLUG}` und `auth-${SLUG}`. NICHT `tenant-*`, wie hier urspruenglich
 *     angenommen: mit dem alten Muster landete jeder Tenant-Dienst unter
 *     "Plattform" und die Ebene B der Uebersicht blieb dauerhaft leer.
 * Alles andere ist Plattform.
 *
 * `knownSlugs` sind die bekannten Projekt-Slugs. Ohne sie muesste der
 * `-<sha8>`-Suffix blind abgeschnitten werden — ein Slug, der selbst auf acht
 * Hexzeichen endet (`app-deadbeef`), verloere dabei sein letztes Segment.
 */
export function classifyContainer(
  name: string,
  image: string,
  knownSlugs?: Set<string>
): { scope: Scope; slug: string | null } {
  const app = name.match(/^app-(.+)$/);
  if (app) {
    const raw = app[1];
    const slug = knownSlugs?.has(raw) ? raw : raw.replace(/-[0-9a-f]{8}$/, '');
    return { scope: 'project', slug };
  }
  const tenant = name.match(/^(?:api|auth)-(.+)$/);
  if (tenant) return { scope: 'tenant', slug: tenant[1] };
  return { scope: 'platform', slug: null };
}

/* ------------------------------------------------------------------ Ebene C
 *
 * Was IN einem Kundenprojekt steckt (docs/CVE-PLAN.md, Ebene C).
 *
 * Das Image eines Projekts traegt als Version den Commit-SHA — der sagt, WAS
 * gebaut wurde, aber nichts darueber, WOMIT. Genau diese Nummern werden hier
 * nachgetragen: Basis-Distribution, Node-Laufzeit und die direkten npm-
 * Abhaengigkeiten in der Version, die tatsaechlich installiert ist.
 *
 * Alles ueber `docker cp` und `docker inspect`, bewusst NICHT ueber
 * `docker exec`: der Socket-Proxy hat EXEC=0 (P0-1 im docker-compose.yml des
 * Agents). Das Inventar ist kein Grund, diese Grenze aufzumachen.
 */

/** Eine Datei aus einem laufenden Container lesen. `null`, wenn es sie nicht gibt. */
async function readFromContainer(container: string, path: string, dir: string): Promise<string | null> {
  const dest = join(dir, path.replace(/[^a-zA-Z0-9]/g, '_'));
  try {
    await execFileP('docker', ['cp', `${container}:${path}`, dest], { timeout: 30_000 });
    return await readFile(dest, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Exakte Node-Version eines Nixpacks-Images.
 *
 * Nixpacks legt `node` als Symlink in den Nix-Store, und der Store-Pfad
 * enthaelt die volle Version: `/nix/store/<hash>-nodejs-20.18.1/bin/node`.
 * `docker cp` kopiert den Symlink als Symlink — es werden also 4 KB uebertragen,
 * nicht die 100 MB der Binary. Die `nixpacks.toml` kennt nur die Major-Version
 * ("nodejs_20"), und genau die Patch-Nummer ist die, die bei einem CVE zaehlt.
 */
async function nodeVersionOf(container: string, dir: string): Promise<string | null> {
  const dest = join(dir, 'node-link');
  try {
    await execFileP('docker', ['cp', `${container}:/nix/var/nix/profiles/default/bin/node`, dest], {
      timeout: 30_000,
    });
    // Kein Symlink? Dann ist es kein Nixpacks-Layout — nichts ableiten.
    if (!(await lstat(dest)).isSymbolicLink()) return null;
    const target = await readlink(dest);
    return target.match(/-nodejs-([0-9][^/]*)\//)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Basis-Distribution aus den OCI-Labels des Images (z. B. ubuntu 24.04). */
async function baseImageOf(container: string): Promise<{ name: string; version: string } | null> {
  try {
    const { stdout } = await execFileP(
      'docker',
      [
        'inspect', container, '--format',
        '{{index .Config.Labels "org.opencontainers.image.ref.name"}}\t{{index .Config.Labels "org.opencontainers.image.version"}}',
      ],
      { timeout: 30_000 }
    );
    const [name, version] = stdout.trim().split('\t');
    // Fehlt ein Label, druckt Go "<no value>" — das ist keine Version.
    if (!name || !version || name === '<no value>' || version === '<no value>') return null;
    return { name, version };
  } catch {
    return null;
  }
}

/**
 * Direkte npm-Abhaengigkeiten in der installierten Version.
 *
 * Bewusst nur die direkten aus `package.json`, aufgeloest ueber die
 * `package-lock.json` — nicht der komplette Abhaengigkeitsbaum (hier: 13 statt
 * 525 Eintraege). Der vollstaendige Baum ist Aufgabe des Image-Scans in Phase 2
 * (docs/CVE-PLAN.md, Ebene C): Trivy zaehlt ihn ohnehin selbst auf, und ihn
 * vorher per Lockfile-Parser nachzubauen waere dieselbe Arbeit zweimal.
 * `devDependencies` bleiben draussen — sie laufen im Betrieb nicht.
 */
function directNpmDeps(pkgJson: string, lockJson: string | null): { name: string; version: string }[] {
  let pkg: any, lock: any = null;
  try {
    pkg = JSON.parse(pkgJson);
    if (lockJson) lock = JSON.parse(lockJson);
  } catch {
    return [];
  }
  const deps: { name: string; version: string }[] = [];
  for (const name of Object.keys(pkg?.dependencies ?? {})) {
    // Aufgeloeste Version aus dem Lockfile (v2/v3: packages["node_modules/<name>"]).
    // Ohne Lockfile bleibt nur der Bereich aus package.json ("^15.1.0") — der ist
    // keine Version, und "ungefaehr 15.1" hilft bei einem CVE niemandem.
    const resolved = lock?.packages?.[`node_modules/${name}`]?.version;
    if (typeof resolved === 'string') deps.push({ name, version: resolved });
  }
  return deps;
}

/**
 * Alle Nummern eines Kundenprojekts einsammeln. `target` ist der Container,
 * damit die Zeilen im Dashboard beim Projekt stehen und die UNIQUE-Bedingung
 * (scope, target, kind, name, version) zwei Projekte nicht vermischt.
 */
export async function collectProjectComponents(
  container: string,
  projectId: string | null
): Promise<Component[]> {
  const dir = await mkdtemp(join(tmpdir(), 'inv-'));
  try {
    const rows: Component[] = [];
    const add = (kind: Component['kind'], name: string, version: string) =>
      rows.push({ scope: 'project', projectId, target: container, kind, name, version, pinnedVersion: null });

    const base = await baseImageOf(container);
    if (base) add('other', base.name, base.version);

    const node = await nodeVersionOf(container, dir);
    if (node) add('other', 'node', node);

    // Nixpacks setzt WORKDIR auf /app. Bringt ein Repo ein eigenes Dockerfile
    // mit, kann der Pfad ein anderer sein — dann gibt es hier eben keine
    // npm-Zeilen statt einer falschen Annahme.
    const pkgJson = await readFromContainer(container, '/app/package.json', dir);
    if (pkgJson) {
      const lockJson = await readFromContainer(container, '/app/package-lock.json', dir);
      if (!lockJson) {
        console.warn(`${container}: package.json ohne package-lock.json — keine npm-Versionen erfassbar`);
      }
      for (const d of directNpmDeps(pkgJson, lockJson)) add('npm', d.name, d.version);
    }
    return rows;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
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
  try {
    await db.connect();
    // slug -> project_id, fuer die Zuordnung der Kundencontainer.
    const { rows: projectRows } = await db.query<{ id: string; slug: string }>(
      'SELECT id, slug FROM projects'
    );
    const projectIdBySlug = new Map(projectRows.map((r) => [r.slug, r.id]));
    const knownSlugs = new Set(projectIdBySlug.keys());

    const components: Component[] = [];
    for (const c of containers) {
      const { name, version } = splitImageRef(c.image);
      const { scope, slug } = classifyContainer(c.name, c.image, knownSlugs);
      const pin = pins.get(name);
      components.push({
        scope,
        // Nur Projekt-Container bekommen eine project_id. Der Slug eines
        // Tenant-Containers (`api-<slug>`) ist ein KUNDEN-Slug — dass es
        // daneben ein Projekt gleichen Namens gibt, ist Zufall und keine
        // Zugehoerigkeit. Sonst haengt an "postgrest/postgrest" ploetzlich
        // ein Projektname, der nichts damit zu tun hat.
        projectId: scope === 'project' && slug ? projectIdBySlug.get(slug) ?? null : null,
        target: c.name,
        kind: 'image',
        name,
        version,
        // Kundenprojekte haben keinen Pin im Repo — ihr Image entsteht beim
        // Build. `null` heisst hier "kein Sollwert", nicht "Abweichung".
        pinnedVersion: pin ? pin.version : null,
      });
    }

    // Ebene C: was in den Kundenprojekten steckt. Nacheinander, nicht parallel
    // — pro Projekt sind es vier Docker-Aufrufe, und das Inventar laeuft im
    // Hintergrund. Faellt eines aus, fehlen dessen Zeilen, nicht das Inventar.
    for (const c of [...components]) {
      if (c.scope !== 'project') continue;
      const rows = await collectProjectComponents(c.target, c.projectId).catch((err) => {
        console.error(`Projekt-Inventar fuer ${c.target} fehlgeschlagen:`, err.message);
        return [] as Component[];
      });
      components.push(...rows);
    }

    // Gepinnte Images, zu denen gerade KEIN Container laeuft. Auch das ist
    // eine Aussage: der Dienst ist konfiguriert, aber nicht oben.
    //
    // Nur Image-Zeilen vergleichen: npm kennt Paketnamen wie `postgres`, und
    // ein Projekt, das so eines benutzt, wuerde sonst den Pin des echten
    // Postgres-Images verdecken.
    const laufendeNamen = new Set(components.filter((c) => c.kind === 'image').map((c) => c.name));
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
    await db.end().catch(() => {});
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

// Ein einziger Lauf zur Zeit — prozessweit. Der Timer in index.ts und der
// Knopf im Dashboard hatten je ein eigenes Flag; zwei Flags verhindern nichts,
// wenn beide denselben Lauf ausloesen koennen. Der teure Teil ist die
// Container-Abfrage, und zwei gleichzeitige Laeufe schreiben dieselben Zeilen.
let laufend = false;

/**
 * Inventarlauf, sofern nicht schon einer laeuft. `null` heisst "laeuft
 * bereits" — der Aufrufer entscheidet, ob das ein 409 oder ein stilles
 * Ueberspringen ist.
 */
export async function runInventoryOnce(): Promise<Component[] | null> {
  if (laufend) return null;
  laufend = true;
  try {
    return await collectInventory();
  } finally {
    laufend = false;
  }
}

/** Laeuft etwas anderes, als im Repo gepinnt ist? */
export function hasDrift(c: Component): boolean {
  return !!c.pinnedVersion && c.pinnedVersion !== c.version;
}
