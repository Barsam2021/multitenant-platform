import { auth } from "@/auth";

const AGENT_URL = process.env.PROVISIONING_AGENT_URL!;
const AGENT_SECRET = process.env.PROVISIONING_AGENT_SECRET!;

export async function agentFetch(path: string, init?: RequestInit) {
  // P3-2: Rate-Limiting im Agent zaehlte bisher rein nach IP - da alle Requests
  // vom Dashboard-Container kommen, war das faktisch ein einziges globales
  // Budget fuer jegliche Admin-Aktivitaet. X-Actor gibt dem Limiter einen
  // session-bezogenen Schluessel statt der immer gleichen Container-IP.
  const session = await auth().catch(() => null);
  const actor = session?.user?.email || "unknown";

  const res = await fetch(`${AGENT_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Secret": AGENT_SECRET,
      "X-Actor": actor,
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
