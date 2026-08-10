/**
 * Alarmkanal ueber Resend. Audit §15: "Kein Alerting-Kanal aus dem Code heraus.
 * RESEND_API_KEY ist ueberall verfuegbar und wird fuer nichts ausser
 * GoTrue-Mails benutzt."
 *
 * Bewusst best-effort: ein fehlgeschlagener Alarm darf niemals den Aufrufer
 * mitreissen. Wer hier throwt, killt genau den Prozess, dessen Absturz er
 * melden soll.
 *
 * Dedupliziert ueber ein Zeitfenster, damit ein flappender Fehler nicht das
 * Postfach flutet und dadurch alle Alarme unbrauchbar macht.
 */
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN || 'example.com';

const DEDUPE_WINDOW_MS = 15 * 60 * 1000;
const lastSent = new Map<string, number>();

export async function alert(subject: string, body: string, dedupeKey?: string): Promise<void> {
  const key = dedupeKey || subject;
  const now = Date.now();
  const previous = lastSent.get(key);
  if (previous && now - previous < DEDUPE_WINDOW_MS) return;
  lastSent.set(key, now);

  console.error(`[ALERT] ${subject}\n${body}`);

  if (!RESEND_API_KEY || !ADMIN_EMAIL) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `alerts@${PLATFORM_DOMAIN}`,
        to: [ADMIN_EMAIL],
        subject: `[Plattform] ${subject}`,
        text: body,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: any) {
    console.error('Alarm-Versand fehlgeschlagen:', err?.message);
  }
}
