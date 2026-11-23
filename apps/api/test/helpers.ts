import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createTestDb, type TestDb } from "@kidos/db/testing";
import { buildApp } from "../src/app";
import { base32Decode, totpAt } from "../src/auth/totp";
import type { AppConfig } from "../src/config";
import { MemoryMailer, type MailMessage, type Mailer } from "../src/mailer";

export const ORIGIN = "http://localhost:3000";
export const STRONG_PASSWORD = "correct-horse-battery-9";

export const baseConfig: AppConfig = {
  env: "test",
  port: 0,
  databaseUrl: "unused-in-tests",
  allowedOrigins: [ORIGIN],
  cookieSecure: false,
  trustProxy: false,
  sessionAbsoluteHours: 24,
  sessionIdleMinutes: 60,
  authRateLimitPerMinute: 1000,
  globalRateLimitPerMinute: 10_000,
  mfaEncryptionKey: Buffer.alloc(32, 9),
  appBaseUrl: "http://localhost:3000",
  brandName: "Kidos",
  emailCooldownSeconds: 0, // most tests send repeatedly; the cooldown has its own test
  opsAlertEmail: "ops-desk@example.test",
};

export interface TestApp {
  app: FastifyInstance;
  db: TestDb;
  mailer: MemoryMailer;
  close(): Promise<void>;
}

export async function createTestApp(overrides: Partial<AppConfig> = {}, mailerOverride?: Mailer): Promise<TestApp> {
  const db = await createTestDb();
  const mailer = new MemoryMailer();
  const app = await buildApp(
    { pool: db.app, config: { ...baseConfig, ...overrides }, mailer: mailerOverride ?? mailer },
    { logger: process.env["TEST_LOG"] === "1" },
  );
  return {
    app,
    db,
    mailer,
    async close() {
      await app.close();
      await db.close();
    },
  };
}

export function sessionCookie(res: LightMyRequestResponse): string {
  const c = res.cookies.find((x) => x.name === "kidos_sid");
  if (!c) throw new Error("No session cookie in response");
  return c.value;
}

export interface CallOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  cookie?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Defaults to the allowed origin; pass null to omit the header. */
  origin?: string | null;
}

export function call(app: FastifyInstance, o: CallOptions): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.origin !== null) headers["origin"] = o.origin ?? ORIGIN;
  if (o.cookie) headers["cookie"] = `kidos_sid=${o.cookie}`;
  return app.inject({
    method: o.method ?? "GET",
    url: o.url,
    headers,
    ...(o.body !== undefined ? { payload: o.body as object } : {}),
  });
}

export async function register(
  app: FastifyInstance,
  email: string,
  displayName = "Test User",
  password = STRONG_PASSWORD,
): Promise<{ userId: string; cookie: string }> {
  const res = await call(app, { method: "POST", url: "/api/v1/auth/register", body: { email, password, displayName } });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  const body = res.json<{ user: { id: string } }>();
  return { userId: body.user.id, cookie: sessionCookie(res) };
}

/** Logs in; returns the session cookie. For MFA-enrolled users the session is pending until /auth/mfa/verify. */
export async function login(app: FastifyInstance, email: string, password = STRONG_PASSWORD): Promise<string> {
  const res = await call(app, { method: "POST", url: "/api/v1/auth/login", body: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return sessionCookie(res);
}

/** Marks an email as verified directly in the database (arrangement shortcut; the real flow has its own tests). */
export async function markEmailVerified(db: TestDb, userId: string): Promise<void> {
  await db.admin.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [userId]);
}

/** Extracts the one-time token from a message containing a link like ...?token=XYZ. */
export function tokenFrom(mail: MailMessage | undefined): string {
  const m = mail && /token=([^\s&]+)/u.exec(mail.text);
  if (!m?.[1]) throw new Error("No token in email");
  return decodeURIComponent(m[1]);
}

export interface Enrolled {
  secret: Buffer;
  recoveryCodes: string[];
}

/** Runs the real enrollment flow on a signed-in session. The session ends up MFA-verified. */
export async function enrollMfa(app: FastifyInstance, cookie: string): Promise<Enrolled> {
  const start = await call(app, { method: "POST", url: "/api/v1/auth/mfa/enroll/start", cookie });
  if (start.statusCode !== 200) throw new Error(`enroll start failed: ${start.statusCode} ${start.body}`);
  const secret = base32Decode(start.json().secret as string);
  const confirm = await call(app, {
    method: "POST",
    url: "/api/v1/auth/mfa/enroll/confirm",
    cookie,
    body: { code: totpAt(secret, Date.now()) },
  });
  if (confirm.statusCode !== 200) throw new Error(`enroll confirm failed: ${confirm.statusCode} ${confirm.body}`);
  return { secret, recoveryCodes: confirm.json().recoveryCodes as string[] };
}

export const PLATFORM_ORG = "00000000-0000-4000-8000-000000000001";
export const PLATFORM_SCOPE = { "x-platform-scope": "on" } as const;

/**
 * Creates a platform staff member holding `roleKey` in the platform organization, with a verified email and real MFA
 * (those roles require it). The returned session is fully signed in.
 */
export async function makeStaff(t: TestApp, email: string, roleKey: string): Promise<{ userId: string; cookie: string; email: string }> {
  const u = await register(t.app, email, `Staff ${roleKey}`);
  await markEmailVerified(t.db, u.userId);
  await t.db.admin.query("INSERT INTO platform_staff (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [u.userId]);
  await t.db.admin.query("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [PLATFORM_ORG, u.userId]);
  await t.db.admin.query(
    "INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = $3 AND tenant_id IS NULL",
    [PLATFORM_ORG, u.userId, roleKey],
  );
  await enrollMfa(t.app, u.cookie);
  return { ...u, email };
}

/** A member of `orgId` holding the given system role keys, signed in (with real MFA when a role requires it). */
export async function makeMember(
  t: TestApp,
  email: string,
  orgId: string,
  roleKeys: string[],
  opts: { mfa?: boolean } = {},
): Promise<{ userId: string; cookie: string; email: string }> {
  const u = await register(t.app, email, `Member ${roleKeys.join("+") || "plain"}`);
  await markEmailVerified(t.db, u.userId);
  await t.db.admin.query("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [orgId, u.userId]);
  for (const key of roleKeys) {
    await t.db.admin.query(
      "INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = $3 AND tenant_id IS NULL",
      [orgId, u.userId, key],
    );
  }
  if (opts.mfa ?? roleKeys.some((k) => ["community_admin", "community_manager", "community_staff"].includes(k))) await enrollMfa(t.app, u.cookie);
  return { ...u, email };
}

/** A code from the next 30-second step (valid via the drift window), distinct from the one used at enrollment. */
export const nextCode = (secret: Buffer, stepsAhead = 1): string => totpAt(secret, Date.now() + stepsAhead * 30_000);

/** Lets a test reuse codes by clearing replay protection (the real replay behavior has its own test). */
export async function clearReplayGuard(db: TestDb, userId: string): Promise<void> {
  await db.admin.query("UPDATE mfa_credentials SET last_used_step = 0, failed_attempts = 0, locked_until = NULL WHERE user_id = $1", [
    userId,
  ]);
}
