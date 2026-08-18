import { NextResponse } from "next/server";
import { getCollectionWithFields, logCmsAudit } from "@/lib/configDb";
import { insertRow } from "@/lib/rows";
import { requireSession } from "@/lib/session";
import { toUserMessage } from "@/lib/errors";

// POST — neuen Eintrag anlegen.
//
// Die Sitzungspruefung steht hier nochmal, obwohl das Seiten-Layout sie schon
// macht: ein Layout schuetzt keine API-Route, die direkt aufgerufen wird.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ tenant: string; collectionId: string }> }
) {
  const { tenant: tenantSlug, collectionId } = await params;
  const session = await requireSession(tenantSlug);
  if (!session) return NextResponse.json({ error: "nicht angemeldet" }, { status: 401 });

  const found = await getCollectionWithFields(tenantSlug, collectionId);
  if (!found) return NextResponse.json({ error: "Bereich nicht gefunden" }, { status: 404 });
  if (!found.collection.can_create) {
    return NextResponse.json({ error: "Neue Einträge sind hier nicht vorgesehen." }, { status: 403 });
  }

  const input = await req.json().catch(() => null);
  if (!input || typeof input !== "object") {
    return NextResponse.json({ error: "ungültige Daten" }, { status: 400 });
  }

  try {
    const pk = await insertRow(tenantSlug, found.collection.table_name, found.fields, input);
    await logCmsAudit({
      tenantSlug,
      userId: session.userId,
      userEmail: session.email,
      action: "row.create",
      collection: found.collection.table_name,
      rowPk: pk,
    });
    return NextResponse.json({ status: "ok", pk });
  } catch (err) {
    const message = toUserMessage(err as Error);
    if (!(err as { code?: string }).code) console.error(`[cms] ${(err as Error).stack || message}`);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
