import { Router } from 'express';
import { Client as PGClient } from 'pg';
import dns from 'dns/promises';
import tls from 'tls';
import { writeCustomDomainRouter, removeCustomDomainRouter } from '../lib/traefikDynamic';
import { setGodaddyARecord } from '../lib/godaddy';
import { logAudit } from '../lib/audit';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;
const VPS_IP = process.env.VPS_PUBLIC_IP; // aus .env, für den A-Record-Vergleich
const GODADDY_CONFIGURED = Boolean(process.env.GODADDY_API_KEY);

function adminClient(): PGClient {
  return new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
}

export const domainsRouter = Router();

// POST /domains — Custom Domain für ein Projekt registrieren, DNS-Polling im Hintergrund starten
domainsRouter.post('/domains', async (req, res) => {
  const { projectId, hostname } = req.body;
  if (!projectId || !hostname) return res.status(400).json({ error: 'projectId and hostname required' });
  if (!/^[a-z0-9.-]+$/.test(hostname)) return res.status(400).json({ error: 'invalid hostname' });

  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `INSERT INTO domains (project_id, hostname, kind) VALUES ($1, $2, 'custom') RETURNING id`,
      [projectId, hostname]
    );

    // Voraussetzung Phase 2 (HTTP-01 für Custom-Domains) — nur wenn GoDaddy konfiguriert
    // ist versuchen wir's automatisch, sonst bleibt's wie bisher rein manuell/Instruktion.
    let godaddy = { attempted: false, ok: false } as { attempted: boolean; ok: boolean; reason?: string };
    if (GODADDY_CONFIGURED && VPS_IP) {
      const result = await setGodaddyARecord(hostname, VPS_IP);
      godaddy = { attempted: true, ok: result.ok, reason: result.reason };
    }

    res.json({
      status: 'pending_dns',
      domainId: rows[0].id,
      instructions: VPS_IP
        ? `Lege einen A-Record an: ${hostname} → ${VPS_IP}`
        : `Lege einen A-Record auf die VPS-IP an (VPS_PUBLIC_IP ist im Agent-.env nicht gesetzt).`,
      godaddy,
    });

    // Hintergrund-Polling (60s Intervall, max 30min) — analog Dashboard-seitigem Polling in Doc 05 §5.2.
    // Läuft hier serverseitig, damit es auch funktioniert wenn niemand das Dashboard offen hat.
    pollDnsAndActivate(rows[0].id, projectId, hostname).catch((err) =>
      console.error(`DNS polling for ${hostname} failed:`, err.message)
    );

    await logAudit('domain.create', hostname, { projectId, godaddy: godaddy.ok });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

/**
 * Prüft per rohem TLS-Handshake (nicht HTTPS-Request), ob Traefik für `hostname`
 * bereits ein echtes Let's-Encrypt-Zertifikat ausliefert statt des selbstsignierten
 * Traefik-Default-Zertifikats. `rejectUnauthorized: false`, weil wir das Zertifikat
 * hier bewusst selbst bewerten statt der Verbindung pauschal zu vertrauen/misstrauen.
 */
function hasRealTlsCertificate(hostname: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: hostname, port: 443, servername: hostname, rejectUnauthorized: false, timeout: 5000 },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        const issuer = cert?.issuer?.CN || cert?.issuer?.O || '';
        resolve(Boolean(cert && Object.keys(cert).length > 0 && issuer !== 'TRAEFIK DEFAULT CERT'));
      }
    );
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(false));
  });
}

/**
 * Pollt bis zu 3 Minuten (alle 10s) den echten Traefik-ACME-Status via TLS-Handshake,
 * statt wie bisher optimistisch nach 60s tls_issued zu setzen (das war der Bug — bei
 * HTTP-01 kann die Challenge fehlschlagen, z.B. wenn Port 80 extern blockiert ist).
 */
async function waitForRealTlsAndActivate(domainId: string, hostname: string): Promise<void> {
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    if (await hasRealTlsCertificate(hostname)) {
      const db = adminClient();
      await db.connect();
      try {
        await db.query('UPDATE domains SET tls_issued = true WHERE id = $1', [domainId]);
      } finally {
        await db.end();
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.warn(`TLS für ${hostname} nach 3min nicht bestätigt — tls_issued bleibt false, ACME-Logs prüfen.`);
}

async function pollDnsAndActivate(domainId: string, projectId: string, hostname: string): Promise<void> {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const addresses = await dns.resolve4(hostname);
      if (!VPS_IP || addresses.includes(VPS_IP)) {
        const db = adminClient();
        await db.connect();
        try {
          const { rows } = await db.query('SELECT slug, active_container FROM projects WHERE id = $1', [projectId]);
          if (rows.length === 0) return;
          const containerName = rows[0].active_container || `app-${rows[0].slug}`;
          await writeCustomDomainRouter(rows[0].slug, hostname, containerName);
          await db.query('UPDATE domains SET dns_verified = true WHERE id = $1', [domainId]);
        } finally {
          await db.end();
        }
        // Erst nach echtem, per TLS-Handshake bestätigtem Zertifikat tls_issued setzen
        // (siehe hasRealTlsCertificate/waitForRealTlsAndActivate oben).
        waitForRealTlsAndActivate(domainId, hostname).catch((err) =>
          console.error(`TLS-Check für ${hostname} fehlgeschlagen:`, err.message)
        );
        return;
      }
    } catch {
      // DNS noch nicht propagiert — weiter pollen.
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }
  console.warn(`DNS für ${hostname} nach 30min nicht propagiert — Polling abgebrochen.`);
}

// DELETE /domains/:id — Custom Domain entfernen
domainsRouter.delete('/domains/:id', async (req, res) => {
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT d.hostname, p.slug FROM domains d JOIN projects p ON p.id = d.project_id WHERE d.id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'domain not found' });
    await removeCustomDomainRouter(rows[0].slug);
    await db.query('DELETE FROM domains WHERE id = $1', [req.params.id]);
    await logAudit('domain.delete', rows[0].hostname, { projectSlug: rows[0].slug });
    res.json({ status: 'ok' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// GET /domains/:projectId — Domain-Liste für Dashboard
domainsRouter.get('/domains/:projectId', async (req, res) => {
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT id, hostname, kind, dns_verified, tls_issued, created_at
       FROM domains WHERE project_id = $1 ORDER BY created_at ASC`,
      [req.params.projectId]
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});
