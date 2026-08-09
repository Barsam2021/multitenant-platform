import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { listSavedQueries, saveQuery } from "@/lib/adminDb";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug } = await params;
  try {
    const queries = await listSavedQueries(slug);
    return NextResponse.json({ queries });
  } catch (err) {
    console.error("Failed to list saved queries:", (err as Error).message);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug } = await params;
  const { name, sql } = await req.json();
  if (!name || typeof name !== "string" || !sql || typeof sql !== "string") {
    return NextResponse.json({ error: "name und sql erforderlich" }, { status: 400 });
  }

  try {
    const query = await saveQuery(slug, name, sql);
    return NextResponse.json({ query }, { status: 201 });
  } catch (err) {
    console.error("Failed to save query:", (err as Error).message);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
