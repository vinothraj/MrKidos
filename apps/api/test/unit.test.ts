import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, parseEncryptionKey } from "../src/auth/crypto";
import { lockMinutes } from "../src/auth/lockout";
import { burnPasswordCheck, hashPassword, passwordSchema, verifyPassword } from "../src/auth/password";
import { base32Decode, base32Encode, hotp, otpauthUri, totpAt, totpStep, verifyTotp } from "../src/auth/totp";
import { loadConfig } from "../src/config";

describe("TOTP (RFC 4226 and RFC 6238 test vectors)", () => {
  const secret = Buffer.from("12345678901234567890", "ascii");

  it("matches the RFC 4226 HOTP vectors", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expected.forEach((code, counter) => expect(hotp(secret, counter)).toBe(code));
  });

  it("matches the RFC 6238 SHA-1 vectors (8 digits)", () => {
    const vectors: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
    ];
    for (const [seconds, code] of vectors) expect(totpAt(secret, seconds * 1000, 8)).toBe(code);
  });

  it("accepts the current code and one step of drift, rejects farther away", () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, totpAt(secret, now), now)).toBe(totpStep(now));
    expect(verifyTotp(secret, totpAt(secret, now - 30_000), now)).toBe(totpStep(now) - 1);
    expect(verifyTotp(secret, totpAt(secret, now + 30_000), now)).toBe(totpStep(now) + 1);
    expect(verifyTotp(secret, totpAt(secret, now - 90_000), now)).toBeNull();
    expect(verifyTotp(secret, totpAt(secret, now + 90_000), now)).toBeNull();
  });

  it("refuses to accept a step that was already used (replay protection)", () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    expect(verifyTotp(secret, totpAt(secret, now), now, step)).toBeNull();
    expect(verifyTotp(secret, totpAt(secret, now), now, step - 1)).toBe(step);
  });

  it("rejects malformed codes", () => {
    for (const bad of ["", "12345", "1234567", "abcdef", "12 456", "١٢٣٤٥٦"]) {
      expect(verifyTotp(secret, bad, 1_700_000_000_000)).toBeNull();
    }
  });

  it("round-trips base32 and builds an otpauth URI authenticator apps understand", () => {
    const bytes = Buffer.from("Hello!\xde\xad\xbe\xef", "binary");
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI"); // RFC 4648 vector
    expect(() => base32Decode("not base32 !")).toThrow();
    const uri = otpauthUri({ issuer: "Kidos", account: "a@b.test", secret });
    expect(uri).toMatch(/^otpauth:\/\/totp\/Kidos%3Aa%40b\.test\?/u);
    expect(uri).toContain("secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(uri).toContain("issuer=Kidos");
  });
});

describe("secret encryption", () => {
  const key = parseEncryptionKey(Buffer.alloc(32, 7).toString("base64"));

  it("round-trips and never contains the plaintext", () => {
    const blob = encryptSecret("JBSWY3DPEHPK3PXP", key, "user-1");
    expect(blob.startsWith("v1.")).toBe(true);
    expect(blob).not.toContain("JBSWY3DPEHPK3PXP");
    expect(decryptSecret(blob, key, "user-1")).toBe("JBSWY3DPEHPK3PXP");
  });

  it("uses a fresh nonce each time", () => {
    expect(encryptSecret("x", key, "u")).not.toBe(encryptSecret("x", key, "u"));
  });

  it("fails for another user (bound ciphertext), a wrong key, or tampering", () => {
    const blob = encryptSecret("secret", key, "user-1");
    expect(() => decryptSecret(blob, key, "user-2")).toThrow();
    expect(() => decryptSecret(blob, parseEncryptionKey(Buffer.alloc(32, 8).toString("base64")), "user-1")).toThrow();
    const parts = blob.split(".");
    parts[2] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."), key, "user-1")).toThrow();
    expect(() => decryptSecret("garbage", key, "user-1")).toThrow();
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => parseEncryptionKey(Buffer.alloc(16).toString("base64"))).toThrow(/32/);
    expect(() => parseEncryptionKey("")).toThrow();
  });
});

describe("passwords", () => {
  it("hashes with Argon2id and verifies", async () => {
    const h = await hashPassword("a-long-enough-passphrase");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(h, "a-long-enough-passphrase")).toBe(true);
    expect(await verifyPassword(h, "A-long-enough-passphrase")).toBe(false);
    expect(await verifyPassword("not-a-hash", "whatever")).toBe(false);
    await expect(burnPasswordCheck("x")).resolves.toBeUndefined();
  });

  it("enforces length and the common-password denylist", () => {
    expect(passwordSchema.safeParse("short").success).toBe(false);
    expect(passwordSchema.safeParse("x".repeat(129)).success).toBe(false);
    expect(passwordSchema.safeParse("Password12345").success).toBe(false);
    expect(passwordSchema.safeParse("a-long-enough-passphrase").success).toBe(true);
    expect(passwordSchema.safeParse("p".repeat(128)).success).toBe(true);
  });
});

describe("lockout schedule", () => {
  it("starts at 15 minutes, doubles every 5 further failures, caps at 60", () => {
    expect([5, 9, 10, 14, 15, 20, 100].map(lockMinutes)).toEqual([15, 15, 30, 30, 60, 60, 60]);
  });
});

describe("configuration", () => {
  const good = {
    DATABASE_APP_URL: "postgres://u:p@localhost:5432/db",
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  };

  it("applies safe defaults", () => {
    const c = loadConfig(good);
    expect(c.env).toBe("development");
    expect(c.cookieSecure).toBe(false);
    expect(c.trustProxy).toBe(false);
    expect(c.allowedOrigins).toEqual(["http://localhost:3000"]);
    expect(c.mfaEncryptionKey).toHaveLength(32);
  });

  const prod = { ...good, NODE_ENV: "production", APP_BASE_URL: "https://app.example.test", ALLOWED_ORIGINS: "https://app.example.test" };

  it("marks cookies secure in production", () => {
    expect(loadConfig(prod).cookieSecure).toBe(true);
  });

  it("requires https URLs and origins in production", () => {
    expect(() => loadConfig({ ...prod, APP_BASE_URL: "http://app.example.test" })).toThrow(/https/);
    expect(() => loadConfig({ ...prod, ALLOWED_ORIGINS: "https://a.test, http://b.test" })).toThrow(/https/);
    expect(loadConfig({ ...prod, ALLOWED_ORIGINS: "https://a.test, https://b.test" }).allowedOrigins).toEqual(["https://a.test", "https://b.test"]);
  });

  it("defaults the email cooldown to 60 seconds and bounds it", () => {
    expect(loadConfig(good).emailCooldownSeconds).toBe(60);
    expect(() => loadConfig({ ...good, EMAIL_COOLDOWN_SECONDS: "-1" })).toThrow(/Invalid configuration/);
    expect(() => loadConfig({ ...good, EMAIL_COOLDOWN_SECONDS: "99999" })).toThrow(/Invalid configuration/);
  });

  it("fails fast on missing or malformed settings", () => {
    expect(() => loadConfig({})).toThrow(/Invalid configuration/);
    expect(() => loadConfig({ ...good, MFA_ENCRYPTION_KEY: "short" })).toThrow(/32/);
    expect(() => loadConfig({ ...good, PORT: "abc" })).toThrow(/Invalid configuration/);
    expect(() => loadConfig({ ...good, APP_BASE_URL: "not a url" })).toThrow(/Invalid configuration/);
  });
});
