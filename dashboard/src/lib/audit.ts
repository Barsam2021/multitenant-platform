import { Pool } from "pg";

// P3-5: Audit-Log-Eintraege, die direkt aus dem Dashboard-Prozess entstehen
// (Login, SQL-Editor, Tabellen-Editor) - diese Aktionen laufen nie ueber den
// Agent (tenantDb.ts verbindet direkt gegen die Tenant-DB), es gab bisher
// keinen logAudit()-Aufruf, der sie erreichen konnte. Eigene, schlanke Kopie
// statt Import aus dem Agent-Package (getrenntes Docker-Image, kein
// gemeinsames node_modules).
let auditPool: Pool | null = null;

function getAuditPool(): Pool {
  if (!auditPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL fehlt (siehe .env.example)");
    auditPool = new Pool({ connectionString, max: 3 });
  }
  return auditPool;
}

const SENSITIVE_KEY_RE = /(password|secret|token|jwt|apikey|api_key|value)/i;

function redact(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(redact);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? "***" : redact(v);
    }
    return out;
  }
  return obj;
}

/**
 * Wie lib/audit.ts im Provisioning-Agent, nur fuer Aktionen, die direkt im
 * Dashboard-Prozess passieren. actor/ip/userAgent werden explizit uebergeben,
 * statt sie implizit aus einem Kontext zu ziehen - der Dashboard-Code hat sie
 * an jeder Aufrufstelle ohnehin schon zur Hand (session, headers()).
 *
 * Darf niemals eine laufende Aktion zum Scheitern bringen, nur weil das
 * Logging fehlschlaegt - Fehler werden nur geloggt, nie geworfen.
 */
export async function logAudit(
  actor: string,
  action: string,
  target: string | null,
  meta: Record<string, unknown> = {},
  opts: { ip?: string | null; userAgent?: string | null } = {}
): Promise<void> {
  try {
    const pool = getAuditPool();
    await pool.query(
      "INSERT INTO audit_logs (actor, action, target, meta, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5, $6)",
      [actor, action, target, JSON.stringify(redact(meta)), opts.ip ?? null, opts.userAgent ?? null]
    );
  } catch (err) {
    console.error(`Audit log write failed (action=${action}, target=${target}):`, (err as Error).message);
  }
}
