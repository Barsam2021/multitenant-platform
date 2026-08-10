import { auth } from "@/auth";
import { headers } from "next/headers";

const AGENT_URL = process.env.PROVISIONING_AGENT_URL!;
const AGENT_SECRET = process.env.PROVISIONING_AGENT_SECRET!;

export async function agentFetch(path: string, init?: RequestInit) {
  // P3-2: Rate-Limiting im Agent zaehlte bisher rein nach IP - da alle Requests
  // vom Dashboard-Container kommen, war das faktisch ein einziges globales
  // Budget fuer jegliche Admin-Aktivitaet. X-Actor gibt dem Limiter einen
  // session-bezogenen Schluessel statt der immer gleichen Container-IP.
  const session = await auth().catch(() => null);
  const actor = session?.user?.email || "unknown";

  // P3-5: echte Client-IP/User-Agent gibt es nur hier, auf Höhe des
  // eingehenden Dashboard-Requests - der Agent sieht sonst nur die IP des
  // Dashboard-Containers. cf-connecting-ip kommt vom Cloudflare Tunnel.
  let ip = "";
  let userAgent = "";
  try {
    const h = await headers();
    ip = h.get("cf-connecting-ip") || h.get("x-forwarded-for") || "";
    userAgent = h.get("user-agent") || "";
  } catch {
    // headers() ist nur innerhalb eines Request-Kontexts verfuegbar - bei
    // Aufrufen ausserhalb (sollte nicht vorkommen) einfach leer lassen.
  }

  const res = await fetch(`${AGENT_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Secret": AGENT_SECRET,
      "X-Actor": actor,
      "X-Actor-Ip": ip,
      "X-Actor-Ua": userAgent,
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
