import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { deleteSavedQuery } from "@/lib/adminDb";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug, id } = await params;
  try {
    await deleteSavedQuery(id, slug);
    return NextResponse.json({ status: "ok" });
  } catch (err) {
    console.error("Failed to delete saved query:", (err as Error).message);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
