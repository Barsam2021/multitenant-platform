import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantBySlug, hasTenantDatabase, NO_TENANT_DATABASE_ERROR } from "@/lib/adminDb";
import { getRows, insertRow } from "@/lib/tenantDb";
import { logAudit } from "@/lib/audit";

const TABLE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function requestMeta(req: Request) {
  return {
    ip: req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string; table: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug, table } = await params;
  if (!TABLE_NAME_RE.test(table)) {
    return NextResponse.json({ error: "invalid table name" }, { status: 400 });
  }
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return NextResponse.json({ error: "tenant not found" }, { status: 404 });
  }
  if (!hasTenantDatabase(tenant)) {
    return NextResponse.json({ error: NO_TENANT_DATABASE_ERROR }, { status: 409 });
  }

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 500);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
  const orderBy = url.searchParams.get("orderBy") || undefined;
  const orderDirRaw = url.searchParams.get("orderDir");
  const orderDir = orderDirRaw === "desc" ? "desc" : orderDirRaw === "asc" ? "asc" : undefined;

  let filters: Record<string, string> | undefined;
  const filtersRaw = url.searchParams.get("filters");
  if (filtersRaw) {
    try {
      const parsed = JSON.parse(filtersRaw);
      if (parsed && typeof parsed === "object") {
        filters = Object.fromEntries(
          Object.entries(parsed).filter(([, v]) => typeof v === "string" && v.length > 0)
        ) as Record<string, string>;
      }
    } catch {
      // ungueltiges JSON im Filter-Parameter -> einfach ignorieren, kein 400
      // fuer einen reinen Anzeige-Parameter
    }
  }

  try {
    const { rows, columns, totalCount, hasPrimaryKey } = await getRows(tenant.db_name, table, {
      limit,
      offset,
      orderBy,
      orderDir,
      filters,
    });
    return NextResponse.json({ rows, columns, totalCount, hasPrimaryKey });
  } catch (err) {
    console.error("Failed to fetch rows:", (err as Error).message);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string; table: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug, table } = await params;
  if (!TABLE_NAME_RE.test(table)) {
    return NextResponse.json({ error: "invalid table name" }, { status: 400 });
  }
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return NextResponse.json({ error: "tenant not found" }, { status: 404 });
  }
  if (!hasTenantDatabase(tenant)) {
    return NextResponse.json({ error: NO_TENANT_DATABASE_ERROR }, { status: 409 });
  }

  const values = await req.json();
  const actor = session.user?.email || "unknown";
  const meta = requestMeta(req);
  try {
    const row = await insertRow(tenant.db_name, table, values);
    // P3-5: Spaltennamen ja, Werte nein - values koennen beliebige Kundendaten
    // enthalten, die nicht routinemaessig ins Audit-Log sollen.
    await logAudit(actor, "table.row_insert", `${slug}/${table}`, { columns: Object.keys(values) }, meta);
    return NextResponse.json({ row }, { status: 201 });
  } catch (err) {
    console.error("Failed to insert row:", (err as Error).message);
    await logAudit(actor, "table.row_insert", `${slug}/${table}`, { error: (err as Error).message }, meta);
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
