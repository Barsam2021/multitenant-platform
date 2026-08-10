import { Router } from 'express';
import { existsSync } from 'fs';
import { Client as PGClient } from 'pg';
import {
  writeCustomDomainRouter,
  removeRouterFile,
  removeAllRoutersForProject,
} from '../lib/traefikDynamic';
import { checkDns, checkTls, buildInstructions, tryAutoDns, configuredProviders } from '../lib/dns';
import { logAudit } from '../lib/audit';

const DYNAMIC_DIR = '/opt/multitenant-platform/traefik/dynamic';
const ADMIN_DB_HOST = process.env.ADMIN_DB_HOST || process.env.PGBOUNCER_HOST || 'core-postgres';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

function adminClient(): PGClient {
  // P1-4 (Audit 0430f9c): ein pg.Client emittiert bei Verbindungsverlust ein
  // 'error'-Event. OHNE Listener ist das in Node eine uncaught exception, also
  // Prozessende — im schlimmsten Fall mitten im Deploy zwischen `docker rename`
  // und `docker run`: Kundenseite offline, und nichts raeumt auf. deploy.ts
  // haelt einen solchen Client ueber die gesamte Deploy-Dauer offen (Build-
  // Timeout allein 10 Minuten).
  const client = new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${ADMIN_DB_HOST}:5432/admin_dashboard`,
  });
  client.on('error', (err) => console.error('pg client error (adminClient):', err.message));
  return client;
}

export const domainsRouter = Router();

interface DomainRow {
  id: string;
  project_id: string;
  hostname: string;
  kind: string;
  status: string;
  router_file: string | null;
  project_slug: string;
  active_container: string | null;
  preview_hostname: string | null;
  app_port: number | null;
}

async function loadDomain(db: PGClient, domainId: string): Promise<DomainRow | null> {
  const { rows } = await db.query(
    `SELECT d.id, d.project_id, d.hostname, d.kind, d.status, d.router_file,
            p.slug AS project_slug, p.active_container, p.preview_hostname,
            COALESCE(p.app_port, 3000) AS app_port
     FROM domains d JOIN projects p ON p.id = d.project_id
     WHERE d.id = $1`,
    [domainId]
  );
  return rows[0] || null;
}

async function setDomainState(
  db: PGClient,
  domainId: string,
  fields: { status?: string; last_error?: string | null; verification_method?: string | null; router_file?: string }
) {
  const sets: string[] = ['last_check_at = now()'];
  const vals: any[] = [];
  let i = 1;
  if (fields.status !== undefined) { sets.push(`status = $${i++}`); vals.push(fields.status); }
  if (fields.last_error !== undefined) { sets.push(`last_error = $${i++}`); vals.push(fields.last_error); }
  if (fields.verification_method !== undefined) { sets.push(`verification_method = $${i++}`); vals.push(fields.verification_method); }
  if (fields.router_file !== undefined) { sets.push(`router_file = $${i++}`); vals.push(fields.router_file); }
  // dns_verified/tls_issued weiterhin pflegen — aeltere Teile der UI lesen sie noch.
  if (fields.status === 'live') sets.push('dns_verified = true', 'tls_issued = true');
  else if (fields.status === 'dns_ok' || fields.status === 'tls_pending') sets.push('dns_verified = true', 'tls_issued = false');
  vals.push(domainId);
  await db.query(`UPDATE domains SET ${sets.join(', ')} WHERE id = $${i}`, vals);
}

/**
 * Schreibt die Router-Dateien ALLER live-faehigen Domains eines Projekts neu.
 *
 * Noetig, weil sich die Dateien gegenseitig bedingen: wechselt die Primaerdomain,
 * muessen alle anderen von "Inhalt ausliefern" auf "301 weiterleiten" umgestellt
 * werden. Einzelne Dateien isoliert zu schreiben wuerde inkonsistente Zustaende
 * erzeugen (zwei Primaere, oder ein Redirect-Ring).
 */
export async function syncProjectRouters(db: PGClient, projectId: string): Promise<void> {
  const { rows: projRows } = await db.query(
    `SELECT slug, active_container, COALESCE(app_port, 3000) AS app_port
     FROM projects WHERE id = $1`, [projectId]
  );
  if (projRows.length === 0) return;
  const proj = projRows[0];
  const container = proj.active_container || `app-${proj.slug}`;

  const { rows: domains } = await db.query(
    `SELECT id, hostname, is_primary, status FROM domains
     WHERE project_id = $1 AND kind = 'custom' AND status IN ('tls_pending','live')`,
    [projectId]
  );
  if (domains.length === 0) return;

  const primary = domains.find((d: any) => d.is_primary) || null;

  for (const d of domains) {
    const redirectTo = primary && primary.id !== d.id ? primary.hostname : null;
    const file = await writeCustomDomainRouter(
      proj.slug, d.hostname, container, proj.app_port, redirectTo
    );
    await db.query('UPDATE domains SET router_file = $1 WHERE id = $2', [file, d.id]);
  }
}

/**
 * Ein vollstaendiger Verifikationsdurchlauf fuer eine Domain: DNS pruefen, bei
 * Erfolg Traefik-Router schreiben, danach TLS pruefen. Schreibt jeden Zwischenstand
 * inklusive Fehlergrund in die DB — dadurch kann die UI erklaeren, WARUM etwas haengt,
 * statt nur "ausstehend" anzuzeigen.
 */
export async function verifyDomain(domainId: string): Promise<{
  status: string; dns: any; tls: any; error: string | null;
}> {
  const db = adminClient();
  await db.connect();
  try {
    const d = await loadDomain(db, domainId);
    if (!d) throw new Error('domain not found');

    const dns = await checkDns(d.hostname);
    if (!dns.ok) {
      await setDomainState(db, domainId, { status: 'pending_dns', last_error: dns.error, verification_method: null });
      return { status: 'pending_dns', dns, tls: null, error: dns.error };
    }

    const containerName = d.active_container || `app-${d.project_slug}`;
    let routerFile = d.router_file;
    try {
      routerFile = await writeCustomDomainRouter(d.project_slug, d.hostname, containerName, d.app_port || 3000);
    } catch (err: any) {
      await setDomainState(db, domainId, { status: 'failed', last_error: `Traefik-Router: ${err.message}` });
      return { status: 'failed', dns, tls: null, error: err.message };
    }

    await setDomainState(db, domainId, {
      status: 'tls_pending', last_error: null, verification_method: dns.method, router_file: routerFile,
    });
    // Erste verifizierte Domain eines Projekts wird automatisch primaer.
    const { rows: primaryRows } = await db.query(
      `SELECT count(*)::int AS n FROM domains
       WHERE project_id = $1 AND kind = 'custom' AND is_primary = true`, [d.project_id]
    );
    if (primaryRows[0].n === 0) {
      await db.query('UPDATE domains SET is_primary = true WHERE id = $1', [domainId]);
    }
    await syncProjectRouters(db, d.project_id);

    const tls = await checkTls(d.hostname);
    if (tls.ok) {
      await setDomainState(db, domainId, { status: 'live', last_error: null });
      return { status: 'live', dns, tls, error: null };
    }

    const hint = 'Zertifikat noch nicht ausgestellt. Let\'s Encrypt braucht typisch 30-90 Sekunden. '
      + 'Bleibt es dabei: Port 80 muss von aussen erreichbar sein (HTTP-01-Challenge).';
    await setDomainState(db, domainId, { status: 'tls_pending', last_error: hint });
    return { status: 'tls_pending', dns, tls, error: hint };
  } finally {
    await db.end();
  }
}

/** Hintergrundschleife: DNS bis 30 min, danach TLS bis 5 min. */
async function pollDomain(domainId: string, hostname: string): Promise<void> {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const result = await verifyDomain(domainId);
      if (result.status === 'live') return;
      if (result.status === 'failed') return;
      if (result.status === 'tls_pending') {
        const tlsDeadline = Date.now() + 5 * 60 * 1000;
        while (Date.now() < tlsDeadline) {
          await new Promise((r) => setTimeout(r, 15_000));
          const again = await verifyDomain(domainId);
          if (again.status === 'live') return;
        }
        return;
      }
    } catch (err: any) {
      console.error(`Domain-Check ${hostname} fehlgeschlagen:`, err.message);
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }

  const db = adminClient();
  await db.connect();
  try {
    await setDomainState(db, domainId, {
      status: 'failed',
      last_error: 'DNS nach 30 Minuten nicht propagiert. Record beim Registrar pruefen, dann "Erneut pruefen".',
    });
  } finally {
    await db.end();
  }
  console.warn(`DNS fuer ${hostname} nach 30min nicht propagiert.`);
}

/**
 * Prueft beim Start fuer jede live-Domain, ob ihre Traefik-Router-Datei noch da ist,
 * und schreibt fehlende neu.
 *
 * Ohne das bleibt ein geloeschter Router unbemerkt: Zertifikat gueltig, Container
 * gesund, DB-Status "live" — aber Traefik kennt den Host nicht und antwortet 404.
 * Genau so ein Fall ist in der Entwicklung aufgetreten. Auch relevant nach einem
 * Restore oder verlorenem Volume.
 */
export async function healMissingRouters(): Promise<void> {
  const db = adminClient();
  try {
    await db.connect();
    const { rows } = await db.query(
      `SELECT DISTINCT d.project_id FROM domains d
       WHERE d.kind = 'custom' AND d.status IN ('live','tls_pending')`
    );
    let healed = 0;
    for (const r of rows) {
      const { rows: check } = await db.query(
        `SELECT d.id, d.hostname, d.router_file FROM domains d
         WHERE d.project_id = $1 AND d.kind = 'custom' AND d.status IN ('live','tls_pending')`,
        [r.project_id]
      );
      const missing = check.filter((d: any) => !d.router_file || !existsSync(`${DYNAMIC_DIR}/${d.router_file}`));
      if (missing.length === 0) continue;
      for (const m of missing) {
        console.warn(`Router fehlt fuer ${m.hostname} — wird neu geschrieben.`);
      }
      // Immer das ganze Projekt synchronisieren, damit Primaer/Redirect stimmig bleibt.
      await syncProjectRouters(db, r.project_id);
      healed += missing.length;
    }
    console.log(healed > 0
      ? `Router-Selbstheilung: ${healed} Datei(en) wiederhergestellt.`
      : 'Router-Selbstheilung: alle Router vorhanden.');
  } catch (err: any) {
    console.error('Router-Selbstheilung fehlgeschlagen:', err.message);
  } finally {
    await db.end().catch(() => {});
  }
}

/**
 * P1-1c: Beim Agent-Start alle unfertigen Domains erneut in die Schleife haengen.
 * Vorher waren die Polling-Promises reine fire-and-forget-Ketten im Prozess — ein
 * Neustart des Agents liess sie sterben und der Status blieb fuer immer "ausstehend",
 * ohne dass die UI davon je erfahren haette.
 */
export async function resumePendingDomainChecks(): Promise<void> {
  const db = adminClient();
  try {
    await db.connect();
    const { rows } = await db.query(
      `SELECT id, hostname FROM domains WHERE kind = 'custom' AND status IN ('pending_dns','dns_ok','tls_pending')`
    );
    if (rows.length === 0) {
      console.log('Domain-Resume: keine offenen Domains.');
      return;
    }
    console.log(`Domain-Resume: ${rows.length} offene Domain(s) werden erneut geprueft.`);
    for (const r of rows) {
      pollDomain(r.id, r.hostname).catch((e) =>
        console.error(`Domain-Resume ${r.hostname} fehlgeschlagen:`, e.message)
      );
    }
  } catch (err: any) {
    console.error('Domain-Resume fehlgeschlagen:', err.message);
  } finally {
    await db.end().catch(() => {});
  }
}

/* ------------------------------------------------------------------ Routen */

// POST /domains — Custom Domain registrieren
domainsRouter.post('/domains', async (req, res) => {
  const { projectId, hostname } = req.body;
  if (!projectId || !hostname) return res.status(400).json({ error: 'projectId and hostname required' });

  const host = String(hostname).trim().toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.') || host.length > 253) {
    return res.status(400).json({ error: 'Ungueltiger Hostname.' });
  }

  // P1-9 (Audit 0430f9c): geprueft wurden bisher nur Format und Duplikate
  // innerhalb der domains-Tabelle. Nicht erfasst und damit uebernehmbar waren
  // webhooks.<PLATFORM_DOMAIN>, admin.<PLATFORM_DOMAIN>, status-vps.<...>,
  // <slug>-api.<...> und <slug>-auth.<...>. Ein Custom-Domain-Eintrag darauf
  // schreibt eine File-Provider-Router-Datei mit kollidierender Host()-Regel —
  // Traefik loest identische Regeln nicht deterministisch dokumentiert auf, der
  // Traffic eines fremden PostgREST-Endpunkts kann auf einen anderen
  // App-Container gehen. Verschaerfend: tryAutoDns() benutzt CF_DNS_API_TOKEN
  // fuer die eigene Zone und wuerde einen A-Record ins produktive
  // Plattform-DNS schreiben.
  const PLATFORM = (process.env.PLATFORM_DOMAIN || '').toLowerCase();
  if (PLATFORM && (host === PLATFORM || host.endsWith(`.${PLATFORM}`))) {
    return res.status(400).json({
      error: `Hostnamen unter ${PLATFORM} sind fuer die Plattform reserviert und koennen nicht als Custom-Domain registriert werden.`,
    });
  }

  const db = adminClient();
  await db.connect();
  try {
    const { rows: projRows } = await db.query(
      'SELECT slug, preview_hostname FROM projects WHERE id = $1', [projectId]
    );
    if (projRows.length === 0) return res.status(404).json({ error: 'project not found' });

    const { rows: dup } = await db.query('SELECT id FROM domains WHERE hostname = $1', [host]);
    if (dup.length > 0) return res.status(409).json({ error: `${host} ist bereits registriert.` });

    const { rows } = await db.query(
      `INSERT INTO domains (project_id, hostname, kind, status) VALUES ($1, $2, 'custom', 'pending_dns') RETURNING id`,
      [projectId, host]
    );
    const domainId = rows[0].id;

    const instructions = buildInstructions(host, projRows[0].preview_hostname);
    const autoDns = await tryAutoDns(host);

    res.json({
      status: 'pending_dns',
      domainId,
      hostname: host,
      instructions,
      autoDns,
      providers: configuredProviders(),
    });

    pollDomain(domainId, host).catch((err) => console.error(`Polling ${host}:`, err.message));
    await logAudit('domain.create', host, { projectId, autoDns: autoDns.ok, provider: autoDns.provider });
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// POST /domains/:id/verify — P1-1b: manuelle Sofortpruefung
domainsRouter.post('/domains/:id/verify', async (req, res) => {
  try {
    const result = await verifyDomain(req.params.id);
    const db = adminClient();
    await db.connect();
    let instructions: any[] = [];
    try {
      const d = await loadDomain(db, req.params.id);
      if (d) instructions = buildInstructions(d.hostname, d.preview_hostname);
    } finally {
      await db.end();
    }
    await logAudit('domain.verify', req.params.id, { status: result.status });
    res.json({ ...result, instructions });
  } catch (err: any) {
    res.status(err.message === 'domain not found' ? 404 : 500).json({ error: err.message });
  }
});

// GET /domains/:projectId — Liste inkl. Anleitung pro Domain
domainsRouter.get('/domains/:projectId', async (req, res) => {
  const db = adminClient();
  await db.connect();
  try {
    const { rows: projRows } = await db.query(
      'SELECT preview_hostname FROM projects WHERE id = $1', [req.params.projectId]
    );
    const previewHostname = projRows[0]?.preview_hostname || null;

    const { rows } = await db.query(
      `SELECT id, hostname, kind, dns_verified, tls_issued, status, last_check_at,
              last_error, verification_method, is_primary, created_at
       FROM domains WHERE project_id = $1 ORDER BY kind DESC, created_at ASC`,
      [req.params.projectId]
    );

    res.json(rows.map((d: any) => ({
      ...d,
      instructions: d.kind === 'custom' ? buildInstructions(d.hostname, previewHostname) : [],
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// DELETE /domains/:id — P1-1f: entfernt gezielt NUR diese Domain
domainsRouter.delete('/domains/:id', async (req, res) => {
  const db = adminClient();
  await db.connect();
  try {
    const d = await loadDomain(db, req.params.id);
    if (!d) return res.status(404).json({ error: 'domain not found' });
    if (d.kind === 'subdomain') {
      return res.status(400).json({ error: 'Preview-Domain kann nicht entfernt werden.' });
    }

    if (d.router_file) await removeRouterFile(d.router_file);
    else await removeAllRoutersForProject(d.project_slug); // Altbestand ohne router_file

    const wasPrimary = (await db.query(
      'SELECT is_primary FROM domains WHERE id = $1', [req.params.id]
    )).rows[0]?.is_primary;

    await db.query('DELETE FROM domains WHERE id = $1', [req.params.id]);

    if (wasPrimary) {
      // Ohne Nachruecken wuerden alle verbleibenden Domains weiter auf eine
      // geloeschte Domain umleiten.
      await db.query(
        `UPDATE domains SET is_primary = true WHERE id = (
           SELECT id FROM domains WHERE project_id = $1 AND kind = 'custom'
             AND status IN ('live','tls_pending') ORDER BY created_at LIMIT 1)`,
        [d.project_id]
      );
    }
    await syncProjectRouters(db, d.project_id);
    await logAudit('domain.delete', d.hostname, { projectSlug: d.project_slug, wasPrimary });
    res.json({ status: 'ok' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});


// POST /domains/:id/primary — Primaerdomain setzen, alle anderen leiten dorthin um
domainsRouter.post('/domains/:id/primary', async (req, res) => {
  const db = adminClient();
  await db.connect();
  try {
    const d = await loadDomain(db, req.params.id);
    if (!d) return res.status(404).json({ error: 'domain not found' });
    if (d.kind !== 'custom') {
      return res.status(400).json({ error: 'Nur Custom-Domains koennen primaer sein.' });
    }
    if (d.status !== 'live' && d.status !== 'tls_pending') {
      return res.status(400).json({ error: 'Domain muss zuerst verifiziert sein.' });
    }

    await db.query('BEGIN');
    await db.query('UPDATE domains SET is_primary = false WHERE project_id = $1', [d.project_id]);
    await db.query('UPDATE domains SET is_primary = true WHERE id = $1', [req.params.id]);
    await db.query('COMMIT');

    await syncProjectRouters(db, d.project_id);
    await logAudit('domain.set_primary', d.hostname, { projectId: d.project_id });
    res.json({ status: 'ok', primary: d.hostname });
  } catch (err: any) {
    await db.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});
