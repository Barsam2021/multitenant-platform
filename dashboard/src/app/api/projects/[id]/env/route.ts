import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const { status, body } = await agentFetch(`/projects/${id}/env`);
  return NextResponse.json(body, { status });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const payload = await req.json();
  const { status, body } = await agentFetch(`/projects/${id}/env`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  return NextResponse.json(body, { status });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const { key } = await req.json();
  const { status, body } = await agentFetch(`/projects/${id}/env/${key}`, {
    method: "DELETE",
  });
  return NextResponse.json(body, { status });
}
