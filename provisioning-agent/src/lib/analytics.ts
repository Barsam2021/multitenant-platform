import { Client as PGClient } from 'pg';
import { open, stat, rename, unlink } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';

const execFileP = promisify(execFile);

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

const ACCESS_LOG = process.env.ANALYTICS_ACCESS_LOG || '/opt/multitenant-platform/traefik/logs/access.log';
const INGEST_STATE_ID = 'traefik-access-log';
// Ueber dieser Groesse wird rotiert. 200 MB entsprechen grob 400.000 Zeilen —
// auf einer VPS mit knapper Platte ist eine unbegrenzt wachsende Logdatei das
// wahrscheinlichste Ausfallszenario der ganzen Analytics-Kette.
const ROTATE_AT_BYTES = Number(process.env.ANALYTICS_ROTATE_AT_BYTES || 200 * 1024 * 1024);
// Pro Lauf verarbeitete Bytes. Begrenzt den Speicherbedarf, wenn der Agent
// laenger stand und sich viel angesammelt hat — der Rest kommt im naechsten Lauf.
const MAX_BYTES_PER_RUN = 32 * 1024 * 1024;

function adminClient(): PGClient {
  const client = new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
  client.on('error', (err) => console.error('pg client error (analytics):', err.message));
  return client;
}

/**
 * Requests, die keine Seitenaufrufe sind. Ohne diesen Filter besteht die
 * Statistik zu ~80% aus Assets: ein einziger Next.js-Seitenaufruf erzeugt
 * Dutzende Requests auf /_next/static/*.
 */
const ASSET_PATH_RE = /\.(css|m?js|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|txt|xml|json|pdf|mp4|webm|zip)$/i;
const IGNORED_PREFIX_RE = /^\/(_next\/|__nextjs|api\/|favicon|robots\.txt|sitemap|\.well-known\/)/i;

/**
 * Bots, Crawler und die eigene Ueberwachung. Uptime Kuma pollt jede
 * Preview-Domain minuetlich (siehe lib/monitoring.ts) — ungefiltert waeren das
 * 1.440 "Besuche" pro Tag und Projekt, also mehr als jeder echte Traffic.
 */
const BOT_UA_RE = new RegExp(
  [
    'bot', 'crawl', 'spider', 'slurp', 'facebookexternalhit', 'embedly', 'quora link preview',
    'pinterest', 'bitlybot', 'skypeuripreview', 'whatsapp', 'telegrambot', 'discordbot',
    'headlesschrome', 'phantomjs', 'python-requests', 'python-urllib', 'go-http-client',
    'curl/', 'wget', 'libwww-perl', 'okhttp', 'axios/', 'node-fetch',
    'uptime', 'kuma', 'pingdom', 'statuscake', 'newrelic', 'datadog', 'monitoring',
    'ahrefs', 'semrush', 'mj12', 'dotbot', 'petalbot', 'bytespider', 'gptbot', 'claudebot',
    'ccbot', 'perplexitybot', 'applebot', 'amazonbot',
  ].join('|'),
  'i'
);

interface AccessLogLine {
  RequestHost?: string;
  RequestPath?: string;
  RequestMethod?: string;
  DownstreamStatus?: number;
  ClientHost?: string;
  // Traefik schreibt behaltene Header als request_<Name> ins JSON-Log.
  request_Cf_Connecting_Ip?: string;
  'request_Cf-Connecting-Ip'?: string;
  time?: string;
  StartUTC?: string;
  'request_User-Agent'?: string;
  'request_Referer'?: string;
}

