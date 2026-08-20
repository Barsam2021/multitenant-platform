import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

/**
 * Bestand im Object Storage — die einzige Liste, die im Ernstfall zaehlt.
 *
 * /api/backups liest die `backups`-Tabelle, also das, was der Server glaubt,
 * gesichert zu haben. Nach einem Serververlust ist diese Tabelle selbst weg.
 */
export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { status, body } = await agentFetch("/backups/remote");
  return NextResponse.json(body, { status });
}
