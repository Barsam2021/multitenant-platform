import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantBySlug, hasTenantDatabase, NO_TENANT_DATABASE_ERROR } from "@/lib/adminDb";
import { runSql } from "@/lib/tenantDb";
import { logAudit } from "@/lib/audit";
import { agentFetch } from "@/lib/agent";

const SQL_LOG_PREVIEW_LEN = 300;

// Statements, nach denen PostgREST sein Schema neu lesen muss. Bewusst grob:
// ein ueberfluessiges Reload kostet nichts (PostgREST liest den Katalog neu),
// ein ausgelassenes bedeutet, dass eine gerade angelegte Tabelle fuer die
// Kunden-API nicht existiert — PGRST205, und der Grund ist nirgends ablesbar.
const SCHEMA_CHANGING = /\b(create|drop|alter|grant|revoke|comment|rename)\b/i;

function requestMeta(req: Request) {
  return {
    ip: req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  };
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  // KRITISCH: dieser Endpunkt fuehrt beliebiges SQL als postgres-Superuser aus.
  // Er darf sich niemals allein auf middleware.ts verlassen.
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug } = await params;
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return NextResponse.json({ error: "tenant not found" }, { status: 404 });
  }
  if (!hasTenantDatabase(tenant)) {
    return NextResponse.json({ error: NO_TENANT_DATABASE_ERROR }, { status: 409 });
  }

  const { sql, readOnly } = await req.json();
  if (!sql || typeof sql !== "string") {
    return NextResponse.json({ error: "sql required" }, { status: 400 });
  }

  const actor = session.user?.email || "unknown";
  const meta = requestMeta(req);
  // P3-5: Query gekuerzt geloggt (nie der Ergebnisinhalt) - reicht, um im
  // Nachhinein nachzuvollziehen was gelaufen ist, ohne potenziell sensible
  // Zeilendaten ins Audit-Log zu kopieren.
  const sqlPreview = sql.length > SQL_LOG_PREVIEW_LEN ? sql.slice(0, SQL_LOG_PREVIEW_LEN) + "…" : sql;

  try {
    const result = await runSql(tenant.db_name, sql, { readOnly: readOnly !== false });

    // Nach dem Schreiben, aber vor der Antwort: der Benutzer sieht das Ergebnis
    // seines CREATE TABLE erst, wenn er es ueber die API abfragt — und genau
    // dann muss der Cache stimmen. Best effort, ein fehlgeschlagener Reload
    // darf ein erfolgreiches Statement nicht als Fehler erscheinen lassen.
    if (readOnly === false && SCHEMA_CHANGING.test(sql)) {
      await agentFetch(`/tenants/${slug}/postgrest/reload`, { method: "POST" }).catch(() => null);
    }

    await logAudit(actor, "sql.execute", slug, {
      sqlPreview,
      readOnly: readOnly !== false,
      rowCount: result.rowCount,
      durationMs: result.durationMs,
      truncated: result.truncated,
    }, meta);
    return NextResponse.json(result);
  } catch (err) {
    await logAudit(actor, "sql.execute", slug, {
      sqlPreview,
      readOnly: readOnly !== false,
      error: (err as Error).message,
    }, meta);
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
