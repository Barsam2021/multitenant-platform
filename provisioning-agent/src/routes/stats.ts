import { Router } from 'express';
import { Client as PGClient } from 'pg';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import { getDiskUsage } from '../lib/cleanup';
import { logAudit } from '../lib/audit';
import { BUILDS_ROOT } from '../lib/git';

const execFileP = promisify(execFile);
const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN || 'example.com';

function adminClient(): PGClient {
  // P1-4 (Audit 0430f9c): ein pg.Client emittiert bei Verbindungsverlust ein
  // 'error'-Event. OHNE Listener ist das in Node eine uncaught exception, also
  // Prozessende — im schlimmsten Fall mitten im Deploy zwischen `docker rename`
  // und `docker run`: Kundenseite offline, und nichts raeumt auf. deploy.ts
  // haelt einen solchen Client ueber die gesamte Deploy-Dauer offen (Build-
  // Timeout allein 10 Minuten).
  const client = new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
  client.on('error', (err) => console.error('pg client error (adminClient):', err.message));
  return client;
}

interface DockerStatsLine {
  Name: string;
  CPUPerc: string;
  MemUsage: string;
  MemPerc: string;
}

async function readDockerStats(): Promise<Record<string, DockerStatsLine>> {
  const out: Record<string, DockerStatsLine> = {};
  try {
    const { stdout } = await execFileP('docker', ['stats', '--no-stream', '--format', '{{json .}}']);
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const c = JSON.parse(line) as DockerStatsLine;
      out[c.Name] = c;
    }
  } catch (e: any) {
    console.error('docker stats fehlgeschlagen:', e.message);
  }
  return out;
}

/**
 * "1.234GiB" / "512MB" / "0B" -> Bytes.
 *
 * docker stats mischt binaere (MiB) und dezimale (MB) Einheiten, je nach Feld
 * und Docker-Version. Beide Faelle hier zu behandeln ist billiger, als sich auf
 * eine zu verlassen und bei der naechsten Version um Faktor 1,05 danebenzuliegen.
 */
function parseSize(text: string): number | null {
  const m = /^([\d.]+)\s*([KMGTP]?)(i?)B$/i.exec(text.trim());
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const base = m[3] ? 1024 : 1000;
  const exp = { '': 0, K: 1, M: 2, G: 3, T: 4, P: 5 }[m[2].toUpperCase() as '' | 'K' | 'M' | 'G' | 'T' | 'P'] ?? 0;
  return Math.round(value * Math.pow(base, exp));
}

/** "45.6MiB / 512MiB" -> { usedBytes, limitBytes } */
function parseMemUsage(text: string | undefined): { usedBytes: number | null; limitBytes: number | null } {
  if (!text) return { usedBytes: null, limitBytes: null };
  const [used, limit] = text.split('/');
  return { usedBytes: used ? parseSize(used) : null, limitBytes: limit ? parseSize(limit) : null };
}

