import { NextResponse } from "next/server";
import { getTenantBySlug } from "@/lib/adminDb";
import { listTables } from "@/lib/tenantDb";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return NextResponse.json({ error: "tenant not found" }, { status: 404 });
  }
  try {
    const tables = await listTables(tenant.db_name);
    return NextResponse.json({ tables });
  } catch (err) {
    console.error("Failed to list tables:", (err as Error).message);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
