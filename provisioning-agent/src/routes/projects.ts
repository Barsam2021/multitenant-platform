import { Router } from 'express';
import { Client as PGClient } from 'pg';
import crypto from 'crypto';
import { encrypt } from '../lib/crypto';
import { createHttpMonitor, isMonitoringConfigured } from '../lib/monitoring';
import { logAudit } from '../lib/audit';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;
const PREVIEW_DOMAIN_SUFFIX = process.env.PLATFORM_DOMAIN || 'example.com';
const WEBHOOK_PUBLIC_URL = process.env.WEBHOOK_PUBLIC_URL || 'https://webhooks.example.com';
const GITHUB_PAT = process.env.GITHUB_PAT; // Fine-grained PAT, Scope: Webhooks (write) — Solo-Admin-Setup, kein OAuth-Flow (Phase 3 YAGNI für 1 User).

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

// slug-<10 zufällige Hex-Zeichen>.<suffix> — kollisionsarm, keine Rückschlüsse auf Kundenzahl.
function generatePreviewHostname(slug: string): string {
  return `${slug}-${crypto.randomBytes(5).toString('hex')}.${PREVIEW_DOMAIN_SUFFIX}`;
}

interface GithubWebhookResult {
  registered: boolean;
  hookId?: number;
  reason?: string;
}

