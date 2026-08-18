import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

/**
 * Sitzung eines Redakteurs.
 *
 * Bewusst kein NextAuth wie im Dashboard: dort gibt es genau einen Admin aus
 * der .env, hier gibt es beliebig viele Nutzer aus der Datenbank, jeder an
 * genau einen Tenant gebunden. Der Tenant ist der sicherheitsrelevante Teil der
 * Sitzung — er kommt ausschliesslich von hier und NIE aus der URL, sonst waere
 * ein Mandantenwechsel eine Frage des Tippens in der Adresszeile.
 */

const COOKIE_NAME = "cms_session";
const MAX_AGE_SECONDS = 8 * 60 * 60;

export interface CmsSession {
  userId: string;
  tenantSlug: string;
  email: string;
  displayName: string | null;
  role: string;
}

function secret(): Uint8Array {
  const value = process.env.CMS_SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error("CMS_SESSION_SECRET fehlt oder ist zu kurz (mindestens 32 Zeichen, siehe .env.example)");
  }
  return new TextEncoder().encode(value);
}

export async function createSession(session: CmsSession): Promise<void> {
  const token = await new SignJWT({ ...session })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secret());

  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    // In der Produktion laeuft der Dienst ausschliesslich hinter Traefik mit
    // TLS. Lokal ohne HTTPS wuerde secure:true das Cookie unbrauchbar machen.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function readSession(): Promise<CmsSession | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    if (!payload.userId || !payload.tenantSlug) return null;
    return {
      userId: String(payload.userId),
      tenantSlug: String(payload.tenantSlug),
      email: String(payload.email || ""),
      displayName: payload.displayName ? String(payload.displayName) : null,
      role: String(payload.role || "editor"),
    };
  } catch {
    // Abgelaufen oder manipuliert — beides ist "nicht angemeldet".
    return null;
  }
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

/**
 * Sitzung fuer genau diesen Tenant. Gibt null zurueck, wenn niemand angemeldet
 * ist ODER die Sitzung zu einem anderen Kunden gehoert — der zweite Fall ist
 * die eigentliche Mandantengrenze und wird an genau dieser einen Stelle
 * geprueft, damit sie nicht in jeder Route neu erfunden wird.
 */
export async function requireSession(tenantSlug: string): Promise<CmsSession | null> {
  const session = await readSession();
  if (!session) return null;
  if (session.tenantSlug !== tenantSlug) return null;
  return session;
}
