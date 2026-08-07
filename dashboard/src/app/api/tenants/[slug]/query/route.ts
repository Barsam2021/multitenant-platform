import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantBySlug } from "@/lib/adminDb";
import { runSql } from "@/lib/tenantDb";

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

  const { sql } = await req.json();
  if (!sql || typeof sql !== "string") {
    return NextResponse.json({ error: "sql required" }, { status: 400 });
  }

  try {
    const result = await runSql(tenant.db_name, sql);
    return NextResponse.json({
      rows: result.rows,
      fields: result.fields?.map((f) => f.name) ?? [],
      rowCount: result.rowCount,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
