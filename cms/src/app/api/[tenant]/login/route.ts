import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { findUser, getTenant, logCmsAudit, recordFailedLogin, recordSuccessfulLogin } from "@/lib/configDb";
import { createSession } from "@/lib/session";

// Absichtlich EINE Fehlermeldung fuer alle Fehlerfaelle: falsche Adresse,
// falsches Passwort, gesperrter Zugang, nicht existierender Kunde. Jede
// Unterscheidung waere eine Auskunft darueber, welche Konten es gibt.
const GENERIC_ERROR = "E-Mail oder Passwort ist falsch.";

function clientIp(req: Request): string | null {
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0].trim() || null;
}

export async function POST(req: Request, { params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: tenantSlug } = await params;
  const { email, password } = await req.json().catch(() => ({}));

  if (typeof email !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 400 });
  }

  const tenant = await getTenant(tenantSlug);
  if (!tenant?.cms_enabled) {
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  const user = await findUser(tenantSlug, email);
  if (!user) {
    // Trotzdem hashen: ohne das ist die Antwortzeit bei unbekannter Adresse
    // messbar kuerzer, und damit waere die Existenz eines Kontos ablesbar.
    await bcrypt.compare(password, "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin");
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  if (user.disabled) return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return NextResponse.json(
      { error: "Zu viele Fehlversuche. Bitte in einigen Minuten erneut versuchen." },
      { status: 429 }
    );
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    await recordFailedLogin(user.id);
    await logCmsAudit({
      tenantSlug,
      userId: user.id,
      userEmail: user.email,
      action: "login.failed",
      ip: clientIp(req),
    });
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  await recordSuccessfulLogin(user.id);
  await createSession({
    userId: user.id,
    tenantSlug,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
  });
  await logCmsAudit({
    tenantSlug,
    userId: user.id,
    userEmail: user.email,
    action: "login.success",
    ip: clientIp(req),
  });

  return NextResponse.json({ status: "ok" });
}
