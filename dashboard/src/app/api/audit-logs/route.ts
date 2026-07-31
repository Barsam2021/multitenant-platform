import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { status, body } = await agentFetch("/audit-logs");
  return NextResponse.json(body, { status });
}
