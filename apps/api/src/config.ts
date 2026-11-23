import { z } from "zod";
import { parseEncryptionKey } from "./auth/crypto";

export interface AppConfig {
  env: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  allowedOrigins: string[];
  cookieSecure: boolean;
  trustProxy: boolean;
  sessionAbsoluteHours: number;
  sessionIdleMinutes: number;
  authRateLimitPerMinute: number;
  globalRateLimitPerMinute: number;
  /** AES-256 key protecting TOTP secrets at rest. */
  mfaEncryptionKey: Buffer;
  /** Public URL of the web app, used in links inside emails. */
  appBaseUrl: string;
  brandName: string;
  /** Minimum gap between emailed one-time tokens of the same kind for one account (anti mail-flooding). */
  emailCooldownSeconds: number;
  /** Where the operations desk is alerted about events only a family or vendor can trigger (a new request, a quote). Optional. */
  opsAlertEmail: string | null;
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_APP_URL: z.string().min(1),
  ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().positive().default(168),
  SESSION_IDLE_MINUTES: z.coerce.number().positive().default(1440),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  GLOBAL_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  MFA_ENCRYPTION_KEY: z.string().min(1),
  APP_BASE_URL: z.url().default("http://localhost:3000"),
  BRAND_NAME: z.string().min(1).max(60).default("Kidos"),
  EMAIL_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
  OPS_ALERT_EMAIL: z.union([z.email(), z.literal("")]).optional(),
});

/** Parses and validates environment variables; fails fast with a readable message. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const e = parsed.data;
  if (e.NODE_ENV === "production") {
    // Links in emails and cross-origin checks must not run over plain HTTP in production.
    if (!e.APP_BASE_URL.startsWith("https://")) throw new Error("Invalid configuration: APP_BASE_URL must be https in production");
    if (e.ALLOWED_ORIGINS.split(",").some((o) => o.trim() !== "" && !o.trim().startsWith("https://"))) {
      throw new Error("Invalid configuration: ALLOWED_ORIGINS must all be https in production");
    }
  }
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_APP_URL,
    allowedOrigins: e.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    cookieSecure: e.NODE_ENV === "production",
    trustProxy: e.TRUST_PROXY === "true",
    sessionAbsoluteHours: e.SESSION_ABSOLUTE_HOURS,
    sessionIdleMinutes: e.SESSION_IDLE_MINUTES,
    authRateLimitPerMinute: e.AUTH_RATE_LIMIT_PER_MINUTE,
    globalRateLimitPerMinute: e.GLOBAL_RATE_LIMIT_PER_MINUTE,
    mfaEncryptionKey: parseEncryptionKey(e.MFA_ENCRYPTION_KEY),
    appBaseUrl: e.APP_BASE_URL.replace(/\/+$/u, ""),
    brandName: e.BRAND_NAME,
    emailCooldownSeconds: e.EMAIL_COOLDOWN_SECONDS,
    opsAlertEmail: e.OPS_ALERT_EMAIL ? e.OPS_ALERT_EMAIL : null,
  };
}
