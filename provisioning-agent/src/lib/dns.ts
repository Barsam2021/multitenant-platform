import dnsPromises from 'dns/promises';
import { Resolver as DnsResolver } from 'dns/promises';
import tls from 'tls';
import psl from 'psl';

const VPS_IP = process.env.VPS_PUBLIC_IP;

// Domain-Verifikation MUSS an Docker's embedded DNS (127.0.0.11) vorbei.
// Der cached Ergebnisse, und bei einem Hostname, der vorher auf einen Wildcard
// gematcht hat, liefert er minutenlang den alten Wert zurueck — die Pruefung
// scheitert dann, obwohl der Record extern laengst korrekt ist.
// Ausserdem inhaltlich richtiger: uns interessiert, was die Welt aufloest.
const PUBLIC_RESOLVERS = (process.env.DNS_RESOLVERS || '1.1.1.1,8.8.8.8,9.9.9.9')
  .split(',').map((s) => s.trim()).filter(Boolean);

function publicResolver(): DnsResolver {
  const r = new DnsResolver({ timeout: 5000, tries: 2 });
  r.setServers(PUBLIC_RESOLVERS);
  return r;
}

export interface DnsRecordInstruction {
  type: 'A' | 'CNAME';
  name: string;
  value: string;
  ttl: number;
  note?: string;
}

export interface DnsCheckResult {
  ok: boolean;
  method: 'A' | 'CNAME' | null;
  found: string[];
  expected: string;
  error: string | null;
}

/**
 * Zerlegt einen Hostnamen ueber die Public-Suffix-Liste, nicht am letzten Punkt.
 * "www.kunde-domain.co.uk" -> base "kunde-domain.co.uk", sub "www"
 */
export function splitHostname(hostname: string): { base: string; sub: string | null } | null {
  const parsed = psl.parse(hostname);
  if ('error' in parsed || !parsed.domain) return null;
  return { base: parsed.domain, sub: parsed.subdomain || null };
}

/**
 * Liefert die Records, die der Kunde bei seinem Registrar eintragen muss.
 *
 * Apex-Domains (kunde.at) koennen per DNS-Standard keinen CNAME haben -> A-Record.
 * Subdomains (www.kunde.at) bekommen wahlweise CNAME auf die Preview-Domain
 * (robuster bei IP-Wechsel) oder ebenfalls einen A-Record.
 */
export function buildInstructions(hostname: string, previewHostname: string | null): DnsRecordInstruction[] {
  const parts = splitHostname(hostname);
  const ip = VPS_IP || 'VPS_PUBLIC_IP-in-.env-nicht-gesetzt';
  const out: DnsRecordInstruction[] = [];

  if (!parts || !parts.sub) {
    out.push({
      type: 'A', name: '@', value: ip, ttl: 600,
      note: 'Apex-Domains koennen laut DNS-Standard keinen CNAME haben — hier ist ein A-Record zwingend.',
    });
  } else {
    if (previewHostname) {
      out.push({
        type: 'CNAME', name: parts.sub, value: previewHostname, ttl: 600,
        note: 'Empfohlen: bleibt auch bei einem Wechsel der Server-IP gueltig.',
      });
    }
    out.push({
      type: 'A', name: parts.sub, value: ip, ttl: 600,
      note: previewHostname ? 'Alternative, falls dein Registrar keine CNAMEs unterstuetzt.' : undefined,
    });
  }
  return out;
}

/**
 * Prueft, ob der Hostname auf diesen Server zeigt.
 *
 * Frueher nur dns.resolve4 — ein CNAME auf die Preview-Domain (der uebliche Weg
 * bei "www.") wurde dadurch NIE als gueltig erkannt. Jetzt zusaetzlich CNAME,
 * dessen Ziel aufgeloest und mit der VPS-IP verglichen wird.
 */
