import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json();
  const { status, body: result } = await agentFetch("/tenants", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return NextResponse.json(result, { status });
}
