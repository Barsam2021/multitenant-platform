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
 */
export function decrypt(payload: Buffer): string {
  const iv = payload.subarray(0, 12);
  const authTag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Maskiert Secret-Patterns in Log-/Build-Output, bevor er in `deployments.build_log` geschrieben
 * oder in die Console geloggt wird. Siehe CLAUDE.md § 1.5.
 */
export function maskSecrets(input: string): string {
  return input.replace(
    /(JWT_SECRET|PASSWORD|API_KEY|SECRET_KEY|TOKEN|WEBHOOK_SECRET)=\S+/gi,
    '$1=***'
  );
}
