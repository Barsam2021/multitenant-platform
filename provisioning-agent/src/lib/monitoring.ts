import { io, Socket } from 'socket.io-client';

// Uptime Kuma bietet KEIN offizielles/dokumentiertes REST-API zum Anlegen von Monitoren —
// nur die interne Socket.IO-Schnittstelle, die auch das eigene Web-UI nutzt (login -> add ->
// deleteMonitor, alles mit Ack-Callback). Das ist deshalb bewusst gegen die gepinnte
// uptime-kuma-Version (v2.4.0, siehe monitoring/uptime-kuma/docker-compose.yml) geschrieben —
// ein Major-Update von Kuma kann dieses Protokoll potenziell brechen, dann muss hier
// nachgezogen werden. Kein offiziell unterstützter Ersatz existiert Stand jetzt.
const KUMA_URL = process.env.UPTIME_KUMA_URL; // z.B. http://uptime-kuma:3001 (internes Docker-Netz)
const KUMA_USER = process.env.UPTIME_KUMA_USERNAME;
const KUMA_PASS = process.env.UPTIME_KUMA_PASSWORD;

const CONNECT_TIMEOUT_MS = 8000;

function isConfigured(): boolean {
  return !!(KUMA_URL && KUMA_USER && KUMA_PASS);
}

async function withKumaSocket<T>(fn: (socket: Socket) => Promise<T>): Promise<T> {
  if (!isConfigured()) {
    throw new Error('UPTIME_KUMA_URL/USERNAME/PASSWORD nicht vollständig gesetzt');
  }

  const socket = io(KUMA_URL!, {
    // WICHTIG: NICHT auf transports: ['websocket'] einschränken — Engine.IO/Socket.IO
    // braucht standardmäßig zuerst einen HTTP-Polling-Handshake (Session-ID), bevor es auf
    // WebSocket hochstuft. Erzwungenes reines WebSocket überspringt diesen Handshake und
    // schlägt mit "websocket error" fehl (genau der Fehler, den der Smoke-Test zeigte).
    reconnection: false,
    timeout: CONNECT_TIMEOUT_MS,
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Uptime-Kuma: Verbindungs-Timeout')), CONNECT_TIMEOUT_MS);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    await new Promise<void>((resolve, reject) => {
      socket.emit('login', { username: KUMA_USER, password: KUMA_PASS, token: '' }, (res: any) => {
        if (res?.ok) resolve();
        else reject(new Error(res?.msg || 'Uptime-Kuma-Login fehlgeschlagen'));
      });
    });

    return await fn(socket);
  } finally {
    socket.disconnect();
  }
}

/**
 * Legt einen HTTP-Monitor an (60s-Intervall, 3 Retries). Gibt die Kuma-interne
 * monitorID zurück, die in projects.kuma_monitor_id gespeichert wird.
 *
 * Wird NICHT als Bedingung für Erfolg der aufrufenden Route behandelt — analog zu
 * registerGithubWebhook() in routes/projects.ts: Monitoring ist "best effort",
 * ein Kuma-Ausfall darf kein Projekt-Anlegen/Deployment blockieren.
 */
export async function createHttpMonitor(name: string, url: string): Promise<number> {
  return withKumaSocket(
    (socket) =>
      new Promise<number>((resolve, reject) => {
        socket.emit(
          'add',
          {
            type: 'http',
            name,
            url,
            method: 'GET',
            interval: 60,
            retryInterval: 60,
            maxretries: 3,
            resendInterval: 0,
            active: true,
            upsideDown: false,
            accepted_statuscodes: ['200-299'],
            notificationIDList: {},
            conditions: [],
          },
          (res: any) => {
            if (res?.ok && res?.monitorID) resolve(res.monitorID as number);
            else reject(new Error(res?.msg || 'Monitor anlegen fehlgeschlagen'));
          }
        );
      })
  );
}

export async function deleteMonitor(monitorId: number): Promise<void> {
  await withKumaSocket(
    (socket) =>
      new Promise<void>((resolve, reject) => {
        socket.emit('deleteMonitor', monitorId, (res: any) => {
          if (res?.ok) resolve();
          else reject(new Error(res?.msg || 'Monitor löschen fehlgeschlagen'));
        });
      })
  );
}

export { isConfigured as isMonitoringConfigured };
