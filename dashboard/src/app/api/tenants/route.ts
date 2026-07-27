import { NextResponse } from "next/server";
import { listTenants } from "@/lib/adminDb";

export async function GET() {
  try {
    const tenants = await listTenants();
    return NextResponse.json({ tenants });
  } catch (err) {
    console.error("Failed to list tenants:", (err as Error).message);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
