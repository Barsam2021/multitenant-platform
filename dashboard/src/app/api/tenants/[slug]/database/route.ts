import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

// Datenbank-Ebene eines Tenants an-/abschalten (Migration 19).
// Abschalten entfernt nur die Container — die Datenbank selbst bleibt.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug } = await params;
  const { enabled } = await req.json();
  const { status, body } = await agentFetch(`/tenants/${slug}/database`, {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
  return NextResponse.json(body, { status });
}
