/**
 * Einfache Zaehlbremse pro Schluessel, im Speicher des Prozesses.
 *
 * Warum ueberhaupt: der CMS-Login steht offen im Internet und rechnet bei JEDEM
 * Versuch einen bcrypt-Hash — auch bei unbekannter Adresse, absichtlich, damit
 * die Antwortzeit nichts verraet. Genau das macht den Endpunkt aber zu einem
 * billigen Hebel: ein paar Dutzend Anfragen pro Sekunde kosten den Angreifer
 * nichts und legen die CPU des Dienstes fuer alle Kunden lahm. Die Sperre pro
 * Konto (cms_users.failed_logins) hilft dagegen nicht — sie greift erst NACH
 * dem Hashen und nur, wenn das Konto ueberhaupt existiert.
 *
 * Bewusst im Prozessspeicher und nicht in der Datenbank: eine Bremse, die pro
 * Anfrage einen Datenbank-Roundtrip kostet, ist selbst ein Angriffsziel. Der
 * Dienst laeuft als EIN Container (siehe cms/docker-compose.yml), damit gilt
 * das Limit global. Bei mehreren Instanzen waere es entsprechend lockerer —
 * dann gehoert das nach Redis, nicht in mehr Code hier.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Ohne Aufraeumen waechst die Map mit jeder je gesehenen IP. Bei jedem Aufruf
// alles durchzugehen waere O(n) pro Login — deshalb nur gelegentlich.
let lastSweep = Date.now();
const SWEEP_INTERVAL_MS = 60_000;

function sweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  /** Sekunden bis zum naechsten erlaubten Versuch — fuer Retry-After. */
  retryAfterSeconds: number;
}

/**
 * Zaehlt einen Versuch fuer `key` und sagt, ob er noch erlaubt ist.
 * Festes Zeitfenster: nach `windowMs` faengt die Zaehlung neu an.
 */
export function hit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Client-IP aus den Headern des Reverse Proxy.
 *
 * Nur cf-connecting-ip und der ERSTE Eintrag aus x-forwarded-for: alles danach
 * hat der Client selbst geschickt und kann frei erfunden sein. Ohne Header
 * bleibt "unknown" — dann teilen sich alle Anfragen ohne Proxy einen Eimer,
 * was strenger ist als noetig und damit die sichere Richtung.
 */
export function clientKey(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    "unknown"
  );
}
