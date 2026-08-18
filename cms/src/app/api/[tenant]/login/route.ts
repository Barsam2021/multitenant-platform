import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { findUser, getTenant, logCmsAudit, recordFailedLogin, recordSuccessfulLogin } from "@/lib/configDb";
import { createSession } from "@/lib/session";
import { clientKey, hit } from "@/lib/rateLimit";

// Absichtlich EINE Fehlermeldung fuer alle Fehlerfaelle: falsche Adresse,
// falsches Passwort, gesperrter Zugang, nicht existierender Kunde. Jede
// Unterscheidung waere eine Auskunft darueber, welche Konten es gibt.
const GENERIC_ERROR = "E-Mail oder Passwort ist falsch.";

// 10 Versuche pro IP und Minute. Ein Mensch, der sich vertippt, merkt davon
// nichts; ein Skript, das eine Passwortliste durchprobiert, kommt damit auf
// 600 Versuche pro Stunde statt auf Zehntausende. Zusaetzlich zur Sperre pro
// Konto, nicht statt ihr: die eine bremst den Angriff auf EIN Konto, diese den
// Angriff ueber viele Konten hinweg und die Last, die er erzeugt.
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 60_000;

function clientIp(req: Request): string | null {
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0].trim() || null;
}

export async function POST(req: Request, { params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: tenantSlug } = await params;

  // VOR dem Lesen des Bodys und vor jedem bcrypt-Aufruf: die Bremse ist nur
  // etwas wert, wenn sie vor der teuren Arbeit greift.
  const limited = hit(`login:${tenantSlug}:${clientKey(req)}`, LOGIN_LIMIT, LOGIN_WINDOW_MS);
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "Zu viele Anmeldeversuche. Bitte kurz warten." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } }
    );
  }

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
