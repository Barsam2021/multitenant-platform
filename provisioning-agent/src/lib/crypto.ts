import crypto from 'crypto';

// ENCRYPTION_MASTER_KEY: 256-bit (32 byte) key, hex-encoded, aus .env (siehe .env.example)
// NIEMALS in der DB speichern, NIEMALS loggen.
const MASTER_KEY_HEX = process.env.ENCRYPTION_MASTER_KEY;

function getKey(): Buffer {
  if (!MASTER_KEY_HEX || MASTER_KEY_HEX.length !== 64) {
    throw new Error('ENCRYPTION_MASTER_KEY fehlt oder hat falsche Länge (muss 64 hex chars / 32 bytes sein)');
  }
  return Buffer.from(MASTER_KEY_HEX, 'hex');
}

/**
 * Verschlüsselt einen Klartext-String mit AES-256-GCM.
 * Rückgabeformat (Buffer, direkt in BYTEA-Spalte speicherbar): [12 byte IV][16 byte authTag][ciphertext]
 */
export function encrypt(plaintext: string): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

/**
 * Entschlüsselt einen Buffer, der mit encrypt() erzeugt wurde.
 *
 * P3-5: Laengenpruefung vorweg. Ohne sie erzeugt ein zu kurzes oder korruptes
 * BYTEA eine unspezifische "Unsupported state or unable to authenticate data"-
 * Meldung, aus der niemand ableiten kann, dass die Spalte defekt ist.
 */
export function decrypt(payload: Buffer): string {
  if (!Buffer.isBuffer(payload) || payload.length < 29) {
    throw new Error(
      `Verschluesselter Wert ist zu kurz (${payload?.length ?? 0} bytes, mindestens 29 erwartet: ` +
      `12 IV + 16 authTag + >=1 ciphertext). Spalte korrupt oder mit einem anderen Format geschrieben.`
    );
  }
  const iv = payload.subarray(0, 12);
  const authTag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Maskiert Secrets in Log-/Build-Output, bevor er in `deployments.build_log`
 * geschrieben oder in die Console geloggt wird.
 *
 * P0-4 (Audit 0430f9c): Die alte Version filterte AUSSCHLIESSLICH nach sechs
 * Variablennamen (JWT_SECRET|PASSWORD|API_KEY|SECRET_KEY|TOKEN|WEBHOOK_SECRET).
 * SUPABASE_SERVICE_ROLE_KEY enthaelt keines davon — der Key mit BYPASSRLS ging
 * unmaskiert in `deployments.build_log`, wo ihn das Dashboard unter
 * "Build-Log anzeigen" rendert. Ebenso `DATABASE_URL=postgres://user:pw@host/db`
 * (das alte Muster verlangte `PASSWORD=`).
 *
 * Zwei Schichten, weil jede allein Luecken hat:
 *   1) Namensmuster, jetzt mit Wildcards um die Kernbegriffe herum, damit
 *      SUPABASE_SERVICE_ROLE_KEY, ANON_KEY, MINIO_SECRET_KEY usw. mitgreifen.
 *   2) Die KONKRETEN Werte. Nur die schuetzen vor der naechsten Env-Var, die
 *      niemand im Muster bedacht hat — der Aufrufer kennt sie ohnehin
 *      (deploy.ts hat envVars in der Hand).
 *
 * Warum ueberhaupt noch Schicht 1: der Wert eines Secrets, das nur der
 * Kindprozess kennt (z.B. ein Token in einem npm-Fehler), taucht nicht in der
 * uebergebenen Liste auf.
 */
const SECRET_NAME_PATTERN =
  /\b([A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|PWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|TOKEN|_KEY|KEY_)[A-Z0-9_]*)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi;

// postgres://user:passwort@host  /  redis://user:pw@host  /  https://user:pw@host
const URL_CREDENTIALS_PATTERN = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@/]+)@/gi;

export function maskSecrets(input: string, secretValues: string[] = []): string {
  if (!input) return input;
  let out = input.replace(SECRET_NAME_PATTERN, '$1=***');
  out = out.replace(URL_CREDENTIALS_PATTERN, '$1:***@');

  // Schicht 2: konkrete Werte. Absteigend nach Laenge, damit ein laengeres
  // Secret nicht durch die Maskierung eines darin enthaltenen kuerzeren
  // zerhackt wird und dadurch teilweise sichtbar bleibt.
  const values = secretValues
    .filter((v): v is string => typeof v === 'string' && v.length >= 8)
    .sort((a, b) => b.length - a.length);
  for (const v of values) {
    out = out.split(v).join('***');
  }
  return out;
}