/**
 * Ein Besucher ist sha256(Tages-Salt + IP + User-Agent + Host), gekuerzt.
 *
 * Das Salt ist pro Tag verschieden und wird aus einem Server-Secret abgeleitet:
 * ohne dieses Secret laesst sich der Hash nicht auf eine IP zurueckrechnen
 * (der Suchraum aller IPv4-Adressen waere sonst in Minuten durchprobiert), und
 * derselbe Besucher bekommt an zwei Tagen zwei verschiedene Hashes — es
 * entsteht also kein tagesuebergreifendes Profil.
 *
 * Das ist bewusst die datensparsame Variante (kein Cookie, kein
 * Wiedererkennungswert ueber Tage). Preis: "Unique Besucher" ueber einen
 * Zeitraum ist die Summe der Tageswerte, nicht die Zahl unterschiedlicher
 * Personen.
 */
const SALT_SECRET =
  process.env.ANALYTICS_SALT || process.env.ENCRYPTION_MASTER_KEY || 'analytics-fallback-salt';

const dailySaltCache = new Map<string, Buffer>();
function dailySalt(day: string): Buffer {
  let salt = dailySaltCache.get(day);
  if (!salt) {
    salt = crypto.createHmac('sha256', SALT_SECRET).update(`analytics-day:${day}`).digest();
    // Nur den aktuellen und den Vortag halten — der Cache darf nicht ueber
    // Monate mitwachsen.
    if (dailySaltCache.size > 4) dailySaltCache.clear();
    dailySaltCache.set(day, salt);
  }
  return salt;
}

export function visitorHash(day: string, ip: string, userAgent: string, host: string): string {
  return crypto
    .createHmac('sha256', dailySalt(day))
    .update(`${ip}|${userAgent}|${host}`)
    .digest('hex')
    .slice(0, 32);
}

/** "example.com:443" -> "example.com", Grossschreibung vereinheitlicht. */
export function normalizeHost(raw: string): string {
  return raw.split(':')[0].trim().toLowerCase();
}

/** Query-String weg (sonst ist jeder UTM-Link ein eigener Pfad), Laenge gekappt. */
export function normalizePath(raw: string): string {
  const path = (raw.split('?')[0] || '/').trim();
  const cleaned = path.startsWith('/') ? path : `/${path}`;
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
}

/**
 * Nur die Herkunft des Referrers, nie der volle Pfad — ein Referrer kann
 * Suchbegriffe oder interne URLs des verweisenden Systems enthalten.
 * Verweise von der eigenen Seite zaehlen nicht als Referrer.
 */
export function normalizeReferrer(raw: string | undefined, ownHost: string): string | null {
  if (!raw || raw === '-') return null;
  try {
    const url = new URL(raw);
    const host = normalizeHost(url.host);
    if (!host || host === ownHost) return null;
    return `${url.protocol}//${host}`.slice(0, 200);
  } catch {
    return null;
  }
}

function dayOf(line: AccessLogLine): string | null {
  const ts = line.time || line.StartUTC;
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

interface Aggregates {
  daily: Map<string, { projectId: string; host: string; day: string; views: number }>;
  paths: Map<string, { projectId: string; host: string; day: string; path: string; views: number }>;
  referrers: Map<string, { projectId: string; host: string; day: string; referrer: string; views: number }>;
  visitors: Map<string, { projectId: string; host: string; day: string; hash: string }>;
}

function emptyAggregates(): Aggregates {
  return { daily: new Map(), paths: new Map(), referrers: new Map(), visitors: new Map() };
}

/** hostname -> project_id. Deckt Preview- und Custom-Domains ab. */
async function loadHostMap(db: PGClient): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const { rows } = await db.query(
    `SELECT d.hostname, d.project_id FROM domains d WHERE d.project_id IS NOT NULL
     UNION
     SELECT p.preview_hostname AS hostname, p.id AS project_id FROM projects p WHERE p.preview_hostname IS NOT NULL`
  );
  for (const row of rows) {
    if (row.hostname) map.set(normalizeHost(row.hostname), row.project_id);
  }
  return map;
}

