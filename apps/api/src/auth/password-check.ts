import type { PoolClient } from "pg";
import { writeAudit } from "../audit";
import { lockMinutes, MAX_FAILED_ATTEMPTS } from "./lockout";
import { verifyPassword } from "./password";

export type PasswordCheck = "ok" | "invalid" | "locked";

/**
 * Re-verifies a signed-in user's password (step-up for sensitive actions) with the same lockout counters as login.
 * The client's database context must be that user. Failures are persisted; the caller must not roll back.
 */
export async function checkCurrentPassword(
  client: PoolClient,
  userId: string,
  plain: string,
  requestId: string,
  auditAction: string,
): Promise<PasswordCheck> {
  const { rows } = await client.query<{ password_hash: string; failed_attempts: number; locked: boolean }>(
    `SELECT password_hash, failed_attempts, (locked_until IS NOT NULL AND locked_until > now()) AS locked
       FROM user_credentials WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  const cred = rows[0];
  if (!cred) return "invalid";
  if (cred.locked) return "locked";
  if (await verifyPassword(cred.password_hash, plain)) {
    if (cred.failed_attempts > 0) {
      await client.query("UPDATE user_credentials SET failed_attempts = 0, locked_until = NULL WHERE user_id = $1", [userId]);
    }
    return "ok";
  }
  const attempts = cred.failed_attempts + 1;
  const lock = attempts >= MAX_FAILED_ATTEMPTS;
  await client.query(
    `UPDATE user_credentials
        SET failed_attempts = $2,
            locked_until = CASE WHEN $3::boolean THEN now() + ($4::double precision * interval '1 minute') ELSE locked_until END
      WHERE user_id = $1`,
    [userId, attempts, lock, lock ? lockMinutes(attempts) : 0],
  );
  await writeAudit(client, { actorUserId: userId, action: auditAction, metadata: { attempts, locked: lock }, requestId });
  return "invalid";
}
