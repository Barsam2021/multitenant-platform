import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { listTenants } from "@/lib/adminDb";

export async function GET() {
  // Defense-in-Depth: middleware.ts schuetzt /api/tenants/* bereits, aber die
  // Session wird hier zusaetzlich im Handler geprueft. Grund: eine umgangene
  // Middleware (vgl. CVE-2025-29927) wuerde sonst direkten Datenzugriff
  // freilegen. Die Pruefung kostet nichts und darf nie wieder entfallen.
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const tenants = await listTenants();
    return NextResponse.json({ tenants });
  } catch (err) {
    console.error("Failed to list tenants:", (err as Error).message);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
