import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { deleteCmsUser, setCmsUserDisabled, setCmsUserPassword } from "@/lib/cmsDb";
import { logAudit } from "@/lib/audit";

const MIN_PASSWORD_LENGTH = 12;

// PATCH { password? , disabled? } — Passwort neu setzen oder Zugang sperren.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ slug: string; userId: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug, userId } = await params;
  const { password, disabled } = await req.json();
  const actor = session.user?.email || "unknown";

  if (typeof password === "string") {
    if (password.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json(
        { error: `Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen haben` },
        { status: 400 }
      );
    }
    const ok = await setCmsUserPassword(userId, slug, password);
    if (!ok) return NextResponse.json({ error: "user not found" }, { status: 404 });
    await logAudit(actor, "cms.user.password_reset", slug, { userId });
  }

  if (typeof disabled === "boolean") {
    const ok = await setCmsUserDisabled(userId, slug, disabled);
    if (!ok) return NextResponse.json({ error: "user not found" }, { status: 404 });
    await logAudit(actor, "cms.user.disabled", slug, { userId, disabled });
  }

  return NextResponse.json({ status: "ok" });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ slug: string; userId: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug, userId } = await params;
  const ok = await deleteCmsUser(userId, slug);
  if (!ok) return NextResponse.json({ error: "user not found" }, { status: 404 });
  await logAudit(session.user?.email || "unknown", "cms.user.delete", slug, { userId });
  return NextResponse.json({ status: "ok" });
}
