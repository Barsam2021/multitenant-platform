import { NextResponse } from "next/server";
import { insertMedia, logCmsAudit, usedStorageBytes } from "@/lib/configDb";
import { MAX_UPLOAD_BYTES, uploadFile } from "@/lib/media";
import { requireSession } from "@/lib/session";
import { hit } from "@/lib/rateLimit";
import { toUserMessage } from "@/lib/errors";

// Next puffert den Body ohnehin; die harte Grenze steht in lib/media.ts und
// wird zusaetzlich hier vorab geprueft, damit eine 200-MB-Datei nicht erst
// vollstaendig verarbeitet wird, um dann abgelehnt zu werden.
export async function POST(req: Request, { params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: tenantSlug } = await params;
  const session = await requireSession(tenantSlug);
  if (!session) {
    return NextResponse.json(
      { error: "Die Anmeldung ist abgelaufen. Bitte neu anmelden.", reauth: true },
      { status: 401 }
    );
  }

  // Bremse pro Redakteur, nicht pro IP: angemeldet ist er, die Frage ist nur,
  // wie viel Arbeit er ausloesen darf. Jedes Bild wird von sharp dekodiert und
  // neu kodiert — das ist die teuerste Operation im ganzen Dienst, und der
  // Dienst gehoert allen Kunden gemeinsam. 30 Dateien pro Minute liegen weit
  // ueber dem, was jemand von Hand hochlaedt, und weit unter dem, was einen
  // 512-MB-Container in die Knie zwingt.
  const upload = hit(`media:${session.userId}`, 30, 60_000);
  if (!upload.allowed) {
    return NextResponse.json(
      { error: "Zu viele Uploads in kurzer Zeit. Bitte einen Moment warten." },
      { status: 429, headers: { "Retry-After": String(upload.retryAfterSeconds) } }
    );
  }

  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > MAX_UPLOAD_BYTES * 1.2) {
    return NextResponse.json(
      { error: `Datei ist zu groß (maximal ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB).` },
      { status: 413 }
    );
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Keine Datei empfangen." }, { status: 400 });
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const used = await usedStorageBytes(tenantSlug);
    const uploaded = await uploadFile(tenantSlug, { buffer, originalName: file.name }, used);

    const media = await insertMedia({
      tenantSlug,
      objectKey: uploaded.objectKey,
      publicUrl: uploaded.publicUrl,
      originalName: file.name.slice(0, 200),
      contentType: uploaded.contentType,
      sizeBytes: uploaded.sizeBytes,
      width: uploaded.width,
      height: uploaded.height,
      uploadedBy: session.userId,
    });

    await logCmsAudit({
      tenantSlug,
      userId: session.userId,
      userEmail: session.email,
      action: "media.upload",
      detail: { objectKey: uploaded.objectKey, sizeBytes: uploaded.sizeBytes },
    });

    return NextResponse.json({ media });
  } catch (err) {
    // Postgres-Fehler uebersetzen statt durchreichen: der Redakteur bekam sonst
    // woertlich 'violates foreign key constraint "cms_media_uploaded_by_fkey"'
    // zu sehen — eine Meldung, mit der niemand etwas anfangen kann.
    const error = err as Error & { code?: string };
    if (error.code) {
      console.error(`[cms] Medien-Upload fuer "${tenantSlug}" fehlgeschlagen:`, error.message);
      return NextResponse.json({ error: toUserMessage(error) }, { status: 400 });
    }
    // Alles ohne Fehlercode kommt aus den eigenen Pruefungen (zu gross, Typ
    // nicht erlaubt, Kontingent voll) und ist bereits verstaendlich formuliert.
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
