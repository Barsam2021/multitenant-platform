import psl from 'psl';

const GODADDY_API_KEY = process.env.GODADDY_API_KEY;
const GODADDY_API_SECRET = process.env.GODADDY_API_SECRET;

export interface GodaddyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Setzt automatisch einen A-Record bei GoDaddy für eine Custom-Domain.
 * "Best effort", analog zu registerGithubWebhook() in routes/projects.ts: ein
 * Fehler hier darf das Anlegen der Domain nicht blockieren, der Admin bekommt
 * dann einfach weiterhin die manuelle Anleitung angezeigt.
 *
 * Nimmt bewusst den vollen Hostnamen entgegen (nicht Basis-Domain + Subdomain
 * getrennt als zwei Parameter) und splittet ihn intern per Public-Suffix-Liste
 * (psl) — nicht naiv am letzten Punkt, sonst wäre z.B. "www.kunde-domain.co.uk"
 * falsch getrennt (Basis wäre "domain.co.uk" statt "kunde-domain.co.uk").
 */
export async function setGodaddyARecord(hostname: string, ip: string): Promise<GodaddyResult> {
  if (!GODADDY_API_KEY || !GODADDY_API_SECRET) {
    return { ok: false, reason: 'GODADDY_API_KEY/SECRET nicht gesetzt' };
  }

  const parsed = psl.parse(hostname);
  if ('error' in parsed || !parsed.domain) {
    return { ok: false, reason: `Domain konnte nicht geparst werden: ${hostname}` };
  }
  const baseDomain = parsed.domain;
  const recordName = parsed.subdomain || '@';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(
      `https://api.godaddy.com/v1/domains/${baseDomain}/records/A/${recordName}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `sso-key ${GODADDY_API_KEY}:${GODADDY_API_SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([{ data: ip, ttl: 600 }]),
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);

    if (res.status === 404) {
      return { ok: false, reason: 'not_in_godaddy_account' };
    }
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, reason: `GoDaddy API ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, reason: err.message };
  }
}
