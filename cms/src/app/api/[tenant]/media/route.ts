import { NextResponse } from "next/server";
import { insertMedia, logCmsAudit, usedStorageBytes } from "@/lib/configDb";
import { MAX_UPLOAD_BYTES, uploadFile } from "@/lib/media";
import { requireSession } from "@/lib/session";

// Next puffert den Body ohnehin; die harte Grenze steht in lib/media.ts und
// wird zusaetzlich hier vorab geprueft, damit eine 200-MB-Datei nicht erst
// vollstaendig verarbeitet wird, um dann abgelehnt zu werden.
export async function POST(req: Request, { params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: tenantSlug } = await params;
  const session = await requireSession(tenantSlug);
  if (!session) return NextResponse.json({ error: "nicht angemeldet" }, { status: 401 });

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
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
