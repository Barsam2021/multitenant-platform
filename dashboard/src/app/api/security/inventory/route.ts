import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function POST() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { status, body } = await agentFetch("/security/inventory", { method: "POST" });
  return NextResponse.json(body, { status });
}
