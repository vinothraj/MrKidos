import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import type { AppConfig } from "../config";

export const SESSION_COOKIE = "kidos_sid";

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Only this hash is stored; a database leak does not yield usable session cookies. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  client: PoolClient,
  input: {
    userId: string;
    token: string;
    ip: string | undefined;
    userAgent: string | undefined;
    /** True when the user has MFA enrolled: the session starts pending until the second factor is verified. */
    mfaRequired?: boolean;
  },
  config: AppConfig,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent, mfa_required)
     VALUES ($1, $2, now() + ($3::double precision * interval '1 hour'), $4, $5, $6)
     RETURNING id`,
    [
      input.userId,
      hashSessionToken(input.token),
      config.sessionAbsoluteHours,
      input.ip ?? null,
      input.userAgent?.slice(0, 300) ?? null,
      input.mfaRequired === true,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("Session insert returned no row");
  return row.id;
}
