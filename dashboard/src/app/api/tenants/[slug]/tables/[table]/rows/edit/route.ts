import { NextResponse } from "next/server";
import { getTenantBySlug } from "@/lib/adminDb";
import { updateRow, deleteRow } from "@/lib/tenantDb";

const TABLE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ slug: string; table: string }> }
) {
  const { slug, table } = await params;
  if (!TABLE_NAME_RE.test(table)) {
    return NextResponse.json({ error: "invalid table name" }, { status: 400 });
  }
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return NextResponse.json({ error: "tenant not found" }, { status: 404 });
  }

  const { pkColumn, pkValue, values } = await req.json();
  if (!pkColumn || pkValue === undefined || !values) {
    return NextResponse.json({ error: "pkColumn, pkValue, values required" }, { status: 400 });
  }

  try {
    const row = await updateRow(tenant.db_name, table, pkColumn, pkValue, values);
    return NextResponse.json({ row });
  } catch (err) {
    console.error("Failed to update row:", (err as Error).message);
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ slug: string; table: string }> }
) {
  const { slug, table } = await params;
  if (!TABLE_NAME_RE.test(table)) {
    return NextResponse.json({ error: "invalid table name" }, { status: 400 });
  }
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return NextResponse.json({ error: "tenant not found" }, { status: 404 });
  }

  const { pkColumn, pkValue } = await req.json();
  if (!pkColumn || pkValue === undefined) {
    return NextResponse.json({ error: "pkColumn, pkValue required" }, { status: 400 });
  }

  try {
    await deleteRow(tenant.db_name, table, pkColumn, pkValue);
    return NextResponse.json({ status: "ok" });
  } catch (err) {
    console.error("Failed to delete row:", (err as Error).message);
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
