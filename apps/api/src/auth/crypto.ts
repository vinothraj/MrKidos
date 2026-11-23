import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

/** Parses a base64 AES-256 key; throws unless it is exactly 32 bytes. */
export function parseEncryptionKey(b64: string): Buffer {
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    throw new Error("MFA_ENCRYPTION_KEY must be 32 random bytes, base64-encoded (e.g. `openssl rand -base64 32`).");
  }
  return key;
}

/**
 * AES-256-GCM. `aad` (here: the owning user id) is authenticated but not stored, so a ciphertext copied to another
 * user's row fails to decrypt. Output format: v1.<iv>.<ciphertext>.<tag> (base64url).
 */
export function encryptSecret(plain: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), ct.toString("base64url"), tag.toString("base64url")].join(".");
}

export function decryptSecret(blob: string, key: Buffer, aad: string): string {
  const [version, iv, ct, tag] = blob.split(".");
  if (version !== VERSION || !iv || !ct || !tag) throw new Error("Unsupported ciphertext format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}
