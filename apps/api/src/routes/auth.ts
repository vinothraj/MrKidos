import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { withContext } from "@kidos/db";
import { z } from "zod";
import { emailFingerprint, writeAudit } from "../audit";
import { lockMinutes, MAX_FAILED_ATTEMPTS } from "../auth/lockout";
import { burnPasswordCheck, hashPassword, passwordSchema, verifyPassword } from "../auth/password";
import { createSession, newSessionToken, SESSION_COOKIE } from "../auth/session";
import { issueToken } from "../auth/tokens";
import { verificationEmail } from "../emails";
import { AppError, isUniqueViolation } from "../errors";
import { makeAuthenticate } from "../guards";
import { trySend } from "../mailer";
import type { Deps } from "../types";

export const emailSchema = z.email().max(254).transform((e) => e.trim().toLowerCase());

const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    displayName: z.string().trim().min(1).max(100),
  })
  .strict();

const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict();

export const VERIFICATION_TTL_MINUTES = 24 * 60;

export function makeSessionCookieSetter({ config }: Deps) {
  return function setSessionCookie(reply: FastifyReply, token: string): void {
    void reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      maxAge: Math.floor(config.sessionAbsoluteHours * 3600),
    });
  };
}

export async function authRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool, config, mailer } = deps;
  const authenticatePendingOk = makeAuthenticate(deps, { allowMfaPending: true });
  const rateLimit = { rateLimit: { max: config.authRateLimitPerMinute, timeWindow: "1 minute" } };
  const setSessionCookie = makeSessionCookieSetter(deps);

  app.post("/auth/register", { config: rateLimit }, async (req, reply) => {
    const body = registerSchema.parse(req.body);
    const userId = randomUUID();
    const passwordHash = await hashPassword(body.password);
    const token = newSessionToken();
    let verificationToken: string;
    try {
      verificationToken = await withContext(pool, { userId }, async (c) => {
        await c.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)", [
          userId,
          body.email,
          body.displayName,
        ]);
        await c.query("INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)", [userId, passwordHash]);
        await createSession(c, { userId, token, ip: req.ip, userAgent: req.headers["user-agent"] }, config);
        const vt = await issueToken(c, { userId, purpose: "email_verification", ttlMinutes: VERIFICATION_TTL_MINUTES });
        await writeAudit(c, { actorUserId: userId, action: "auth.register", entityType: "user", entityId: userId, requestId: req.id });
        return vt;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, "email_taken", "An account with this email already exists.");
      throw err;
    }
    await trySend(mailer, verificationEmail(config, body.email, verificationToken), req.log);
    setSessionCookie(reply, token);
    return reply.code(201).send({ user: { id: userId, email: body.email, displayName: body.displayName, emailVerified: false } });
  });

  app.post("/auth/login", { config: rateLimit }, async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const invalid = () => new AppError(401, "invalid_credentials", "Email or password is incorrect.");

    const user = await withContext(pool, { loginEmail: body.email }, async (c) => {
      const { rows } = await c.query<{ id: string; status: string }>(
        "SELECT id, status FROM users WHERE lower(email) = $1 AND deleted_at IS NULL",
        [body.email],
      );
      return rows[0];
    });

    if (!user || user.status !== "active") {
      await burnPasswordCheck(body.password);
      await withContext(pool, {}, (c) =>
        writeAudit(c, { action: "auth.login_failed", metadata: { reason: "unknown_or_inactive", emailRef: emailFingerprint(body.email) }, requestId: req.id }),
      );
      throw invalid();
    }

    const token = newSessionToken();
    const outcome = await withContext(pool, { userId: user.id }, async (c) => {
      const { rows } = await c.query<{ password_hash: string; failed_attempts: number; locked: boolean }>(
        `SELECT password_hash, failed_attempts, (locked_until IS NOT NULL AND locked_until > now()) AS locked
           FROM user_credentials WHERE user_id = $1 FOR UPDATE`,
        [user.id],
      );
      const cred = rows[0];
      if (!cred) return { result: "invalid" as const };
      if (cred.locked) {
        await writeAudit(c, { actorUserId: user.id, action: "auth.login_blocked", metadata: { reason: "locked" }, requestId: req.id });
        return { result: "locked" as const };
      }
      if (!(await verifyPassword(cred.password_hash, body.password))) {
        const attempts = cred.failed_attempts + 1;
        const lock = attempts >= MAX_FAILED_ATTEMPTS;
        await c.query(
          `UPDATE user_credentials
              SET failed_attempts = $2,
                  locked_until = CASE WHEN $3::boolean THEN now() + ($4::double precision * interval '1 minute') ELSE locked_until END
            WHERE user_id = $1`,
          [user.id, attempts, lock, lock ? lockMinutes(attempts) : 0],
        );
        await writeAudit(c, { actorUserId: user.id, action: "auth.login_failed", metadata: { reason: "bad_password", attempts, locked: lock }, requestId: req.id });
        return { result: "invalid" as const };
      }
      await c.query("UPDATE user_credentials SET failed_attempts = 0, locked_until = NULL WHERE user_id = $1", [user.id]);
      const mfa = await c.query("SELECT 1 FROM mfa_credentials WHERE user_id = $1 AND confirmed_at IS NOT NULL", [user.id]);
      const mfaRequired = (mfa.rowCount ?? 0) > 0;
      await createSession(c, { userId: user.id, token, ip: req.ip, userAgent: req.headers["user-agent"], mfaRequired }, config);
      await writeAudit(c, {
        actorUserId: user.id,
        action: mfaRequired ? "auth.login_password_ok" : "auth.login",
        entityType: "user",
        entityId: user.id,
        metadata: { mfaRequired },
        requestId: req.id,
      });
      return { result: "ok" as const, mfaRequired };
    });

    if (outcome.result === "locked") {
      throw new AppError(429, "too_many_attempts", "Too many failed attempts. Try again later.");
    }
    if (outcome.result !== "ok") throw invalid();

    setSessionCookie(reply, token);
    return reply.send({ ok: true, mfaRequired: outcome.mfaRequired });
  });

  app.post("/auth/logout", async (req, reply) => {
    await authenticatePendingOk(req, reply);
    const auth = req.auth;
    if (!auth) throw new AppError(401, "unauthenticated", "Authentication is required.");
    await withContext(pool, { userId: auth.userId }, async (c) => {
      await c.query("UPDATE sessions SET revoked_at = now() WHERE id = $1", [auth.sessionId]);
      await writeAudit(c, { actorUserId: auth.userId, action: "auth.logout", requestId: req.id });
    });
    void reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });
}
