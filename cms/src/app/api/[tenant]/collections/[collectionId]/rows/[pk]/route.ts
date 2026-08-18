import { NextResponse } from "next/server";
import { getCollectionWithFields, logCmsAudit } from "@/lib/configDb";
import { deleteRow, updateRow } from "@/lib/rows";
import { requireSession } from "@/lib/session";
import { toUserMessage } from "@/lib/errors";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ tenant: string; collectionId: string; pk: string }> }
) {
  const { tenant: tenantSlug, collectionId, pk } = await params;
  const session = await requireSession(tenantSlug);
  if (!session) return NextResponse.json({ error: "nicht angemeldet" }, { status: 401 });

  const found = await getCollectionWithFields(tenantSlug, collectionId);
  if (!found) return NextResponse.json({ error: "Bereich nicht gefunden" }, { status: 404 });

  const input = await req.json().catch(() => null);
  if (!input || typeof input !== "object") {
    return NextResponse.json({ error: "ungültige Daten" }, { status: 400 });
  }

  try {
    const ok = await updateRow(
      tenantSlug,
      found.collection.table_name,
      found.fields,
      decodeURIComponent(pk),
      input
    );
    if (!ok) return NextResponse.json({ error: "Eintrag nicht gefunden" }, { status: 404 });
    await logCmsAudit({
      tenantSlug,
      userId: session.userId,
      userEmail: session.email,
      action: "row.update",
      collection: found.collection.table_name,
      rowPk: decodeURIComponent(pk),
      // Nur die Feldnamen, nie die Werte: das Audit-Log soll nachvollziehbar
      // machen, wer was angefasst hat, und nicht die Inhalte verdoppeln.
      detail: { fields: Object.keys(input) },
    });
    return NextResponse.json({ status: "ok" });
  } catch (err) {
    const message = toUserMessage(err as Error);
    if (!(err as { code?: string }).code) console.error(`[cms] ${(err as Error).stack || message}`);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ tenant: string; collectionId: string; pk: string }> }
) {
  const { tenant: tenantSlug, collectionId, pk } = await params;
  const session = await requireSession(tenantSlug);
  if (!session) return NextResponse.json({ error: "nicht angemeldet" }, { status: 401 });

  const found = await getCollectionWithFields(tenantSlug, collectionId);
  if (!found) return NextResponse.json({ error: "Bereich nicht gefunden" }, { status: 404 });
  if (!found.collection.can_delete) {
    return NextResponse.json({ error: "Löschen ist in diesem Bereich nicht vorgesehen." }, { status: 403 });
  }

  try {
    const ok = await deleteRow(tenantSlug, found.collection.table_name, decodeURIComponent(pk));
    if (!ok) return NextResponse.json({ error: "Eintrag nicht gefunden" }, { status: 404 });
    await logCmsAudit({
      tenantSlug,
      userId: session.userId,
      userEmail: session.email,
      action: "row.delete",
      collection: found.collection.table_name,
      rowPk: decodeURIComponent(pk),
    });
    return NextResponse.json({ status: "ok" });
  } catch (err) {
    const message = toUserMessage(err as Error);
    if (!(err as { code?: string }).code) console.error(`[cms] ${(err as Error).stack || message}`);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
