import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

// Status des GitHub-Push-Webhooks (Push-to-Deploy). Siehe
// provisioning-agent/src/routes/projects.ts GET /projects/:id/webhook.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const { status, body } = await agentFetch(`/projects/${id}/webhook`);
  return NextResponse.json(body, { status });
}
