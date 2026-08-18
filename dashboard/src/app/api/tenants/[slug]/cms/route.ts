import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";
import { getTenantBySlug } from "@/lib/adminDb";
import { listCollections, listCmsUsers } from "@/lib/cmsDb";

// GET — kompletter CMS-Zustand eines Tenants für die Verwaltungsansicht:
// aktiv?, Collections, Redakteure, verfügbare Tabellen.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug } = await params;
  const tenant = await getTenantBySlug(slug);
  if (!tenant) return NextResponse.json({ error: "tenant not found" }, { status: 404 });

  const [collections, users] = await Promise.all([listCollections(slug), listCmsUsers(slug)]);

  // Tabellenliste nur holen, wenn es überhaupt eine Datenbank gibt — sonst
  // läuft der Agent in einen Verbindungsfehler, den hier niemand braucht.
  let tables: { name: string; rowEstimate: number; alreadyCollection: boolean }[] = [];
  if (tenant.db_provisioned) {
    const { status, body } = await agentFetch(`/tenants/${slug}/cms/tables`);
    if (status === 200 && Array.isArray(body?.tables)) tables = body.tables;
  }

  return NextResponse.json({
    enabled: tenant.cms_enabled,
    dbProvisioned: tenant.db_provisioned,
    collections,
    users,
    tables,
  });
}

// POST { enabled } — CMS für den Tenant an-/abschalten (legt die DB-Rolle an
// bzw. entfernt sie, siehe provisioning-agent/src/routes/cms.ts).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug } = await params;
  const { enabled } = await req.json();
  const { status, body } = await agentFetch(`/tenants/${slug}/cms`, {
    method: "POST",
    body: JSON.stringify({ enabled: !!enabled }),
  });
  return NextResponse.json(body, { status });
}