export async function checkDns(hostname: string): Promise<DnsCheckResult> {
  const expected = VPS_IP || '';
  if (!expected) {
    return { ok: false, method: null, found: [], expected: '',
      error: 'VPS_PUBLIC_IP ist im Agent nicht gesetzt — Verifikation nicht moeglich.' };
  }

  const resolver = publicResolver();
  let aRecords: string[] = [];
  try {
    aRecords = await resolver.resolve4(hostname);
    if (aRecords.includes(expected)) {
      return { ok: true, method: 'A', found: aRecords, expected, error: null };
    }
  } catch {
    /* kein A-Record — CNAME probieren */
  }

  try {
    const cnames = await resolver.resolveCname(hostname);
    for (const target of cnames) {
      try {
        const resolved = await resolver.resolve4(target);
        if (resolved.includes(expected)) {
          return { ok: true, method: 'CNAME', found: [`${target} -> ${resolved.join(', ')}`], expected, error: null };
        }
      } catch {
        /* CNAME-Ziel nicht aufloesbar */
      }
    }
    if (cnames.length > 0) {
      return { ok: false, method: null, found: cnames, expected,
        error: `CNAME zeigt auf ${cnames.join(', ')}, das loest nicht auf ${expected} auf.` };
    }
  } catch {
    /* kein CNAME */
  }

  if (aRecords.length > 0) {
    return { ok: false, method: null, found: aRecords, expected,
      error: `DNS zeigt auf ${aRecords.join(', ')}, erwartet wird ${expected}.` };
  }
  return { ok: false, method: null, found: [], expected,
    error: 'Kein DNS-Eintrag gefunden. Nach dem Anlegen kann die Verbreitung bis zu 24 Stunden dauern.' };
}

/**
 * Prueft per rohem TLS-Handshake, ob Traefik ein echtes Let's-Encrypt-Zertifikat
 * ausliefert statt des selbstsignierten Default-Zertifikats.
 *
 * rejectUnauthorized: false, weil wir das Zertifikat hier bewusst selbst bewerten,
 * statt der Verbindung pauschal zu vertrauen oder zu misstrauen.
 */
export async function checkTls(
  hostname: string
): Promise<{ ok: boolean; issuer: string | null; validTo: string | null }> {
  // Verbindung MUSS gegen unsere eigene IP gehen, nicht gegen das Ergebnis des
  // Container-Resolvers: liegt die Domain hinter einem CDN/Proxy, wuerde sonst
  // dessen Zertifikat geprueft und ein fremdes Edge faelschlich als Erfolg gewertet.
  const target = VPS_IP || hostname;
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: target, port: 443, servername: hostname, rejectUnauthorized: false, timeout: 5000 },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        // X.509 erlaubt mehrere CN-/O-Attribute, @types/node typisiert sie deshalb
        // als string | string[]. Wir normalisieren auf den ersten Wert.
        const rawIssuer = cert?.issuer?.CN ?? cert?.issuer?.O ?? null;
        const issuer: string | null = Array.isArray(rawIssuer)
          ? (rawIssuer[0] ?? null)
          : (rawIssuer ?? null);
        const real = Boolean(cert && Object.keys(cert).length > 0 && issuer !== 'TRAEFIK DEFAULT CERT');
        resolve({ ok: real, issuer, validTo: cert?.valid_to || null });
      }
    );
    socket.on('timeout', () => { socket.destroy(); resolve({ ok: false, issuer: null, validTo: null }); });
    socket.on('error', () => resolve({ ok: false, issuer: null, validTo: null }));
  });
}

/* ------------------------------------------------------------------ Provider */

export interface DnsProviderResult {
  attempted: boolean;
  ok: boolean;
  provider: string | null;
  reason?: string;
}

/**
 * P1-1h: frueher fest auf GoDaddy verdrahtet — obwohl die Plattform selbst auf
 * Cloudflare laeuft und typische AT-Kundendomains bei world4you/easyname/IONOS
 * liegen. Jetzt ein Interface: passt kein Provider, bleibt die manuelle Anleitung
 * der regulaere Weg (kein Fehlerzustand).
 */
interface DnsProvider {
  name: string;
  isConfigured(): boolean;
  ownsDomain(baseDomain: string): Promise<boolean>;
  setARecord(baseDomain: string, recordName: string, ip: string): Promise<DnsProviderResult>;
}

