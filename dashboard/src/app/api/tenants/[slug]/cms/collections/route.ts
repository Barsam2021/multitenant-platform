import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";
import { getTenantBySlug } from "@/lib/adminDb";
import { createCollection, listCollections, listFields, TenantColumn } from "@/lib/cmsDb";

const TABLE_RE = /^[a-z_][a-z0-9_]*$/;

// GET — Collections samt Feldern (die Verwaltungsansicht zeigt beides zusammen).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug } = await params;
  const collections = await listCollections(slug);
  const withFields = await Promise.all(
    collections.map(async (c) => ({ ...c, fields: await listFields(c.id) }))
  );
  return NextResponse.json({ collections: withFields });
}

// POST { tableName, label } — Tabelle als Collection freigeben.
//
// Zwei Schritte, die zusammengehören: Konfiguration anlegen (hier) und der
// DB-Rolle Rechte auf genau diese Tabelle geben (Agent). Scheitert der zweite,
// wird der erste zurückgenommen — eine Collection ohne Tabellenrechte sähe im
// CMS aus wie ein Defekt ("permission denied" bei jedem Aufruf).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug } = await params;
  const { tableName, label } = await req.json();
  if (typeof tableName !== "string" || !TABLE_RE.test(tableName)) {
    return NextResponse.json({ error: "ungültiger Tabellenname" }, { status: 400 });
  }

  const tenant = await getTenantBySlug(slug);
  if (!tenant) return NextResponse.json({ error: "tenant not found" }, { status: 404 });
  if (!tenant.cms_enabled) {
    return NextResponse.json({ error: "CMS ist für diesen Kunden nicht aktiviert" }, { status: 409 });
  }

  const columnsRes = await agentFetch(`/tenants/${slug}/cms/tables/${tableName}/columns`);
  if (columnsRes.status !== 200 || !Array.isArray(columnsRes.body?.columns)) {
    return NextResponse.json(
      { error: columnsRes.body?.error || "Spalten konnten nicht gelesen werden" },
      { status: columnsRes.status || 500 }
    );
  }
  const columns: TenantColumn[] = columnsRes.body.columns;
  if (columns.length === 0) {
    return NextResponse.json({ error: "Tabelle hat keine Spalten" }, { status: 400 });
  }

  let collection;
  try {
    collection = await createCollection(
      slug,
      tableName,
      typeof label === "string" && label.trim() ? label.trim() : tableName,
      columns
    );
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("duplicate key")) {
      return NextResponse.json({ error: "Diese Tabelle ist bereits eine Sammlung" }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const grant = await agentFetch(`/tenants/${slug}/cms/grant`, {
    method: "POST",
    body: JSON.stringify({ table: tableName }),
  });
  if (grant.status !== 200) {
    const { deleteCollection } = await import("@/lib/cmsDb");
    await deleteCollection(collection.id, slug).catch(() => {});
    return NextResponse.json(
      { error: grant.body?.error || "Tabellenrechte konnten nicht vergeben werden" },
      { status: 500 }
    );
  }

  const fields = await listFields(collection.id);
  return NextResponse.json({ collection: { ...collection, fields } });
}