function parsePercent(text: string | undefined): number | null {
  if (!text) return null;
  const value = Number(text.replace('%', '').trim());
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

/**
 * Arbeitsspeicher des HOSTS aus /proc/meminfo.
 *
 * Bewusst nicht `docker info`: der Agent spricht ueber den Socket-Proxy mit
 * Docker, und der laesst nur die Endpunkte durch, die er kennt. /proc/meminfo
 * zeigt im Container die Werte des Hosts — das mem_limit des Agents aendert
 * daran nichts, das steht in der cgroup, nicht hier.
 *
 * MemAvailable statt MemFree: MemFree zaehlt Cache als belegt und meldet auf
 * jedem eingelaufenen Server "fast voll", was niemandem hilft.
 */
async function readHostMemory(): Promise<{ totalBytes: number; availableBytes: number; usedBytes: number } | null> {
  try {
    const text = await readFile('/proc/meminfo', 'utf8');
    const total = /MemTotal:\s+(\d+) kB/.exec(text);
    const available = /MemAvailable:\s+(\d+) kB/.exec(text);
    if (!total || !available) return null;
    const totalBytes = Number(total[1]) * 1024;
    const availableBytes = Number(available[1]) * 1024;
    return { totalBytes, availableBytes, usedBytes: totalBytes - availableBytes };
  } catch (e: any) {
    console.error('/proc/meminfo nicht lesbar:', e.message);
    return null;
  }
}

export const statsRouter = Router();

// GET /stats/disk — P3-6: Plattenbelegung fuer die Uebersichtsseite. Getrennt
// von /stats/overview, damit ein df-Aufruf nicht jeden Overview-Request
// mitbremst - die Uebersichtsseite ruft beide parallel ab.
statsRouter.get('/stats/disk', async (_req, res) => {
  const disk = await getDiskUsage();
  if (!disk) return res.status(500).json({ error: 'df fehlgeschlagen' });
  res.json(disk);
});

/**
 * GET /stats/storage — wer belegt wie viel Platte?
 *
 * Drei Quellen, weil ein Kunde auf drei Arten Platz belegt und "belegt 4 GB"
 * ohne die Aufteilung keine Entscheidung erlaubt:
 *   - seine Datenbank        (pg_database_size)
 *   - sein Object Storage    (MinIO-Bucket, hochgeladene Bilder/PDFs)
 *   - seine Build-Snapshots  (deployments/builds/<slug>, wachsen mit jedem Deploy)
 *
 * Eigener Endpunkt und nicht Teil von /stats/overview: `du` ueber die
 * Build-Verzeichnisse und `mc du` ueber die Buckets dauern spuerbar laenger als
 * alles andere zusammen, und die Uebersicht pollt alle 30 Sekunden.
 * Durchgaengig fehlertolerant — eine Quelle, die nicht antwortet, macht die
 * anderen nicht wertlos.
 */
statsRouter.get('/stats/storage', async (_req, res) => {
  const db = adminClient();
  await db.connect();
  try {
    const [{ rows: tenants }, { rows: projects }] = await Promise.all([
      db.query('SELECT slug, db_name, db_provisioned FROM kunden ORDER BY slug'),
      db.query('SELECT slug, tenant_slug FROM projects'),
    ]);

    // Datenbankgroessen in einer Abfrage, statt pro Kunde eine.
    const dbSizes = new Map<string, number>();
    try {
      const { rows } = await db.query(
        `SELECT datname, pg_database_size(datname) AS bytes
         FROM pg_database WHERE datname LIKE 'kunde\\_%'`
      );
      for (const row of rows) dbSizes.set(String(row.datname), Number(row.bytes));
    } catch (e: any) {
      console.error('pg_database_size fehlgeschlagen:', e.message);
    }

    const bucketSizes = await readBucketSizes(tenants.map((t) => `kunde-${t.slug}-storage`));

    const buildSizes = new Map<string, number>();
    await Promise.all(
      projects.map(async (project) => {
        const bytes = await directorySize(`${BUILDS_ROOT}/${project.slug}`);
        if (bytes !== null) buildSizes.set(project.slug, bytes);
      })
    );

    const projectsByTenant = new Map<string, string[]>();
    for (const project of projects) {
      const list = projectsByTenant.get(project.tenant_slug) || [];
      list.push(project.slug);
      projectsByTenant.set(project.tenant_slug, list);
    }

    const rows = tenants.map((tenant) => {
      const projectSlugs = projectsByTenant.get(tenant.slug) || [];
      const buildBytes = projectSlugs.reduce((sum, slug) => sum + (buildSizes.get(slug) ?? 0), 0);
      const databaseBytes = tenant.db_provisioned ? dbSizes.get(tenant.db_name) ?? null : null;
      const storageBytes = bucketSizes.get(`kunde-${tenant.slug}-storage`) ?? null;
      return {
        slug: tenant.slug,
        projects: projectSlugs,
        databaseBytes,
        storageBytes,
        buildBytes,
        totalBytes: (databaseBytes ?? 0) + (storageBytes ?? 0) + buildBytes,
      };
    });
    rows.sort((a, b) => b.totalBytes - a.totalBytes);

    res.json({
      disk: await getDiskUsage(),
      tenants: rows,
      totals: {
        databaseBytes: rows.reduce((sum, r) => sum + (r.databaseBytes ?? 0), 0),
        storageBytes: rows.reduce((sum, r) => sum + (r.storageBytes ?? 0), 0),
        buildBytes: rows.reduce((sum, r) => sum + r.buildBytes, 0),
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// DELETE /containers/orphan/:name — einen verwaisten App-Container entfernen.
//
// Bewusst eng: nur Namen, die mit app- beginnen, und nur solche, die KEIN
// Projekt mehr kennt. Die Pruefung passiert hier und nicht im Dashboard --
// die Liste dort ist ein Vorschlag, die Entscheidung darf nicht davon
// abhaengen, dass der Aufrufer sie richtig ausgewertet hat.
statsRouter.delete('/containers/orphan/:name', async (req, res) => {
  const { name } = req.params;
  if (!/^app-[a-z0-9][a-z0-9-]*$/.test(name)) return res.status(400).json({ error: 'invalid container name' });

  const db = adminClient();
  await db.connect();
  try {
    const { rows: projects } = await db.query('SELECT slug, active_container FROM projects');
    const belongsToProject = projects.some(
      (p) => p.active_container === name || name === `app-${p.slug}` || name.startsWith(`app-${p.slug}-`)
    );
    if (belongsToProject) {
      return res.status(409).json({ error: `"${name}" gehoert zu einem Projekt und wird nicht entfernt.` });
    }

    await execFileP('docker', ['rm', '-f', name]);
    await logAudit('container.orphan.removed', null, { container: name });
    res.json({ status: 'ok', removed: name });
  } catch (err: any) {
    res.status(500).json({ error: err.stderr || err.message });
  } finally {
    await db.end();
  }
});

/** Groesse eines Verzeichnisses in Bytes; null, wenn es nicht existiert. */
async function directorySize(path: string): Promise<number | null> {
  try {
    const { stdout } = await execFileP('du', ['-sb', path]);
    const bytes = Number(stdout.split(/\s+/)[0]);
    return Number.isFinite(bytes) ? bytes : null;
  } catch {
    // Kein Verzeichnis = noch nie gebaut. Kein Fehler, nur nichts zu melden.
    return null;
  }
}

/**
 * Belegung je MinIO-Bucket, Bucket-Name -> Bytes.
 *
 * Je Bucket ein Aufruf, obwohl das nach einem unnoetigen Fan-out aussieht:
 * `mc du localminio` fasst ueber alle Buckets zusammen und liefert genau EINE
 * Zeile mit leerem prefix, --depth 1 aendert daran nichts. Die Aufteilung ist
 * aber der ganze Zweck der Anzeige.
 */
async function readBucketSizes(buckets: string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  const user = process.env.MINIO_ROOT_USER;
  const password = process.env.MINIO_ROOT_PASSWORD;
  if (!user || !password || buckets.length === 0) return sizes;
  try {
    await execFileP('mc', ['alias', 'set', 'localminio', 'http://core-minio:9000', user, password]);
  } catch (e: any) {
    console.error('mc alias set fehlgeschlagen:', e.message);
    return sizes;
  }

  await Promise.all(
    buckets.map(async (bucket) => {
      try {
        const { stdout } = await execFileP('mc', ['du', '--json', `localminio/${bucket}`]);
        const line = stdout.trim().split('\n').filter(Boolean)[0];
        if (!line) return;
        const entry = JSON.parse(line) as { size?: number };
        if (typeof entry.size === 'number') sizes.set(bucket, entry.size);
      } catch {
        // Bucket existiert nicht (Kunde ohne Storage) oder mc antwortet nicht —
        // beides ist "keine Angabe", kein Grund die anderen zu verlieren.
      }
    })
  );
  return sizes;
}

// GET /stats — rohe docker-stats + DB-Connections. Unveraendertes Verhalten,
// nur aus index.ts hierher verschoben (siehe /stats/overview fuer die
// aggregierte, tatsaechlich im Dashboard nutzbare Variante, P1-8).
statsRouter.get('/stats', async (_req, res) => {
  try {
    const { stdout } = await execFileP('docker', ['stats', '--no-stream', '--format', '{{json .}}']);
    const containers = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

    const master = new PGClient({
      connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/postgres`,
    });
    await master.connect();
    const { rows: dbConnections } = await master.query(
      "SELECT datname, count(*) AS connections FROM pg_stat_activity WHERE datname LIKE 'kunde_%' GROUP BY datname"
    );
    await master.end();

    res.json({ containers, dbConnections });
  } catch (err: any) {
    console.error('Stats fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /stats/overview — P1-8: die eigentliche Plattform-Uebersicht, die es bisher
// nicht gab — /stats existierte zwar, wurde aber nie vom Dashboard abgerufen und
// liefert ohnehin nur rohe, nicht auf Projekte gemappte Container-Daten. kuma_monitor_id
// wurde bisher geschrieben, nie gelesen — hier fliesst sie als Deep-Link in Uptime
// Kuma (oeffentlich erreichbar, siehe monitoring/uptime-kuma/docker-compose.yml) ein,
// statt selbst fragil den Kuma-Socket fuer Live-Status abzufragen.
statsRouter.get('/stats/overview', async (_req, res) => {
  const db = adminClient();
  await db.connect();
  try {
    const containerStats = await readDockerStats();

    const { rows: projects } = await db.query(
      `SELECT p.id, p.slug, p.tenant_slug, p.active_container, p.kuma_monitor_id, k.tariff
       FROM projects p JOIN kunden k ON k.slug = p.tenant_slug
       ORDER BY p.created_at DESC`
    );

    const { rows: lastDeployments } = await db.query(
      `SELECT DISTINCT ON (project_id) project_id, status, finished_at, created_at
       FROM deployments ORDER BY project_id, created_at DESC`
    );
    const lastDeployByProject = new Map(lastDeployments.map((d) => [d.project_id, d]));

    const { rows: domainCounts } = await db.query(
      `SELECT project_id, COALESCE(status, 'unknown') AS status, count(*) AS n FROM domains GROUP BY project_id, status`
    );
    const domainsByProject = new Map<string, Record<string, number>>();
    for (const row of domainCounts) {
      const m = domainsByProject.get(row.project_id) || {};
      m[row.status] = Number(row.n);
      domainsByProject.set(row.project_id, m);
    }

    // pg_stat_activity ist clusterweit sichtbar — kein zweiter Connect auf die
    // 'postgres'-DB noetig, anders als im alten /stats-Handler oben.
    const { rows: dbConnRows } = await db.query(
      "SELECT datname, count(*) AS connections FROM pg_stat_activity WHERE datname LIKE 'kunde_%' GROUP BY datname"
    );
    const dbConnByTenant = new Map(dbConnRows.map((r) => [String(r.datname).replace(/^kunde_/, ''), Number(r.connections)]));

    // Aufrufe der letzten 30 Tage je Projekt. analytics_daily ist bereits
    // aggregiert (siehe lib/analytics.ts), das ist eine Summe ueber wenige
    // Zeilen und kein Grund fuer einen eigenen Endpunkt.
    const { rows: viewRows } = await db.query(
      `SELECT project_id,
              COALESCE(SUM(views), 0)::bigint AS views,
              COALESCE(SUM(unique_visitors), 0)::bigint AS unique_visitors
       FROM analytics_daily
       WHERE day > (CURRENT_DATE - 30)
       GROUP BY project_id`
    );
    const viewsByProject = new Map(
      viewRows.map((r) => [r.project_id, { views: Number(r.views), uniqueVisitors: Number(r.unique_visitors) }])
    );

    const hostMemory = await readHostMemory();

    const kumaBaseUrl = `https://status-vps.${PLATFORM_DOMAIN}`;

    const projectStats = projects.map((p) => {
      const deploy = lastDeployByProject.get(p.id);
      const live = p.active_container ? containerStats[p.active_container] : undefined;
      const mem = parseMemUsage(live?.MemUsage);
      const traffic = viewsByProject.get(p.id);
      return {
        id: p.id,
        slug: p.slug,
        tenantSlug: p.tenant_slug,
        tariff: p.tariff,
        activeContainer: p.active_container,
        cpuPerc: live?.CPUPerc ?? null,
        memUsage: live?.MemUsage ?? null,
        memPerc: live?.MemPerc ?? null,
        // Absolute Werte zusaetzlich zu den Anzeige-Strings: "38 %" beantwortet
        // nicht die Frage, wie viel MB das sind und wie viel davon reserviert
        // ist und brachliegt. Genau das braucht die Uebersicht.
        cpuPercent: parsePercent(live?.CPUPerc),
        memUsedBytes: mem.usedBytes,
        memLimitBytes: mem.limitBytes,
        memFreeBytes: mem.usedBytes !== null && mem.limitBytes !== null ? mem.limitBytes - mem.usedBytes : null,
        views30d: traffic?.views ?? 0,
        uniqueVisitors30d: traffic?.uniqueVisitors ?? 0,
        lastDeployment: deploy
          ? { status: deploy.status, finishedAt: deploy.finished_at, createdAt: deploy.created_at }
          : null,
        domains: domainsByProject.get(p.id) || {},
        dbConnections: dbConnByTenant.get(p.tenant_slug) ?? 0,
        kumaMonitorId: p.kuma_monitor_id,
        kumaUrl: p.kuma_monitor_id ? `${kumaBaseUrl}/dashboard/${p.kuma_monitor_id}` : null,
      };
    });

    const { rows: tenantCountRows } = await db.query('SELECT count(*) AS n FROM kunden');

    // Ueber ALLE Container summieren, nicht nur ueber die Projekt-Container:
    // Postgres, Traefik, MinIO und die Tenant-Dienste belegen denselben RAM,
    // und die Frage "wie viel ist noch frei" ist sonst falsch beantwortet.
    //
    // Container OHNE mem_limit meldet Docker mit dem Host-Speicher als Limit.
    // Die Erkennung braucht eine Toleranz: /proc/meminfo rechnet dezimal
    // (8.3 GB), docker stats binaer (7.62GiB) — ein exakter Vergleich haelt
    // jeden unbegrenzten Container faelschlich fuer begrenzt und blaeht
    // "zugesagt" um ein Vielfaches des vorhandenen Speichers auf.
    const containerTenant = new Map<string, string>();
    for (const p of projects) {
      if (p.active_container) containerTenant.set(p.active_container, p.tenant_slug);
    }
    const tenantSlugs = new Set(projects.map((p) => p.tenant_slug));

    function groupOf(containerName: string): { key: string; label: string; kind: 'tenant' | 'platform' } {
      const direct = containerTenant.get(containerName);
      if (direct) return { key: direct, label: direct, kind: 'tenant' };
      // Tenant-Dienste heissen api-<slug> / auth-<slug> / app-<slug>...; der
      // Praefix-Vergleich gegen die bekannten Slugs ist eindeutiger als ein
      // Zerlegen am Bindestrich, weil Slugs selbst Bindestriche enthalten.
      for (const prefix of ['api-', 'auth-', 'app-']) {
        if (!containerName.startsWith(prefix)) continue;
        const rest = containerName.slice(prefix.length);
        for (const slug of tenantSlugs) {
          if (rest === slug || rest.startsWith(`${slug}-`)) {
            return { key: slug, label: slug, kind: 'tenant' };
          }
        }
      }
      return { key: containerName, label: containerName, kind: 'platform' };
    }

    const isUnlimited = (limitBytes: number | null) =>
      limitBytes === null || (hostMemory !== null && limitBytes >= hostMemory.totalBytes * 0.9);

    const consumerMap = new Map<string, { key: string; label: string; kind: 'tenant' | 'platform'; usedBytes: number; limitBytes: number | null; containers: number }>();
    let containerUsedBytes = 0;
    let committedBytes = 0;
    let unlimitedContainers = 0;

    for (const [name, stat] of Object.entries(containerStats)) {
      const mem = parseMemUsage(stat.MemUsage);
      containerUsedBytes += mem.usedBytes ?? 0;
      if (isUnlimited(mem.limitBytes)) unlimitedContainers += 1;
      else committedBytes += mem.limitBytes ?? 0;

      const group = groupOf(name);
      const entry = consumerMap.get(group.key) || { ...group, usedBytes: 0, limitBytes: 0, containers: 0 };
      entry.usedBytes += mem.usedBytes ?? 0;
      entry.limitBytes = isUnlimited(mem.limitBytes) ? entry.limitBytes : (entry.limitBytes ?? 0) + (mem.limitBytes ?? 0);
      entry.containers += 1;
      consumerMap.set(group.key, entry);
    }

    const memoryConsumers = [...consumerMap.values()].sort((a, b) => b.usedBytes - a.usedBytes);

    // Verwaiste App-Container: laufen noch, gehoeren aber zu keinem Projekt
    // mehr. Entstehen, wenn ein Projekt geloescht wird, waehrend sein Container
    // laeuft, oder wenn ein Deploy-Swap auf halber Strecke abbricht. Sie
    // belegen RAM und ihr Limit, ohne dass irgendwo etwas darauf zeigt — und
    // sichtbar sind sie bisher nur, wenn jemand von Hand `docker ps` tippt.
    const knownContainers = new Set<string>();
    for (const p of projects) {
      if (p.active_container) knownContainers.add(p.active_container);
      knownContainers.add(`app-${p.slug}`);
    }
    const orphanContainers = Object.entries(containerStats)
      .filter(([name]) => name.startsWith('app-') && !knownContainers.has(name))
      // Waehrend eines Deploys existiert kurzzeitig app-<slug>-<sha> neben dem
      // oeffentlichen Container. Das ist kein Waisenkind, sondern der Kandidat.
      .filter(([name]) => !projects.some((p) => name.startsWith(`app-${p.slug}-`)))
      .map(([name, stat]) => {
        const mem = parseMemUsage(stat.MemUsage);
        return { name, memUsedBytes: mem.usedBytes, memLimitBytes: mem.limitBytes };
      });
    const allContainers = Object.values(containerStats).map((c) => parseMemUsage(c.MemUsage));

    res.json({
      summary: {
        tenantCount: Number(tenantCountRows[0]?.n || 0),
        projectCount: projects.length,
        projectsRunning: projectStats.filter((p) => !!p.activeContainer).length,
        projectsFailedLastDeploy: projectStats.filter((p) => p.lastDeployment?.status === 'failed').length,
        views30d: projectStats.reduce((sum, p) => sum + p.views30d, 0),
        uniqueVisitors30d: projectStats.reduce((sum, p) => sum + p.uniqueVisitors30d, 0),
        memory: {
          hostTotalBytes: hostMemory?.totalBytes ?? null,
          hostUsedBytes: hostMemory?.usedBytes ?? null,
          hostAvailableBytes: hostMemory?.availableBytes ?? null,
          containerUsedBytes,
          committedBytes,
          containerCount: allContainers.length,
          unlimitedContainers,
          consumers: memoryConsumers,
        },
      },
      orphanContainers,
      projects: projectStats,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});
