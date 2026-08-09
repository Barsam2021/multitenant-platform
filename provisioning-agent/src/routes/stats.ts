import { Router } from 'express';
import { Client as PGClient } from 'pg';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);
const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN || 'example.com';

function adminClient(): PGClient {
  return new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
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

export const statsRouter = Router();

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

    const kumaBaseUrl = `https://status-vps.${PLATFORM_DOMAIN}`;

    const projectStats = projects.map((p) => {
      const deploy = lastDeployByProject.get(p.id);
      const live = p.active_container ? containerStats[p.active_container] : undefined;
      return {
        id: p.id,
        slug: p.slug,
        tenantSlug: p.tenant_slug,
        tariff: p.tariff,
        activeContainer: p.active_container,
        cpuPerc: live?.CPUPerc ?? null,
        memUsage: live?.MemUsage ?? null,
        memPerc: live?.MemPerc ?? null,
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

    res.json({
      summary: {
        tenantCount: Number(tenantCountRows[0]?.n || 0),
        projectCount: projects.length,
        projectsRunning: projectStats.filter((p) => !!p.activeContainer).length,
        projectsFailedLastDeploy: projectStats.filter((p) => p.lastDeployment?.status === 'failed').length,
      },
      projects: projectStats,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});
