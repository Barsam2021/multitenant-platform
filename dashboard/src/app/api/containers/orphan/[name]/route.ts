import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

// Die eigentliche Pruefung, ob der Container wirklich verwaist ist, macht der
// Agent — hier steht sie bewusst NICHT nochmal, damit es nur eine Wahrheit gibt.
export async function DELETE(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { name } = await params;
  const { status, body } = await agentFetch(`/containers/orphan/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  return NextResponse.json(body, { status });
}
