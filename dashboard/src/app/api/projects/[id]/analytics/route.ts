import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

// Besucherstatistik eines Projekts. Siehe
// provisioning-agent/src/routes/analytics.ts GET /analytics/:projectId.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const url = new URL(req.url);
  const days = url.searchParams.get("days") || "30";
  const host = url.searchParams.get("host");
  const query = new URLSearchParams({ days });
  if (host) query.set("host", host);

  const { status, body } = await agentFetch(`/analytics/${id}?${query.toString()}`);
  return NextResponse.json(body, { status });
}
