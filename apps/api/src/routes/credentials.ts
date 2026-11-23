import type { FastifyInstance } from "fastify";
import { assumeUser, withContext } from "@kidos/db";
import { z } from "zod";
import { writeAudit } from "../audit";
import { hashPassword, passwordSchema } from "../auth/password";
import { checkCurrentPassword } from "../auth/password-check";
import { consumeToken, hashToken, issueTokenUnlessRecent } from "../auth/tokens";
import { passwordResetEmail, verificationEmail } from "../emails";
import { AppError } from "../errors";
import { makeAuthenticate } from "../guards";
import { trySend } from "../mailer";
import type { Deps } from "../types";
import { emailSchema, VERIFICATION_TTL_MINUTES } from "./auth";

const RESET_TTL_MINUTES = 60;
const tokenSchema = z.string().min(20).max(100);

const verifyBody = z.object({ token: tokenSchema }).strict();
const forgotBody = z.object({ email: emailSchema }).strict();
const resetBody = z.object({ token: tokenSchema, password: passwordSchema }).strict();
const changeBody = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema }).strict();

const invalidToken = () => new AppError(400, "invalid_token", "This link is invalid or has expired.");

export async function credentialRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool, config, mailer } = deps;
  const authenticate = makeAuthenticate(deps);
  const rateLimit = { rateLimit: { max: config.authRateLimitPerMinute, timeWindow: "1 minute" } };

  // ---- Email verification -------------------------------------------------------------------------------------

  app.post("/auth/email/verify", { config: rateLimit }, async (req, reply) => {
    const { token } = verifyBody.parse(req.body);
    const ok = await withContext(pool, { tokenHash: hashToken(token) }, async (c) => {
      const userId = await consumeToken(c, token, "email_verification");
      if (!userId) return false;
      await assumeUser(c, userId); // possession of the token has just proven control of the mailbox
      await c.query("UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1", [userId]);
      await writeAudit(c, { actorUserId: userId, action: "auth.email_verified", entityType: "user", entityId: userId, requestId: req.id });
      return true;
    });
    if (!ok) throw invalidToken();
    return reply.code(204).send();
  });

  app.post("/auth/email/resend", { config: rateLimit, preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "unauthenticated", "Authentication is required.");
    if (!auth.emailVerified) {
      const token = await withContext(pool, { userId: auth.userId }, async (c) => {
        const t = await issueTokenUnlessRecent(c, {
          userId: auth.userId,
          purpose: "email_verification",
          ttlMinutes: VERIFICATION_TTL_MINUTES,
          cooldownSeconds: config.emailCooldownSeconds,
        });
        if (t) await writeAudit(c, { actorUserId: auth.userId, action: "auth.email_verification_sent", requestId: req.id });
        return t;
      });
      if (token) await trySend(mailer, verificationEmail(config, auth.email, token), req.log);
    }
    return reply.code(204).send(); // identical whether or not it was already verified or throttled
  });

  // ---- Password reset (forgotten password) ----------------------------------------------------------------------

  app.post("/auth/password/forgot", { config: rateLimit }, async (req, reply) => {
    const { email } = forgotBody.parse(req.body);
    const user = await withContext(pool, { loginEmail: email }, async (c) => {
      const { rows } = await c.query<{ id: string; status: string }>(
        "SELECT id, status FROM users WHERE lower(email) = $1 AND deleted_at IS NULL",
        [email],
      );
      return rows[0];
    });
    if (user && user.status === "active") {
      const token = await withContext(pool, { userId: user.id }, async (c) => {
        const t = await issueTokenUnlessRecent(c, {
          userId: user.id,
          purpose: "password_reset",
          ttlMinutes: RESET_TTL_MINUTES,
          cooldownSeconds: config.emailCooldownSeconds,
        });
        await writeAudit(c, {
          actorUserId: user.id,
          action: t ? "auth.password_reset_requested" : "auth.password_reset_throttled",
          requestId: req.id,
        });
        return t;
      });
      if (token) await trySend(mailer, passwordResetEmail(config, email, token), req.log);
    }
    // Same response whether or not the account exists, so this cannot be used to discover registered emails.
    return reply.code(202).send({ ok: true });
  });

  app.post("/auth/password/reset", { config: rateLimit }, async (req, reply) => {
    const body = resetBody.parse(req.body);
    const newHash = await hashPassword(body.password);
    const ok = await withContext(pool, { tokenHash: hashToken(body.token) }, async (c) => {
      const userId = await consumeToken(c, body.token, "password_reset");
      if (!userId) return false;
      await assumeUser(c, userId);
      await c.query(
        `UPDATE user_credentials
            SET password_hash = $2, password_changed_at = now(), failed_attempts = 0, locked_until = NULL
          WHERE user_id = $1`,
        [userId, newHash],
      );
      // A reset signs the user out everywhere. MFA, if enrolled, still applies at the next login.
      await c.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
      await writeAudit(c, { actorUserId: userId, action: "auth.password_reset", entityType: "user", entityId: userId, requestId: req.id });
      return true;
    });
    if (!ok) throw invalidToken();
    return reply.code(204).send();
  });

  // ---- Password change (signed in) -------------------------------------------------------------------------------

  app.post("/auth/password/change", { config: rateLimit, preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "unauthenticated", "Authentication is required.");
    const body = changeBody.parse(req.body);
    const newHash = await hashPassword(body.newPassword);

    const outcome = await withContext(pool, { userId: auth.userId }, async (c) => {
      const check = await checkCurrentPassword(c, auth.userId, body.currentPassword, req.id, "auth.password_change_failed");
      if (check !== "ok") return check;
      await c.query(
        `UPDATE user_credentials
            SET password_hash = $2, password_changed_at = now(), failed_attempts = 0, locked_until = NULL
          WHERE user_id = $1`,
        [auth.userId, newHash],
      );
      // Keep this session, end every other one.
      await c.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL", [
        auth.userId,
        auth.sessionId,
      ]);
      await writeAudit(c, { actorUserId: auth.userId, action: "auth.password_changed", requestId: req.id });
      return "ok" as const;
    });

    if (outcome === "locked") throw new AppError(429, "too_many_attempts", "Too many failed attempts. Try again later.");
    if (outcome !== "ok") throw new AppError(400, "incorrect_password", "The current password is incorrect.");
    return reply.code(204).send();
  });
}
