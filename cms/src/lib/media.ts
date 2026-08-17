import { Client as MinioClient } from "minio";
import sharp from "sharp";
import crypto from "crypto";

/**
 * Datei-Uploads in den MinIO-Bucket des Kunden.
 *
 * Der Upload laeuft ueber diesen Dienst, NICHT per presigned URL direkt aus dem
 * Browser: Typ, Groesse und Bildinhalt muessen geprueft werden, bevor etwas im
 * Bucket landet, und die Datei wird ohnehin angefasst (Neukodierung).
 */

const ENDPOINT = process.env.MINIO_ENDPOINT || "core-minio";
const PORT = Number(process.env.MINIO_PORT || 9000);
const USE_SSL = process.env.MINIO_USE_SSL === "true";

// Oeffentliche Basis-URL, unter der der Bucket ausgeliefert wird (Traefik-Router
// auf core-minio, siehe SETUP.md). Ohne sie kann das CMS zwar hochladen, aber
// keine verwendbare URL zurueckgeben.
const PUBLIC_BASE = (process.env.MEDIA_PUBLIC_BASE_URL || "").replace(/\/$/, "");

const MAX_FILE_BYTES = Number(process.env.CMS_MAX_UPLOAD_BYTES || 10 * 1024 * 1024);
const MAX_TENANT_BYTES = Number(process.env.CMS_MAX_STORAGE_BYTES || 2 * 1024 * 1024 * 1024);
// Alles, was hier hochgeladen wird, landet spaeter unter der Domain des Kunden.
// SVG fehlt bewusst: es darf Skript enthalten und waere damit ein XSS-Vektor,
// den der Kunde sich selbst in die eigene Seite laedt.
const ALLOWED = new Map<string, { ext: string; image: boolean }>([
  ["image/jpeg", { ext: "webp", image: true }],
  ["image/png", { ext: "webp", image: true }],
  ["image/webp", { ext: "webp", image: true }],
  ["image/avif", { ext: "webp", image: true }],
  ["image/gif", { ext: "webp", image: true }],
  ["application/pdf", { ext: "pdf", image: false }],
]);

export const MAX_UPLOAD_BYTES = MAX_FILE_BYTES;
export const MAX_STORAGE_BYTES = MAX_TENANT_BYTES;

let client: MinioClient | null = null;
function getClient(): MinioClient {
  if (!client) {
    const accessKey = process.env.MINIO_ACCESS_KEY;
    const secretKey = process.env.MINIO_SECRET_KEY;
    if (!accessKey || !secretKey) throw new Error("MINIO_ACCESS_KEY/MINIO_SECRET_KEY fehlen (siehe .env.example)");
    client = new MinioClient({ endPoint: ENDPOINT, port: PORT, useSSL: USE_SSL, accessKey, secretKey });
  }
  return client;
}

export function bucketFor(tenantSlug: string): string {
  return `kunde-${tenantSlug}-storage`;
}

/**
 * Dateityp aus dem INHALT bestimmen, nicht aus dem Content-Type des Browsers —
 * der ist frei waehlbar und damit als Pruefung wertlos.
 */
function sniffType(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP")
    return "image/webp";
  if (buffer.subarray(4, 8).toString("ascii") === "ftyp" && buffer.subarray(8, 12).toString("ascii").startsWith("avif"))
    return "image/avif";
  if (buffer.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return null;
}

function slugifyName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/\.[^.]+$/, "")
      .replace(/[äöüß]/g, (c) => ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" })[c] || c)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "datei"
  );
}

export interface UploadResult {
  objectKey: string;
  publicUrl: string;
  contentType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
}

export async function uploadFile(
  tenantSlug: string,
  file: { buffer: Buffer; originalName: string },
  usedBytes: number
): Promise<UploadResult> {
  if (!PUBLIC_BASE) {
    throw new Error(
      "MEDIA_PUBLIC_BASE_URL ist nicht gesetzt — hochgeladene Dateien hätten keine erreichbare Adresse. " +
      "Siehe SETUP.md, Abschnitt Medien-Auslieferung."
    );
  }
  if (file.buffer.length > MAX_FILE_BYTES) {
    throw new Error(`Datei ist zu groß (maximal ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB).`);
  }
  if (usedBytes + file.buffer.length > MAX_TENANT_BYTES) {
    throw new Error(
      `Speicherplatz erschöpft (${Math.round(MAX_TENANT_BYTES / 1024 / 1024)} MB). ` +
      `Nicht mehr benötigte Dateien löschen oder mehr Speicher anfragen.`
    );
  }

  const detected = sniffType(file.buffer);
  if (!detected || !ALLOWED.has(detected)) {
    throw new Error("Dateityp nicht erlaubt. Möglich sind JPEG, PNG, WebP, AVIF, GIF und PDF.");
  }
  const spec = ALLOWED.get(detected)!;

  let body = file.buffer;
  let contentType = detected;
  let width: number | null = null;
  let height: number | null = null;

  if (spec.image) {
    // Neu kodieren statt durchreichen: entfernt EXIF-Daten (inklusive
    // GPS-Koordinaten aus Handyfotos) und macht praeparierte Dateien
    // unschaedlich, weil nur noch das dekodierte Bild uebrig bleibt.
    const image = sharp(file.buffer, { animated: detected === "image/gif" });
    const meta = await image.metadata();
    width = meta.width ?? null;
    height = meta.height ?? null;
    body = await image
      .rotate() // EXIF-Orientierung anwenden, bevor sie verloren geht
      .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    contentType = "image/webp";
    const resized = await sharp(body).metadata();
    width = resized.width ?? width;
    height = resized.height ?? height;
  }

  const now = new Date();
  // Praefix "public/" ist die Grenze zwischen ausgeliefert und nicht
  // ausgeliefert: nur darauf steht die anonyme Download-Policy des Buckets.
  const objectKey =
    `public/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/` +
    `${slugifyName(file.originalName)}-${crypto.randomBytes(4).toString("hex")}.${spec.ext}`;

  await getClient().putObject(bucketFor(tenantSlug), objectKey, body, body.length, {
    "Content-Type": contentType,
    // Der Dateiname enthaelt einen Zufallsanteil, eine Datei aendert sich also
    // nie unter derselben Adresse — lange Cache-Zeit ist gefahrlos.
    "Cache-Control": "public, max-age=31536000, immutable",
  });

  return {
    objectKey,
    publicUrl: `${PUBLIC_BASE}/${bucketFor(tenantSlug)}/${objectKey}`,
    contentType,
    sizeBytes: body.length,
    width,
    height,
  };
}
