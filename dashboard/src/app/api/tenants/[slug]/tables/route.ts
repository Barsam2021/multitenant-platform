import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantBySlug } from "@/lib/adminDb";
import { listTables } from "@/lib/tenantDb";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

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
