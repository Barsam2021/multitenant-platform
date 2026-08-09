import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const url = new URL(req.url);
  const logOffset = url.searchParams.get("logOffset");
  const qs = logOffset !== null ? `?logOffset=${encodeURIComponent(logOffset)}` : "";
  const { status, body } = await agentFetch(`/deployments/single/${id}${qs}`);
  return NextResponse.json(body, { status });
}
