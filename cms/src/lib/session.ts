import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { getSessionUser } from "@/lib/configDb";

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
 *
 * Zusaetzlich wird der Nutzer bei JEDEM Aufruf gegen die Datenbank geprueft.
 * Das Cookie ist acht Stunden gueltig und beweist nur, dass sich hier irgendwann
 * jemand angemeldet hat — nicht, dass es dieses Konto noch gibt. Wird ein
 * Redakteur im Dashboard geloescht oder gesperrt (oder der Tenant unter
 * demselben Kuerzel neu angelegt, was cms_users mitloescht), blieb er ohne
 * diese Pruefung bis zum Ablauf angemeldet: lesen und schreiben ging weiter,
 * und erst der Bild-Upload brach ab, weil cms_media.uploaded_by als einzige
 * Stelle auf cms_users verweist. Die Sitzung ist dann schlicht ungueltig, und
 * die Antwort darauf ist eine neue Anmeldung, keine Datenbank-Fehlermeldung.
 */
export async function requireSession(tenantSlug: string): Promise<CmsSession | null> {
  const session = await readSession();
  if (!session) return null;
  if (session.tenantSlug !== tenantSlug) return null;

  const user = await getSessionUser(tenantSlug, session.userId);
  if (!user || user.disabled) {
    await clearStaleCookie();
    return null;
  }

  // Werte aus der Datenbank statt aus dem Cookie: Name, Rolle oder Adresse
  // koennen sich seit der Anmeldung geaendert haben.
  return {
    userId: user.id,
    tenantSlug,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
  };
}

/**
 * Cookie einer ungueltig gewordenen Sitzung wegraeumen, damit der Browser nicht
 * bei jedem Aufruf erneut damit ankommt.
 *
 * Best effort: Next erlaubt das Schreiben von Cookies nur in Route Handlers und
 * Server Actions. Beim Rendern einer Seite wirft der Aufruf — das ist kein
 * Fehlerfall, die Sitzung gilt trotzdem als beendet und der Layout leitet zur
 * Anmeldung weiter.
 */
async function clearStaleCookie(): Promise<void> {
  try {
    (await cookies()).delete(COOKIE_NAME);
  } catch {
    /* beim Rendern nicht moeglich — unkritisch, siehe oben */
  }
}
