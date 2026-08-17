import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { createCmsUser, listCmsUsers } from "@/lib/cmsDb";
import { logAudit } from "@/lib/audit";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Kurze Passwörter sind hier besonders heikel: der CMS-Login ist im Internet
// erreichbar, anders als das Dashboard (Cloudflare Tunnel).
const MIN_PASSWORD_LENGTH = 12;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug } = await params;
  return NextResponse.json({ users: await listCmsUsers(slug) });
}

// POST { email, password, displayName, role } — Redakteur anlegen.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug } = await params;
  const { email, password, displayName, role } = await req.json();

  if (typeof email !== "string" || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "ungültige E-Mail-Adresse" }, { status: 400 });
  }
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen haben` },
      { status: 400 }
    );
  }

  try {
    const user = await createCmsUser(
      slug,
      email,
      password,
      typeof displayName === "string" && displayName.trim() ? displayName.trim() : null,
      role
    );
    // Passwort wird bewusst nicht geloggt — nur die Tatsache, dass es einen
    // neuen Zugang gibt.
    await logAudit(session.user?.email || "unknown", "cms.user.create", slug, { email: user.email, role: user.role });
    return NextResponse.json({ user });
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("duplicate key")) {
      return NextResponse.json({ error: "Diese E-Mail ist für den Kunden schon vergeben" }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
