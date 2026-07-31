import { Client as PGClient } from 'pg';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

// Key-Namen, deren Werte nie im Audit-Log landen dürfen, egal wie tief verschachtelt.
// Namensbasiert statt Regex-auf-String, weil meta ein JSON-Objekt ist (kein "KEY=value"-
// Text wie Build-Logs, siehe lib/crypto.ts maskSecrets() — die ist für Freitext-Logs gebaut,
// nicht für strukturierte Objekte, deshalb hier ein eigener, einfacherer Redactor).
const SENSITIVE_KEY_RE = /(password|secret|token|jwt|apikey|api_key|value)/i;

function redact(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(redact);
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? '***' : redact(v);
    }
    return out;
  }
  return obj;
}

/**
 * Schreibt einen Audit-Log-Eintrag (Phase 6). Single-Admin-Setup, 'actor' ist
 * aktuell fest 'admin' — Spalte existiert für spätere Mehr-Admin-Szenarien.
 *
 * WICHTIG: darf niemals eine laufende Aktion (Tenant-Erstellung, Deploy, ...) zum
 * Scheitern bringen, nur weil das Logging fehlschlägt — Fehler werden daher nur
 * geloggt, nie geworfen.
 *
 * meta wird vor dem Schreiben namensbasiert redigiert (siehe redact() oben), damit
 * aus Versehen mitgegebene Secrets nicht im Klartext in audit_logs landen.
 */
export async function logAudit(
  action: string,
  target: string | null,
  meta: Record<string, unknown> = {}
): Promise<void> {
  const db = new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
  try {
    await db.connect();
    await db.query(
      'INSERT INTO audit_logs (actor, action, target, meta) VALUES ($1, $2, $3, $4)',
      ['admin', action, target, JSON.stringify(redact(meta))]
    );
  } catch (err: any) {
    console.error(`Audit log write failed (action=${action}, target=${target}):`, err.message);
  } finally {
    await db.end().catch(() => {});
  }
}