const cloudflare: DnsProvider = {
  name: 'cloudflare',
  isConfigured: () => Boolean(process.env.CF_DNS_API_TOKEN),
  async ownsDomain(baseDomain) {
    return (await cfZoneId(baseDomain)) !== null;
  },
  async setARecord(baseDomain, recordName, ip) {
    const token = process.env.CF_DNS_API_TOKEN!;
    const zoneId = await cfZoneId(baseDomain);
    if (!zoneId) return { attempted: true, ok: false, provider: 'cloudflare', reason: 'not_in_account' };

    const fqdn = recordName === '@' ? baseDomain : `${recordName}.${baseDomain}`;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    try {
      const listRes = await cfFetch(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(fqdn)}`,
        { headers }
      );
      const list = await listRes.json();
      const existing = list?.result?.[0]?.id;

      const body = JSON.stringify({ type: 'A', name: fqdn, content: ip, ttl: 600, proxied: false });
      const res = existing
        ? await cfFetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${existing}`,
            { method: 'PUT', headers, body })
        : await cfFetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
            { method: 'POST', headers, body });

      const json = await res.json();
      if (!res.ok || json?.success === false) {
        const msg = json?.errors?.[0]?.message || `HTTP ${res.status}`;
        return { attempted: true, ok: false, provider: 'cloudflare', reason: msg };
      }
      return { attempted: true, ok: true, provider: 'cloudflare' };
    } catch (err: any) {
      return { attempted: true, ok: false, provider: 'cloudflare', reason: err.message };
    }
  },
};

async function cfFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function cfZoneId(baseDomain: string): Promise<string | null> {
  const token = process.env.CF_DNS_API_TOKEN;
  if (!token) return null;
  try {
    const res = await cfFetch(
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(baseDomain)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const json = await res.json();
    return json?.result?.[0]?.id || null;
  } catch {
    return null;
  }
}

const godaddy: DnsProvider = {
  name: 'godaddy',
  isConfigured: () => Boolean(process.env.GODADDY_API_KEY && process.env.GODADDY_API_SECRET),
  async ownsDomain() { return true; }, // GoDaddy antwortet erst beim Schreiben mit 404
  async setARecord(baseDomain, recordName, ip) {
    const key = process.env.GODADDY_API_KEY!;
    const secret = process.env.GODADDY_API_SECRET!;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(
        `https://api.godaddy.com/v1/domains/${baseDomain}/records/A/${recordName}`,
        {
          method: 'PATCH',
          headers: { Authorization: `sso-key ${key}:${secret}`, 'Content-Type': 'application/json' },
          body: JSON.stringify([{ data: ip, ttl: 600 }]),
          signal: controller.signal,
        }
      );
      clearTimeout(timer);
      if (res.status === 404) return { attempted: true, ok: false, provider: 'godaddy', reason: 'not_in_account' };
      if (!res.ok) {
        const body = await res.text();
        return { attempted: true, ok: false, provider: 'godaddy', reason: `HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      return { attempted: true, ok: true, provider: 'godaddy' };
    } catch (err: any) {
      return { attempted: true, ok: false, provider: 'godaddy', reason: err.message };
    }
  },
};

const PROVIDERS: DnsProvider[] = [cloudflare, godaddy];

export function configuredProviders(): string[] {
  return PROVIDERS.filter((p) => p.isConfigured()).map((p) => p.name);
}

/**
 * Best effort: versucht den A-Record automatisch zu setzen. Ein Fehlschlag ist
 * KEIN Fehlerzustand — der Admin bekommt dann die manuelle Anleitung, die ohnehin
 * der Standardweg ist.
 */
export async function tryAutoDns(hostname: string): Promise<DnsProviderResult> {
  const ip = VPS_IP;
  if (!ip) return { attempted: false, ok: false, provider: null, reason: 'VPS_PUBLIC_IP nicht gesetzt' };

  const parts = splitHostname(hostname);
  if (!parts) return { attempted: false, ok: false, provider: null, reason: `Domain nicht parsebar: ${hostname}` };

  const recordName = parts.sub || '@';
  const reasons: string[] = [];

  for (const provider of PROVIDERS) {
    if (!provider.isConfigured()) continue;
    try {
      if (!(await provider.ownsDomain(parts.base))) {
        reasons.push(`${provider.name}: Domain nicht im Account`);
        continue;
      }
      const result = await provider.setARecord(parts.base, recordName, ip);
      if (result.ok) return result;
      reasons.push(`${provider.name}: ${result.reason}`);
    } catch (err: any) {
      reasons.push(`${provider.name}: ${err.message}`);
    }
  }

  if (reasons.length === 0) {
    return { attempted: false, ok: false, provider: null,
      reason: 'Kein DNS-Provider konfiguriert — manueller Eintrag beim Registrar noetig.' };
  }
  return { attempted: true, ok: false, provider: null, reason: reasons.join(' | ') };
}
