import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { withContext } from "@kidos/db";
import type { PoolClient } from "pg";
import { z } from "zod";
import { writeAudit } from "../audit";
import { decryptSecret, encryptSecret } from "../auth/crypto";
import { lockMinutes, MAX_FAILED_ATTEMPTS } from "../auth/lockout";
import { checkCurrentPassword } from "../auth/password-check";
import { base32Decode, base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from "../auth/totp";
import { AppError } from "../errors";
import { makeAuthenticate } from "../guards";
import type { Deps } from "../types";

const RECOVERY_CODE_COUNT = 10;

const codeSchema = z.string().regex(/^\d{6}$/u, "Enter the 6-digit code.");
const confirmBody = z.object({ code: codeSchema }).strict();
const verifyBody = z.union([
  z.object({ code: codeSchema }).strict(),
  z.object({ recoveryCode: z.string().min(8).max(32) }).strict(),
]);
const disableBody = z.object({ password: z.string().min(1).max(128), code: codeSchema }).strict();

/** 12 random base32 characters shown as XXXX-XXXX-XXXX (60 bits). */
function newRecoveryCode(): string {
  const raw = base32Encode(randomBytes(8)).slice(0, 12);
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

function hashRecoveryCode(input: string): string {
  const normalized = input.toUpperCase().replace(/[^A-Z2-7]/gu, "");
  return createHash("sha256").update(normalized).digest("hex");
}

async function recordMfaFailure(c: PoolClient, userId: string, attempts: number, requestId: string, action: string): Promise<void> {
  const lock = attempts >= MAX_FAILED_ATTEMPTS;
  await c.query(
    `UPDATE mfa_credentials
        SET failed_attempts = $2,
            locked_until = CASE WHEN $3::boolean THEN now() + ($4::double precision * interval '1 minute') ELSE locked_until END
      WHERE user_id = $1`,
    [userId, attempts, lock, lock ? lockMinutes(attempts) : 0],
  );
  await writeAudit(c, { actorUserId: userId, action, metadata: { attempts, locked: lock }, requestId });
}

interface CredRow {
  secret_encrypted: string;
  last_used_step: string; // bigint arrives as string
  failed_attempts: number;
  locked: boolean;
  confirmed: boolean;
}

async function loadCredential(c: PoolClient, userId: string): Promise<CredRow | undefined> {
  const { rows } = await c.query<CredRow>(
    `SELECT secret_encrypted, last_used_step::text AS last_used_step, failed_attempts,
            (locked_until IS NOT NULL AND locked_until > now()) AS locked,
            (confirmed_at IS NOT NULL) AS confirmed
       FROM mfa_credentials WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  return rows[0];
}

export async function mfaRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool, config } = deps;
  const authenticate = makeAuthenticate(deps);
  const authenticatePendingOk = makeAuthenticate(deps, { allowMfaPending: true });
  const rateLimit = { rateLimit: { max: config.authRateLimitPerMinute, timeWindow: "1 minute" } };
  const tooMany = () => new AppError(429, "too_many_attempts", "Too many failed attempts. Try again later.");
  const invalidCode = () => new AppError(400, "invalid_code", "That code is not valid. Check your authenticator app and try again.");

  /** Step 1 of enrollment: create an unconfirmed secret. MFA is not active until the code is confirmed. */
  app.post("/auth/mfa/enroll/start", { config: rateLimit, preHandler: authenticate }, async (req) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "unauthenticated", "Authentication is required.");
    const secret = generateTotpSecret();
    await withContext(pool, { userId: auth.userId }, async (c) => {
      const existing = await loadCredential(c, auth.userId);
      if (existing?.confirmed) throw new AppError(409, "mfa_already_enabled", "Two-factor authentication is already enabled.");
      await c.query("DELETE FROM mfa_credentials WHERE user_id = $1", [auth.userId]);
      await c.query("INSERT INTO mfa_credentials (user_id, secret_encrypted) VALUES ($1, $2)", [
        auth.userId,
        encryptSecret(base32Encode(secret), config.mfaEncryptionKey, auth.userId),
      ]);
      await writeAudit(c, { actorUserId: auth.userId, action: "auth.mfa_enrollment_started", requestId: req.id });
    });
    return {
      secret: base32Encode(secret),
      otpauthUri: otpauthUri({ issuer: config.brandName, account: auth.email, secret }),
    };
  });

  /** Step 2: prove the authenticator works. Activates MFA, issues one-time recovery codes, ends all other sessions. */
  app.post("/auth/mfa/enroll/confirm", { config: rateLimit, preHandler: authenticate }, async (req) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "unauthenticated", "Authentication is required.");
    const { code } = confirmBody.parse(req.body);

    const outcome = await withContext(pool, { userId: auth.userId }, async (c) => {
      const cred = await loadCredential(c, auth.userId);
      if (!cred || cred.confirmed) return { result: "not_started" as const };
      if (cred.locked) return { result: "locked" as const };
      const secret = base32Decode(decryptSecret(cred.secret_encrypted, config.mfaEncryptionKey, auth.userId));
      const step = verifyTotp(secret, code, Date.now(), 0);
      if (step === null) {
        await recordMfaFailure(c, auth.userId, cred.failed_attempts + 1, req.id, "auth.mfa_enrollment_failed");
        return { result: "invalid" as const };
      }
      await c.query(
        "UPDATE mfa_credentials SET confirmed_at = now(), last_used_step = $2, failed_attempts = 0, locked_until = NULL WHERE user_id = $1",
        [auth.userId, step],
      );
      await c.query("DELETE FROM mfa_recovery_codes WHERE user_id = $1", [auth.userId]);
      const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
      for (const rc of codes) {
        await c.query("INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)", [auth.userId, hashRecoveryCode(rc)]);
      }
      // Sessions opened before MFA existed never proved a second factor: end them, keep this one as verified.
      await c.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL", [
        auth.userId,
        auth.sessionId,
      ]);
      await c.query("UPDATE sessions SET mfa_verified_at = now() WHERE id = $1", [auth.sessionId]);
      await writeAudit(c, { actorUserId: auth.userId, action: "auth.mfa_enrolled", requestId: req.id });
      return { result: "ok" as const, codes };
    });

    if (outcome.result === "not_started") throw new AppError(409, "mfa_enrollment_not_started", "Start enrollment first.");
    if (outcome.result === "locked") throw tooMany();
    if (outcome.result === "invalid") throw invalidCode();
    return { recoveryCodes: outcome.codes };
  });

  /** Completes login for a pending session using an authenticator code or a one-time recovery code. */
  app.post("/auth/mfa/verify", { config: rateLimit, preHandler: authenticatePendingOk }, async (req, reply) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "unauthenticated", "Authentication is required.");
    const body = verifyBody.parse(req.body);

    const outcome = await withContext(pool, { userId: auth.userId }, async (c) => {
      const cred = await loadCredential(c, auth.userId);
      if (!cred?.confirmed) return { result: "not_enabled" as const };
      if (cred.locked) {
        await writeAudit(c, { actorUserId: auth.userId, action: "auth.mfa_blocked", metadata: { reason: "locked" }, requestId: req.id });
        return { result: "locked" as const };
      }

      let method: "totp" | "recovery";
      let step: number | null = null;
      if ("code" in body) {
        method = "totp";
        const secret = base32Decode(decryptSecret(cred.secret_encrypted, config.mfaEncryptionKey, auth.userId));
        step = verifyTotp(secret, body.code, Date.now(), Number(cred.last_used_step));
        if (step === null) {
          await recordMfaFailure(c, auth.userId, cred.failed_attempts + 1, req.id, "auth.mfa_failed");
          return { result: "invalid" as const };
        }
      } else {
        method = "recovery";
        const used = await c.query(
          "UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id",
          [auth.userId, hashRecoveryCode(body.recoveryCode)],
        );
        if (!used.rowCount) {
          await recordMfaFailure(c, auth.userId, cred.failed_attempts + 1, req.id, "auth.mfa_failed");
          return { result: "invalid" as const };
        }
      }

      await c.query(
        "UPDATE mfa_credentials SET failed_attempts = 0, locked_until = NULL, last_used_step = GREATEST(last_used_step, $2) WHERE user_id = $1",
        [auth.userId, step ?? 0],
      );
      await c.query("UPDATE sessions SET mfa_verified_at = now() WHERE id = $1", [auth.sessionId]);
      const remaining = await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL",
        [auth.userId],
      );
      await writeAudit(c, { actorUserId: auth.userId, action: "auth.mfa_verified", metadata: { method }, requestId: req.id });
      return { result: "ok" as const, method, remaining: remaining.rows[0]?.n ?? 0 };
    });

    if (outcome.result === "not_enabled") throw new AppError(409, "mfa_not_enabled", "Two-factor authentication is not enabled.");
    if (outcome.result === "locked") throw tooMany();
    if (outcome.result === "invalid") throw invalidCode();
    return reply.send({ ok: true, ...(outcome.method === "recovery" ? { recoveryCodesRemaining: outcome.remaining } : {}) });
  });

  /** Turns MFA off. Needs the password and a current code, and is refused when a role of the user requires MFA. */
  app.post("/auth/mfa/disable", { config: rateLimit, preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "unauthenticated", "Authentication is required.");
    const body = disableBody.parse(req.body);

    const outcome = await withContext(pool, { userId: auth.userId }, async (c) => {
      const required = await c.query(
        `SELECT 1 FROM role_assignments ra JOIN roles r ON r.id = ra.role_id
          WHERE ra.user_id = $1 AND r.requires_mfa LIMIT 1`,
        [auth.userId],
      );
      if (required.rowCount) return { result: "required_by_role" as const };

      const pw = await checkCurrentPassword(c, auth.userId, body.password, req.id, "auth.mfa_disable_failed");
      if (pw === "locked") return { result: "locked" as const };
      if (pw === "invalid") return { result: "bad_password" as const };

      const cred = await loadCredential(c, auth.userId);
      if (!cred?.confirmed) return { result: "not_enabled" as const };
      if (cred.locked) return { result: "locked" as const };
      const secret = base32Decode(decryptSecret(cred.secret_encrypted, config.mfaEncryptionKey, auth.userId));
      if (verifyTotp(secret, body.code, Date.now(), Number(cred.last_used_step)) === null) {
        await recordMfaFailure(c, auth.userId, cred.failed_attempts + 1, req.id, "auth.mfa_disable_failed");
        return { result: "invalid" as const };
      }
      await c.query("DELETE FROM mfa_recovery_codes WHERE user_id = $1", [auth.userId]);
      await c.query("DELETE FROM mfa_credentials WHERE user_id = $1", [auth.userId]);
      await c.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL", [
        auth.userId,
        auth.sessionId,
      ]);
      await writeAudit(c, { actorUserId: auth.userId, action: "auth.mfa_disabled", requestId: req.id });
      return { result: "ok" as const };
    });

    if (outcome.result === "required_by_role") {
      throw new AppError(403, "mfa_required_by_role", "Two-factor authentication is required for your role and cannot be turned off.");
    }
    if (outcome.result === "locked") throw tooMany();
    if (outcome.result === "bad_password") throw new AppError(400, "incorrect_password", "The password is incorrect.");
    if (outcome.result === "not_enabled") throw new AppError(409, "mfa_not_enabled", "Two-factor authentication is not enabled.");
    if (outcome.result === "invalid") throw invalidCode();
    return reply.code(204).send();
  });
}