function accumulate(agg: Aggregates, hostMap: Map<string, string>, raw: string): void {
  let line: AccessLogLine;
  try {
    line = JSON.parse(raw);
  } catch {
    return; // Halbe Zeile oder Nicht-JSON-Format — ueberspringen, nie werfen.
  }

  const status = Number(line.DownstreamStatus);
  // Alles ab 400 ist kein Seitenbesuch, sondern ein Fehler oder ein Scan.
  if (!Number.isFinite(status) || status >= 400) return;
  // Nur GET: POST/PUT sind Formular- und API-Verkehr, kein Seitenaufruf.
  if ((line.RequestMethod || 'GET').toUpperCase() !== 'GET') return;

  const host = normalizeHost(line.RequestHost || '');
  const projectId = hostMap.get(host);
  if (!projectId) return; // Plattform-Hosts (webhooks., api., auth.) und Unbekanntes

  const path = normalizePath(line.RequestPath || '/');
  if (ASSET_PATH_RE.test(path) || IGNORED_PREFIX_RE.test(path)) return;

  const userAgent = line['request_User-Agent'] || '';
  if (!userAgent || BOT_UA_RE.test(userAgent)) return;

  const day = dayOf(line);
  if (!day) return;

  const dailyKey = `${projectId}|${host}|${day}`;
  const daily = agg.daily.get(dailyKey);
  if (daily) daily.views++;
  else agg.daily.set(dailyKey, { projectId, host, day, views: 1 });

  const pathKey = `${dailyKey}|${path}`;
  const pathEntry = agg.paths.get(pathKey);
  if (pathEntry) pathEntry.views++;
  else agg.paths.set(pathKey, { projectId, host, day, path, views: 1 });

  const referrer = normalizeReferrer(line['request_Referer'], host);
  if (referrer) {
    const refKey = `${dailyKey}|${referrer}`;
    const refEntry = agg.referrers.get(refKey);
    if (refEntry) refEntry.views++;
    else agg.referrers.set(refKey, { projectId, host, day, referrer, views: 1 });
  }

  // ClientHost ist die TCP-Gegenstelle — hinter Cloudflare also der Edge, nicht
  // der Besucher. Alle Anfragen bekaemen sonst eine Handvoll gemeinsamer Hashes,
  // und "eindeutige Besucher" waere die Zahl der Cloudflare-Rechenzentren.
  // Ohne Cloudflare davor fehlt der Header und ClientHost ist korrekt.
  const ip = line.request_Cf_Connecting_Ip || line['request_Cf-Connecting-Ip'] || line.ClientHost || '';
  if (ip) {
    const hash = visitorHash(day, ip, userAgent, host);
    agg.visitors.set(`${dailyKey}|${hash}`, { projectId, host, day, hash });
  }
}

