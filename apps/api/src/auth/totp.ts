import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** RFC 4648 base32 (no padding), the alphabet authenticator apps expect. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/u, "").replace(/\s+/gu, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("Invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit random secret, the size recommended by RFC 4226. */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

export const TOTP_STEP_SECONDS = 30;

export function totpStep(timeMs: number): number {
  return Math.floor(timeMs / 1000 / TOTP_STEP_SECONDS);
}

/** HOTP (RFC 4226) with HMAC-SHA1 and dynamic truncation. */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(msg).digest();
  const last = hmac[hmac.length - 1] ?? 0;
  const offset = last & 0x0f;
  const bin =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}

export function totpAt(secret: Buffer, timeMs: number, digits = 6): string {
  return hotp(secret, totpStep(timeMs), digits);
}

/**
 * Verifies a user-supplied code against the current step and one step either side (clock drift).
 * `lastUsedStep` blocks replay: a step at or below it is never accepted again.
 * Returns the matching step, or null. Every candidate is compared in constant time.
 */
export function verifyTotp(secret: Buffer, code: string, nowMs: number, lastUsedStep = 0, window = 1): number | null {
  if (!/^\d{6}$/u.test(code)) return null;
  const given = Buffer.from(code);
  const current = totpStep(nowMs);
  let matched: number | null = null;
  for (let offset = -window; offset <= window; offset++) {
    const step = current + offset;
    const expected = Buffer.from(hotp(secret, step));
    const equal = timingSafeEqual(given, expected);
    if (equal && step > lastUsedStep && matched === null) matched = step;
  }
  return matched;
}

export function otpauthUri(params: { issuer: string; account: string; secret: Buffer }): string {
  const label = encodeURIComponent(`${params.issuer}:${params.account}`);
  const q = new URLSearchParams({
    secret: base32Encode(params.secret),
    issuer: params.issuer,
    algorithm: "SHA1",
    digits: "6",
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}
