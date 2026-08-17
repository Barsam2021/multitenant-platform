import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantBySlug, hasTenantDatabase, NO_TENANT_DATABASE_ERROR } from "@/lib/adminDb";
import { updateRow, deleteRow } from "@/lib/tenantDb";
import { logAudit } from "@/lib/audit";

const TABLE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function requestMeta(req: Request) {
  return {
    ip: req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  };
}

export async function PATCH(
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

  const { pkColumn, pkValue, values } = await req.json();
  if (!pkColumn || pkValue === undefined || !values) {
    return NextResponse.json({ error: "pkColumn, pkValue, values required" }, { status: 400 });
  }

  const actor = session.user?.email || "unknown";
  const meta = requestMeta(req);
  try {
    const row = await updateRow(tenant.db_name, table, pkColumn, pkValue, values);
    await logAudit(
      actor,
      "table.row_update",
      `${slug}/${table}`,
      { pkColumn, pkValue, columns: Object.keys(values) },
      meta
    );
    return NextResponse.json({ row });
  } catch (err) {
    console.error("Failed to update row:", (err as Error).message);
    await logAudit(actor, "table.row_update", `${slug}/${table}`, { pkColumn, pkValue, error: (err as Error).message }, meta);
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(
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

  const { pkColumn, pkValue } = await req.json();
  if (!pkColumn || pkValue === undefined) {
    return NextResponse.json({ error: "pkColumn, pkValue required" }, { status: 400 });
  }

  const actor = session.user?.email || "unknown";
  const meta = requestMeta(req);
  try {
    await deleteRow(tenant.db_name, table, pkColumn, pkValue);
    await logAudit(actor, "table.row_delete", `${slug}/${table}`, { pkColumn, pkValue }, meta);
    return NextResponse.json({ status: "ok" });
  } catch (err) {
    console.error("Failed to delete row:", (err as Error).message);
    await logAudit(actor, "table.row_delete", `${slug}/${table}`, { pkColumn, pkValue, error: (err as Error).message }, meta);
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
