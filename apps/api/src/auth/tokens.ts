import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { hashSessionToken } from "./session";

export type TokenPurpose = "email_verification" | "password_reset";

/** Opaque 256-bit token; only its SHA-256 is stored. */
export const hashToken = hashSessionToken;

/**
 * Issues a single-use token for `userId` (the database context must be that user) and invalidates any
 * older unused token of the same purpose. Returns the plaintext token to deliver out of band.
 */
export async function issueToken(
  client: PoolClient,
  input: { userId: string; purpose: TokenPurpose; ttlMinutes: number },
): Promise<string> {
  await client.query(
    "UPDATE one_time_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL",
    [input.userId, input.purpose],
  );
  const token = randomBytes(32).toString("base64url");
  await client.query(
    `INSERT INTO one_time_tokens (user_id, purpose, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + ($4::double precision * interval '1 minute'))`,
    [input.userId, input.purpose, hashToken(token), input.ttlMinutes],
  );
  return token;
}

/**
 * Like issueToken, but returns null (issuing nothing) when a token of this purpose was created for the user
 * within `cooldownSeconds`. Stops anyone from using these endpoints to flood a victim's inbox.
 */
export async function issueTokenUnlessRecent(
  client: PoolClient,
  input: { userId: string; purpose: TokenPurpose; ttlMinutes: number; cooldownSeconds: number },
): Promise<string | null> {
  if (input.cooldownSeconds > 0) {
    const recent = await client.query(
      `SELECT 1 FROM one_time_tokens
        WHERE user_id = $1 AND purpose = $2 AND created_at > now() - ($3::double precision * interval '1 second')
        LIMIT 1`,
      [input.userId, input.purpose, input.cooldownSeconds],
    );
    if (recent.rowCount) return null;
  }
  return issueToken(client, input);
}

/**
 * Atomically consumes a token. The database context must be `{ tokenHash: hashToken(token) }`.
 * Returns the owning user id, or undefined when the token is unknown, expired, used, or of another purpose.
 */
export async function consumeToken(client: PoolClient, token: string, purpose: TokenPurpose): Promise<string | undefined> {
  const { rows } = await client.query<{ user_id: string }>(
    `UPDATE one_time_tokens SET used_at = now()
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
    RETURNING user_id`,
    [hashToken(token), purpose],
  );
  return rows[0]?.user_id;
}