function parseGithubRepo(repoUrl: string): { owner: string; repo: string } | null {
  const match = repoUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(\.git)?\/?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function githubHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${GITHUB_PAT}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export function webhookUrlFor(projectId: string): string {
  return `${WEBHOOK_PUBLIC_URL}/webhooks/github/${projectId}`;
}

/**
 * Legt den Push-Webhook im Repo an — oder repariert einen bestehenden.
 *
 * "Reparieren" ist der haeufigere Fall als man denkt: das Repo wird umgezogen,
 * jemand loescht den Hook von Hand, WEBHOOK_PUBLIC_URL aendert sich, oder der
 * Hook wurde nach zu vielen fehlgeschlagenen Zustellungen von GitHub selbst
 * deaktiviert (`active: false`) — was genau dann passiert, wenn der Endpunkt
 * eine Zeit lang 401 zurueckgab (siehe routes/webhooks.ts).
 *
 * Deshalb: erst die vorhandenen Hooks lesen, einen mit unserer URL
 * wiederverwenden und per PATCH auf den aktuellen Stand bringen (Secret,
 * events, active) statt blind einen zweiten anzulegen — sonst sammeln sich
 * Karteileichen im Repo, die jeweils dasselbe Deployment doppelt ausloesen.
 */
async function ensureGithubWebhook(
  repoUrl: string,
  webhookUrl: string,
  secret: string
): Promise<GithubWebhookResult> {
  if (!GITHUB_PAT) return { registered: false, reason: 'GITHUB_PAT nicht gesetzt — Webhook manuell in GitHub eintragen.' };

  const parsed = parseGithubRepo(repoUrl);
  if (!parsed) return { registered: false, reason: 'Keine GitHub-URL erkannt.' };
  const { owner, repo } = parsed;

  const config = { url: webhookUrl, content_type: 'json', secret, insecure_ssl: '0' };

  try {
    const listRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/hooks?per_page=100`, {
      headers: githubHeaders(),
    });
    if (listRes.ok) {
      const hooks = await listRes.json();
      const existing = Array.isArray(hooks)
        ? hooks.find((h: any) => h?.config?.url === webhookUrl)
        : undefined;
      if (existing) {
        const patchRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/hooks/${existing.id}`, {
          method: 'PATCH',
          headers: githubHeaders(),
          body: JSON.stringify({ active: true, events: ['push'], config }),
        });
        if (!patchRes.ok) {
          const body = await patchRes.text();
          return { registered: false, hookId: existing.id, reason: `GitHub API ${patchRes.status}: ${body.slice(0, 200)}` };
        }
        return { registered: true, hookId: existing.id };
      }
    }
    // Liste nicht lesbar (fehlender Scope) — trotzdem versuchen anzulegen, der
    // Fehler von POST ist aussagekraeftiger als ein stiller Abbruch hier.

    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/hooks`, {
      method: 'POST',
      headers: githubHeaders(),
      body: JSON.stringify({ name: 'web', active: true, events: ['push'], config }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { registered: false, reason: `GitHub API ${res.status}: ${body.slice(0, 200)}` };
    }
    const created = await res.json().catch(() => ({}));
    return { registered: true, hookId: typeof created?.id === 'number' ? created.id : undefined };
  } catch (err: any) {
    return { registered: false, reason: err.message };
  }
}

export const projectsRouter = Router();

// POST /projects — neues Deployment-Projekt für einen bestehenden Tenant anlegen,
// inkl. automatischer Preview-Domain + automatischer GitHub-Webhook-Registrierung.
projectsRouter.post('/projects', async (req, res) => {
  const { tenantSlug, slug, repoUrl, repoProvider, defaultBranch, buildCommand, appPort, healthPath } = req.body;

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'invalid project slug' });
  if (!tenantSlug || !/^[a-z0-9-]+$/.test(tenantSlug)) return res.status(400).json({ error: 'invalid tenant slug' });
  if (!repoUrl) return res.status(400).json({ error: 'repoUrl required' });

  const webhookSecret = crypto.randomBytes(32).toString('hex');
  const previewHostname = generatePreviewHostname(slug);
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `INSERT INTO projects (tenant_slug, slug, repo_url, repo_provider, default_branch, build_command, webhook_secret, preview_hostname, app_port, health_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, slug, tenant_slug, repo_url, default_branch, active_container, preview_hostname, app_port, health_path, created_at`,
      [tenantSlug, slug, repoUrl, repoProvider || 'github', defaultBranch || 'main', buildCommand || null, webhookSecret, previewHostname,
       Number(appPort) > 0 ? Number(appPort) : 3000, typeof healthPath === 'string' && healthPath.startsWith('/') ? healthPath : '/']
    );
    await db.query(
      // P1-1i: frueher wurden dns_verified/tls_issued hier blind auf true gesetzt —
      // die UI zeigte "DNS OK / TLS OK" fuer etwas, das nie geprueft wurde. Der
      // Wildcard-A-Record existiert zwar, das Zertifikat stellt Traefik aber erst
      // beim ersten Request aus. Status startet daher ehrlich als tls_pending.
      `INSERT INTO domains (project_id, hostname, kind, dns_verified, tls_issued, status)
       VALUES ($1, $2, 'subdomain', true, false, 'tls_pending')`,
      [rows[0].id, previewHostname]
    );

    const webhookUrl = webhookUrlFor(rows[0].id);
    const githubWebhook = await ensureGithubWebhook(repoUrl, webhookUrl, webhookSecret);
    // github_webhook_id existiert seit Migration 12, wurde aber nie beschrieben —
    // die ID kam einmalig aus der GitHub-Antwort zurueck und wurde weggeworfen.
    // Ohne sie laesst sich der Hook spaeter weder gezielt pruefen noch entfernen.
    if (githubWebhook.hookId) {
      await db.query('UPDATE projects SET github_webhook_id = $1 WHERE id = $2', [githubWebhook.hookId, rows[0].id]);
    }
    if (!githubWebhook.registered) {
      // Vorher stand das Ergebnis ausschliesslich in dieser einen Antwort. Wer
      // den Dialog weggeklickt hat, hatte ein Projekt, das nie automatisch
      // deployt — ohne jede Spur, warum.
      console.warn(`Webhook-Registrierung fuer Projekt ${slug} fehlgeschlagen: ${githubWebhook.reason}`);
      await logAudit('project.webhook.register_failed', slug, { reason: githubWebhook.reason });
    }

    // Monitoring-Registrierung (Phase 4) — "best effort", analog zu registerGithubWebhook:
    // ein Kuma-Ausfall darf das Projekt-Anlegen nicht scheitern lassen.
    let monitoring: { registered: boolean; reason?: string } = { registered: false, reason: 'not configured' };
    if (isMonitoringConfigured()) {
      try {
        const monitorId = await createHttpMonitor(`${tenantSlug}/${slug}`, `https://${previewHostname}`);
        await db.query('UPDATE projects SET kuma_monitor_id = $1 WHERE id = $2', [monitorId, rows[0].id]);
        monitoring = { registered: true };
      } catch (e: any) {
        monitoring = { registered: false, reason: e.message };
        console.error(`Uptime-Kuma monitor registration failed for ${slug}:`, e.message);
      }
    }

    await logAudit('project.create', slug, { tenantSlug, repoUrl, repoProvider: repoProvider || 'github' });

    res.json({
      status: 'ok',
      project: rows[0],
      previewHostname,
      webhookSecret, // einmalig im Klartext zurückgeben, danach nur noch verschlüsselt/gehashed genutzt
      webhookUrl,
      githubWebhook,
      monitoring,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// GET /projects — Liste für Dashboard-Übersicht
projectsRouter.get('/projects', async (_req, res) => {
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT p.id, p.tenant_slug, p.slug, p.repo_url, p.default_branch, p.active_container,
              p.active_deployment_id, p.preview_hostname, p.created_at, k.tariff,
              COALESCE(p.app_port, 3000) AS app_port, COALESCE(p.health_path, '/') AS health_path
       FROM projects p JOIN kunden k ON k.slug = p.tenant_slug
       ORDER BY p.created_at DESC`
    );
    res.json(rows);
  } finally {
    await db.end();
  }
});

// PUT /projects/:id/env — Env-Var setzen (verschlüsselt gespeichert)
projectsRouter.put('/projects/:id/env', async (req, res) => {
  const { id } = req.params;
  const { key, value } = req.body;
  if (!key || typeof value !== 'string') return res.status(400).json({ error: 'key and value required' });
  if (!/^[A-Z0-9_]+$/.test(key)) return res.status(400).json({ error: 'invalid env var key format' });

  const db = adminClient();
  await db.connect();
  try {
    const encrypted = encrypt(value);
    // Parameterisierte Query statt pg-format hier — %L ist für Bytea/Buffer-Werte nicht
    // zuverlässig; pg-format bleibt reserviert für Identifier-Quoting (siehe CLAUDE.md § 2.3).
    await db.query(
      `INSERT INTO project_env_vars (project_id, key, value_encrypted) VALUES ($1, $2, $3)
       ON CONFLICT (project_id, key) DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted`,
      [id, key, encrypted]
    );
    await logAudit('project.env.set', id, { key }); // Wert bewusst NICHT geloggt
    res.json({ status: 'ok' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// PUT /projects/:id/env/bulk — .env-Datei-Inhalt auf einen Schlag importieren.
// Erwartet rohen .env-Text (KEY=VALUE pro Zeile), parst serverseitig — Frontend schickt
// einfach den kompletten Datei-Inhalt, kein Client-seitiges Parsing nötig.
projectsRouter.put('/projects/:id/env/bulk', async (req, res) => {
  const { id } = req.params;
  const { envText } = req.body;
  if (typeof envText !== 'string') return res.status(400).json({ error: 'envText required' });

  const parsed: Record<string, string> = {};
  const errors: string[] = [];
  for (const rawLine of envText.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) { errors.push(`Übersprungen (kein "="): ${line.slice(0, 40)}`); continue; }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Umschließende Anführungszeichen entfernen — üblich in .env-Dateien.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!/^[A-Z0-9_]+$/.test(key)) { errors.push(`Übersprungen (ungültiger Key): ${key}`); continue; }
    parsed[key] = value;
  }

  const db = adminClient();
  await db.connect();
  try {
    for (const [key, value] of Object.entries(parsed)) {
      const encrypted = encrypt(value);
      await db.query(
        `INSERT INTO project_env_vars (project_id, key, value_encrypted) VALUES ($1, $2, $3)
         ON CONFLICT (project_id, key) DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted`,
        [id, key, encrypted]
      );
    }
    await logAudit('project.env.bulk_import', id, { count: Object.keys(parsed).length, keys: Object.keys(parsed) });
    res.json({ status: 'ok', imported: Object.keys(parsed).length, skipped: errors });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// GET /projects/:id/env — gesetzte Keys auflisten (Werte bleiben verborgen)
projectsRouter.get('/projects/:id/env', async (req, res) => {
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT key FROM project_env_vars WHERE project_id = $1 ORDER BY key ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// GET /projects/:id/webhook — Ist der Push-to-Deploy-Hook wirklich scharf?
//
// Bisher liess sich das nirgends nachsehen: der Registrierungs-Status war eine
// einmalige Zeile in der Antwort von POST /projects. Ob GitHub den Hook
// zwischenzeitlich deaktiviert hat (passiert nach wiederholten Fehlern
// automatisch) oder ob die letzte Zustellung 401 lieferte, war nur im
// GitHub-UI unter "Recent Deliveries" sichtbar.
projectsRouter.get('/projects/:id/webhook', async (req, res) => {
  const { id } = req.params;
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      'SELECT id, slug, repo_url, github_webhook_id FROM projects WHERE id = $1',
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'project not found' });
    const project = rows[0];
    const webhookUrl = webhookUrlFor(project.id);

    if (!GITHUB_PAT) {
      return res.json({ webhookUrl, ok: false, reason: 'GITHUB_PAT nicht gesetzt — Status nicht abfragbar.' });
    }
    const parsed = project.repo_url ? parseGithubRepo(project.repo_url) : null;
    if (!parsed) {
      return res.json({ webhookUrl, ok: false, reason: 'Kein GitHub-Repo — Push-to-Deploy nicht verfuegbar.' });
    }

    const listRes = await fetch(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/hooks?per_page=100`,
      { headers: githubHeaders() }
    );
    if (!listRes.ok) {
      const body = await listRes.text();
      return res.json({ webhookUrl, ok: false, reason: `GitHub API ${listRes.status}: ${body.slice(0, 200)}` });
    }
    const hooks = await listRes.json();
    const hook = Array.isArray(hooks) ? hooks.find((h: any) => h?.config?.url === webhookUrl) : undefined;

    if (!hook) {
      return res.json({
        webhookUrl,
        ok: false,
        reason: 'Kein Webhook mit dieser URL im Repo — Push loest kein Deployment aus.',
        // Ein Hook auf eine ANDERE URL ist der typische Rest aus einer alten
        // WEBHOOK_PUBLIC_URL: die Reparatur legt dann einen neuen an, statt
        // stillschweigend den fremden zu uebernehmen.
        otherHookUrls: Array.isArray(hooks) ? hooks.map((h: any) => h?.config?.url).filter(Boolean) : [],
      });
    }

    // last_response ist GitHubs eigene Sicht auf die letzte Zustellung —
    // code 401/404 hier heisst: der Hook existiert, aber unser Endpunkt hat ihn
    // abgewiesen.
    const lastResponse = hook.last_response || {};
    const deliversPush = Array.isArray(hook.events) && hook.events.includes('push');
    const ok = !!hook.active && deliversPush && (!lastResponse.code || lastResponse.code < 400);

    res.json({
      webhookUrl,
      ok,
      hookId: hook.id,
      active: !!hook.active,
      events: hook.events || [],
      lastResponse: { code: lastResponse.code ?? null, status: lastResponse.status ?? null, message: lastResponse.message ?? null },
      reason: ok
        ? undefined
        : !hook.active
          ? 'Webhook ist in GitHub deaktiviert (passiert automatisch nach wiederholt fehlgeschlagenen Zustellungen).'
          : !deliversPush
            ? `Webhook horcht nicht auf "push", sondern auf: ${(hook.events || []).join(', ') || '—'}`
            : `Letzte Zustellung: HTTP ${lastResponse.code} ${lastResponse.status || ''}`.trim(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// POST /projects/:id/webhook/repair — Hook neu anlegen bzw. auf den aktuellen
// Stand bringen (URL, Secret, events, active). Idempotent.
projectsRouter.post('/projects/:id/webhook/repair', async (req, res) => {
  const { id } = req.params;
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      'SELECT id, slug, repo_url, webhook_secret FROM projects WHERE id = $1',
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'project not found' });
    const project = rows[0];
    if (!project.repo_url) return res.status(400).json({ error: 'Projekt hat kein Repo hinterlegt' });

    // Fehlt das Secret (Projekt aus einer Zeit vor webhook_secret), hier eins
    // erzeugen — sonst kann die Signaturpruefung nie aufgehen.
    let secret: string = project.webhook_secret;
    if (!secret) {
      secret = crypto.randomBytes(32).toString('hex');
      await db.query('UPDATE projects SET webhook_secret = $1 WHERE id = $2', [secret, project.id]);
    }

    const webhookUrl = webhookUrlFor(project.id);
    const result = await ensureGithubWebhook(project.repo_url, webhookUrl, secret);
    if (result.hookId) {
      await db.query('UPDATE projects SET github_webhook_id = $1 WHERE id = $2', [result.hookId, project.id]);
    }
    await logAudit('project.webhook.repair', project.slug, { ok: result.registered, reason: result.reason });

    if (!result.registered) {
      return res.status(502).json({ error: result.reason || 'Webhook konnte nicht registriert werden', webhookUrl });
    }
    res.json({ status: 'ok', webhookUrl, hookId: result.hookId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// DELETE /projects/:id/env/:key — Env-Var entfernen
projectsRouter.delete('/projects/:id/env/:key', async (req, res) => {
  const db = adminClient();
  await db.connect();
  try {
    await db.query(
      `DELETE FROM project_env_vars WHERE project_id = $1 AND key = $2`,
      [req.params.id, req.params.key]
    );
    await logAudit('project.env.delete', req.params.id, { key: req.params.key });
    res.json({ status: 'ok' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});
