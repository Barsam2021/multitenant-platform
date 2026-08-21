import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function GET(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const scope = new URL(req.url).searchParams.get("scope");
  const { status, body } = await agentFetch(
    `/security/components${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`
  );
  return NextResponse.json(body, { status });
}
