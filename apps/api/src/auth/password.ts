import { hash, verify } from "@node-rs/argon2";
import { z } from "zod";

/** Argon2id (the library default) with OWASP minimum cost parameters. Tune upward on production hardware. */
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (plain: string): Promise<string> => hash(plain, OPTIONS);

export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain);
  } catch {
    return false; // malformed stored hash must never authenticate
  }
}

let dummyHash: Promise<string> | undefined;
/**
 * Verifies against a throwaway hash so unknown-account logins cost the same time as known-account failures.
 */
export async function burnPasswordCheck(plain: string): Promise<void> {
  dummyHash ??= hashPassword("timing-equalizer-not-a-real-password");
  await verifyPassword(await dummyHash, plain);
}

const COMMON_PASSWORDS = new Set([
  "password1234", "123456789012", "qwertyuiop12", "iloveyou1234", "password12345", "administrator",
  "letmein123456", "welcome12345", "changeme1234", "1234567890123",
]);

export const passwordSchema = z
  .string()
  .min(12, "Use at least 12 characters.")
  .max(128, "Use at most 128 characters.")
  .refine((p) => !COMMON_PASSWORDS.has(p.toLowerCase()), "This password is too common.");