async function flush(db: PGClient, agg: Aggregates): Promise<void> {
  if (agg.daily.size === 0 && agg.visitors.size === 0) return;

  await db.query('BEGIN');
  try {
    for (const e of agg.daily.values()) {
      await db.query(
        `INSERT INTO analytics_daily (project_id, hostname, day, views) VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, hostname, day) DO UPDATE SET views = analytics_daily.views + EXCLUDED.views`,
        [e.projectId, e.host, e.day, e.views]
      );
    }
    for (const e of agg.paths.values()) {
      await db.query(
        `INSERT INTO analytics_page_views (project_id, hostname, day, path, views) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (project_id, hostname, day, path) DO UPDATE SET views = analytics_page_views.views + EXCLUDED.views`,
        [e.projectId, e.host, e.day, e.path, e.views]
      );
    }
    for (const e of agg.referrers.values()) {
      await db.query(
        `INSERT INTO analytics_referrers (project_id, hostname, day, referrer, views) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (project_id, hostname, day, referrer) DO UPDATE SET views = analytics_referrers.views + EXCLUDED.views`,
        [e.projectId, e.host, e.day, e.referrer, e.views]
      );
    }
    for (const e of agg.visitors.values()) {
      await db.query(
        `INSERT INTO analytics_visitors (project_id, hostname, day, visitor_hash) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [e.projectId, e.host, e.day, e.hash]
      );
    }

    // unique_visitors nachziehen. Bewusst als COUNT ueber analytics_visitors und
    // nicht als "+1 pro neuem Hash": nur so bleibt die Zahl korrekt, wenn eine
    // Zeile schon existierte (ON CONFLICT DO NOTHING sagt nicht, ob eingefuegt
    // wurde) oder ein Lauf teilweise wiederholt wird.
    for (const e of agg.daily.values()) {
      await db.query(
        `UPDATE analytics_daily SET unique_visitors = (
           SELECT COUNT(*) FROM analytics_visitors v
           WHERE v.project_id = $1 AND v.hostname = $2 AND v.day = $3
         ) WHERE project_id = $1 AND hostname = $2 AND day = $3`,
        [e.projectId, e.host, e.day]
      );
    }
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * Rotiert den Accesslog, wenn er zu gross wird.
 *
 * Traefik oeffnet die Logdatei beim Start und haelt den Descriptor. Ein
 * blosses Umbenennen wuerde es deshalb weiter in die umbenannte Datei
 * schreiben — Traefik oeffnet sie erst auf SIGUSR1 neu (dokumentiertes
 * Verhalten). Schlaegt das Signal fehl, wird das Umbenennen wieder
 * rueckgaengig gemacht: lieber eine grosse Datei als eine, in die weiter
 * geschrieben wird, waehrend niemand sie mehr liest.
 */
async function rotateIfNeeded(sizeAfterRead: number): Promise<boolean> {
  if (sizeAfterRead < ROTATE_AT_BYTES) return false;
  const rotated = `${ACCESS_LOG}.1`;
  await rename(ACCESS_LOG, rotated);
  try {
    await execFileP('docker', ['kill', '--signal=USR1', 'global-traefik']);
  } catch (err: any) {
    console.error('Accesslog-Rotation: SIGUSR1 an Traefik fehlgeschlagen, mache rueckgaengig:', err.message);
    await rename(rotated, ACCESS_LOG).catch(() => {});
    return false;
  }
  // Alles bis sizeAfterRead ist verarbeitet; was Traefik zwischen Lesen und
  // Signal noch geschrieben hat (Bruchteil einer Sekunde), geht verloren. Das
  // ist der bewusste Preis dafuer, die Datei nicht unbegrenzt wachsen zu lassen.
  await unlink(rotated).catch(() => {});
  console.log(`Traefik-Accesslog rotiert (${Math.round(sizeAfterRead / 1024 / 1024)} MB).`);
  return true;
}

export interface IngestResult {
  linesRead: number;
  bytesRead: number;
  hostsMatched: number;
  rotated: boolean;
  skipped?: string;
}

/**
 * Liest den Accesslog ab der zuletzt gemerkten Position und schreibt die
 * Aggregate. Wird minuetlich aufgerufen (siehe index.ts) und ist so gebaut,
 * dass ein Ausfall folgenlos bleibt: der Offset wird erst NACH erfolgreichem
 * Schreiben in die DB fortgeschrieben. Ein Absturz mittendrin liest die
 * Zeilen im naechsten Lauf erneut — dann zaehlen Views doppelt, aber es fehlt
 * nichts. Die umgekehrte Reihenfolge waere schlimmer (stille Luecken).
 */
export async function ingestAccessLog(): Promise<IngestResult> {
  const db = adminClient();
  await db.connect();
  try {
    let fileStat;
    try {
      fileStat = await stat(ACCESS_LOG);
    } catch {
      // Kein Accesslog: Traefik laeuft ohne --accesslog, oder die Plattform ist
      // frisch aufgesetzt. Kein Fehler, nur nichts zu tun.
      return { linesRead: 0, bytesRead: 0, hostsMatched: 0, rotated: false, skipped: 'kein Accesslog vorhanden' };
    }

    const { rows: stateRows } = await db.query(
      'SELECT file_offset, file_signature FROM analytics_ingest_state WHERE id = $1',
      [INGEST_STATE_ID]
    );
    const signature = String(fileStat.ino);
    let offset = Number(stateRows[0]?.file_offset || 0);
    // Neue Datei (Rotation durch logrotate o.ae.) oder abgeschnitten -> von vorn.
    if (stateRows[0]?.file_signature !== signature || fileStat.size < offset) offset = 0;

    if (fileStat.size === offset) {
      await db.query(
        `INSERT INTO analytics_ingest_state (id, file_offset, file_signature, last_run_at, last_error)
         VALUES ($1, $2, $3, now(), NULL)
         ON CONFLICT (id) DO UPDATE SET file_offset = EXCLUDED.file_offset,
           file_signature = EXCLUDED.file_signature, last_run_at = now(), last_error = NULL`,
        [INGEST_STATE_ID, offset, signature]
      );
      return { linesRead: 0, bytesRead: 0, hostsMatched: 0, rotated: false };
    }

    const readUpTo = Math.min(fileStat.size, offset + MAX_BYTES_PER_RUN);
    const length = readUpTo - offset;
    const handle = await open(ACCESS_LOG, 'r');
    let chunk: Buffer;
    try {
      chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, offset);
    } finally {
      await handle.close();
    }

    // Die letzte Zeile kann angeschnitten sein (Traefik schreibt gerade). Bis
    // zum letzten vollstaendigen Zeilenumbruch verarbeiten, den Rest beim
    // naechsten Lauf.
    const text = chunk.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) {
      return { linesRead: 0, bytesRead: 0, hostsMatched: 0, rotated: false, skipped: 'keine vollstaendige Zeile' };
    }
    const complete = text.slice(0, lastNewline);
    const consumedBytes = Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8');

    const hostMap = await loadHostMap(db);
    const agg = emptyAggregates();
    let lines = 0;
    for (const raw of complete.split('\n')) {
      if (!raw) continue;
      lines++;
      accumulate(agg, hostMap, raw);
    }

    await flush(db, agg);

    const newOffset = offset + consumedBytes;
    await db.query(
      `INSERT INTO analytics_ingest_state (id, file_offset, file_signature, lines_ingested, last_run_at, last_error)
       VALUES ($1, $2, $3, $4, now(), NULL)
       ON CONFLICT (id) DO UPDATE SET file_offset = EXCLUDED.file_offset,
         file_signature = EXCLUDED.file_signature,
         lines_ingested = analytics_ingest_state.lines_ingested + EXCLUDED.lines_ingested,
         last_run_at = now(), last_error = NULL`,
      [INGEST_STATE_ID, newOffset, signature, lines]
    );

    // Rotation erst nach dem Fortschreiben des Offsets — sonst wuerde ein
    // Fehler dazwischen dazu fuehren, dass die neue (leere) Datei mit einem
    // alten, viel zu grossen Offset gelesen wird.
    let rotated = false;
    if (newOffset >= fileStat.size) {
      rotated = await rotateIfNeeded(fileStat.size);
      if (rotated) {
        await db.query(
          'UPDATE analytics_ingest_state SET file_offset = 0, file_signature = NULL WHERE id = $1',
          [INGEST_STATE_ID]
        );
      }
    }

    return { linesRead: lines, bytesRead: consumedBytes, hostsMatched: agg.daily.size, rotated };
  } catch (err: any) {
    await db
      .query(
        `INSERT INTO analytics_ingest_state (id, last_run_at, last_error) VALUES ($1, now(), $2)
         ON CONFLICT (id) DO UPDATE SET last_run_at = now(), last_error = EXCLUDED.last_error`,
        [INGEST_STATE_ID, String(err.message).slice(0, 500)]
      )
      .catch(() => {});
    throw err;
  } finally {
    await db.end().catch(() => {});
  }
}
