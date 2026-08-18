import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

// Eigener Endpunkt statt Teil von /stats/overview: du/mc dauern deutlich
// laenger als der Rest, und die Uebersicht pollt alle 30 Sekunden.
export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { status, body } = await agentFetch("/stats/storage");
  return NextResponse.json(body, { status });
}
