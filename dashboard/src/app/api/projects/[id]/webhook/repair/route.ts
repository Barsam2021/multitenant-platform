import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

// Webhook (neu) registrieren bzw. reaktivieren.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const { status, body } = await agentFetch(`/projects/${id}/webhook/repair`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  return NextResponse.json(body, { status });
}
