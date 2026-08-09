import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug } = await params;
  const { status, body } = await agentFetch(`/tenants/${slug}`, { method: "DELETE" });
  return NextResponse.json(body, { status });
}

// P2-6: Stammdaten (Name/Kontakt/Notiz/Tarif) - keine Container-/Traefik-
// Seiteneffekte, dafuer siehe /api/tenants/:slug/status.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug } = await params;
  const payload = await req.json();
  const { status, body } = await agentFetch(`/tenants/${slug}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  return NextResponse.json(body, { status });
}
