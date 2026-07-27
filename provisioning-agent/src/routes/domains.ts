import { Router } from 'express';
import { Client as PGClient } from 'pg';
import dns from 'dns/promises';
import { writeCustomDomainRouter, removeCustomDomainRouter } from '../lib/traefikDynamic';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;
const VPS_IP = process.env.VPS_PUBLIC_IP; // aus .env, für den A-Record-Vergleich

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
    res.json({
      status: 'pending_dns',
      domainId: rows[0].id,
      instructions: VPS_IP
        ? `Lege einen A-Record an: ${hostname} → ${VPS_IP}`
        : `Lege einen A-Record auf die VPS-IP an (VPS_PUBLIC_IP ist im Agent-.env nicht gesetzt).`,
    });

    // Hintergrund-Polling (60s Intervall, max 30min) — analog Dashboard-seitigem Polling in Doc 05 §5.2.
    // Läuft hier serverseitig, damit es auch funktioniert wenn niemand das Dashboard offen hat.
    pollDnsAndActivate(rows[0].id, projectId, hostname).catch((err) =>
      console.error(`DNS polling for ${hostname} failed:`, err.message)
    );
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

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
          // TLS wird von Traefiks HTTP-01-Challenge automatisch nachgezogen; wir markieren
          // optimistisch nach kurzer Wartezeit, echte Bestätigung könnte via ACME-Log erfolgen.
          setTimeout(async () => {
            const db2 = adminClient();
            await db2.connect();
            await db2.query('UPDATE domains SET tls_issued = true WHERE id = $1', [domainId]).catch(() => {});
            await db2.end();
          }, 60_000);
        } finally {
          await db.end();
        }
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
    res.json({ status: 'ok' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});
