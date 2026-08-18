import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";
import { deleteCollection, getCollection, listFields, syncFields, updateCollection, TenantColumn } from "@/lib/cmsDb";

// PATCH — Beschriftung, Sortierung, Rechte einer Sammlung ändern.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug, id } = await params;
  const patch = await req.json();
  const updated = await updateCollection(id, slug, {
    label: patch.label,
    label_singular: patch.labelSingular,
    sort_column: patch.sortColumn,
    sort_dir: patch.sortDir === "asc" ? "asc" : patch.sortDir === "desc" ? "desc" : undefined,
    can_create: patch.canCreate,
    can_delete: patch.canDelete,
    position: patch.position,
  });
  if (!updated) return NextResponse.json({ error: "collection not found" }, { status: 404 });
  return NextResponse.json({ collection: updated });
}

// DELETE — Sammlung aus dem CMS nehmen. Entzieht der DB-Rolle die Rechte auf
// die Tabelle. Die Tabelle SELBST und alle Daten darin bleiben unberührt.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug, id } = await params;
  const tableName = await deleteCollection(id, slug);
  if (!tableName) return NextResponse.json({ error: "collection not found" }, { status: 404 });

  // Fehlgeschlagener Rechte-Entzug ist kein Grund, die Löschung zurückzudrehen:
  // ohne Collection kommt der CMS-Dienst ohnehin nicht mehr an die Tabelle. Die
  // verbliebenen GRANTs sind trotzdem ein Rest, der genannt gehört.
  const revoke = await agentFetch(`/tenants/${slug}/cms/revoke`, {
    method: "POST",
    body: JSON.stringify({ table: tableName }),
  });

  return NextResponse.json({
    status: "ok",
    tableName,
    warning:
      revoke.status !== 200
        ? `Sammlung entfernt, aber die Tabellenrechte für cms_${slug} konnten nicht entzogen werden: ${revoke.body?.error || "unbekannt"}`
        : undefined,
  });
}

// POST — Felder mit dem aktuellen Tabellenschema abgleichen (neue Spalten
// aufnehmen, verschwundene entfernen).
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug, id } = await params;
  const collection = await getCollection(id, slug);
  if (!collection) return NextResponse.json({ error: "collection not found" }, { status: 404 });

  const columnsRes = await agentFetch(`/tenants/${slug}/cms/tables/${collection.table_name}/columns`);
  if (columnsRes.status !== 200 || !Array.isArray(columnsRes.body?.columns)) {
    return NextResponse.json(
      { error: columnsRes.body?.error || "Spalten konnten nicht gelesen werden" },
      { status: columnsRes.status || 500 }
    );
  }

  const result = await syncFields(id, columnsRes.body.columns as TenantColumn[]);
  const fields = await listFields(id);
  return NextResponse.json({ ...result, fields });
}
