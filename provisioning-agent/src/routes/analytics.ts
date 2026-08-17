import { Router } from 'express';
import { Client as PGClient } from 'pg';
import { ingestAccessLog } from '../lib/analytics';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

function adminClient(): PGClient {
  const client = new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
  client.on('error', (err) => console.error('pg client error (analytics route):', err.message));
  return client;
}

export const analyticsRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /analytics/:projectId?days=30[&host=kunde.at]
//
// Alles, was die Analytics-Seite braucht, in einem Request: Summen, Tagesreihe,
// Top-Seiten, Top-Herkunft und die Liste der Domains des Projekts. Vier
// getrennte Endpunkte waeren vier Roundtrips fuer eine Seite, die ohnehin immer
// komplett geladen wird.
analyticsRouter.get('/analytics/:projectId', async (req, res) => {
  const { projectId } = req.params;
  if (!UUID_RE.test(projectId)) return res.status(400).json({ error: 'invalid project id' });

  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const host = typeof req.query.host === 'string' && req.query.host ? req.query.host.toLowerCase() : null;

  const db = adminClient();
  await db.connect();
  try {
    const { rows: projectRows } = await db.query('SELECT id, slug FROM projects WHERE id = $1', [projectId]);
    if (projectRows.length === 0) return res.status(404).json({ error: 'project not found' });

    // $3 = optionaler Host-Filter. NULL bedeutet "alle Domains des Projekts" —
    // so bleibt es eine Query statt zweier Varianten.
    const params = [projectId, days, host];
    const hostFilter = 'AND ($3::text IS NULL OR hostname = $3)';

    const { rows: totals } = await db.query(
      `SELECT COALESCE(SUM(views), 0)::bigint AS views,
              COALESCE(SUM(unique_visitors), 0)::bigint AS unique_visitors
       FROM analytics_daily
       WHERE project_id = $1 AND day > (CURRENT_DATE - $2::int) ${hostFilter}`,
      params
    );

    // generate_series statt nur der vorhandenen Zeilen: ein Tag ohne Besucher
    // muss als 0 in der Kurve auftauchen, sonst sieht eine Woche Stillstand aus
    // wie durchgehender Traffic.
    const { rows: series } = await db.query(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              COALESCE(SUM(a.views), 0)::bigint AS views,
              COALESCE(SUM(a.unique_visitors), 0)::bigint AS unique_visitors
       FROM generate_series(CURRENT_DATE - ($2::int - 1), CURRENT_DATE, '1 day') AS d(day)
       LEFT JOIN analytics_daily a
         ON a.day = d.day AND a.project_id = $1 AND ($3::text IS NULL OR a.hostname = $3)
       GROUP BY d.day ORDER BY d.day ASC`,
      params
    );

    const { rows: topPaths } = await db.query(
      `SELECT path, SUM(views)::bigint AS views
       FROM analytics_page_views
       WHERE project_id = $1 AND day > (CURRENT_DATE - $2::int) ${hostFilter}
       GROUP BY path ORDER BY views DESC LIMIT 20`,
      params
    );

    const { rows: topReferrers } = await db.query(
      `SELECT referrer, SUM(views)::bigint AS views
       FROM analytics_referrers
       WHERE project_id = $1 AND day > (CURRENT_DATE - $2::int) ${hostFilter}
       GROUP BY referrer ORDER BY views DESC LIMIT 20`,
      params
    );

    const { rows: hosts } = await db.query(
      `SELECT hostname, SUM(views)::bigint AS views, SUM(unique_visitors)::bigint AS unique_visitors
       FROM analytics_daily
       WHERE project_id = $1 AND day > (CURRENT_DATE - $2::int)
       GROUP BY hostname ORDER BY views DESC`,
      [projectId, days]
    );

    // Ohne diesen Hinweis wirkt eine leere Auswertung wie ein Defekt. Sie hat
    // fast immer eine von zwei Ursachen: Traefik schreibt (noch) keinen
    // Accesslog, oder es gab schlicht keine Besucher.
    const { rows: ingest } = await db.query(
      `SELECT last_run_at, last_error, lines_ingested FROM analytics_ingest_state WHERE id = 'traefik-access-log'`
    );

    res.json({
      days,
      host,
      totals: {
        views: Number(totals[0]?.views || 0),
        uniqueVisitors: Number(totals[0]?.unique_visitors || 0),
      },
      series: series.map((r) => ({
        day: r.day,
        views: Number(r.views),
        uniqueVisitors: Number(r.unique_visitors),
      })),
      topPaths: topPaths.map((r) => ({ path: r.path, views: Number(r.views) })),
      topReferrers: topReferrers.map((r) => ({ referrer: r.referrer, views: Number(r.views) })),
      hosts: hosts.map((r) => ({
        hostname: r.hostname,
        views: Number(r.views),
        uniqueVisitors: Number(r.unique_visitors),
      })),
      ingest: ingest[0]
        ? {
            lastRunAt: ingest[0].last_run_at,
            lastError: ingest[0].last_error,
            linesIngested: Number(ingest[0].lines_ingested || 0),
          }
        : null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// POST /analytics/ingest — Ingest-Lauf sofort ausloesen, statt bis zu einer
// Minute auf den naechsten Intervall-Lauf zu warten. Gedacht fuer "warum steht
// da nichts?"-Momente direkt nach der Einrichtung.
analyticsRouter.post('/analytics/ingest', async (_req, res) => {
  try {
    const result = await ingestAccessLog();
    res.json({ status: 'ok', ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
