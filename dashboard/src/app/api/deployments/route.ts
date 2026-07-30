import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await req.json();
  const { status, body } = await agentFetch("/deployments", {
    method: "POST",
    body: JSON.stringify({ ...payload, triggeredBy: "manual" }),
  });
  return NextResponse.json(body, { status });
}
