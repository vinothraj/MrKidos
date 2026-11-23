import type { Pool, PoolClient } from "pg";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Per-request database context that row-level security policies read. */
export interface DbContext {
  tenantId?: string | undefined;
  userId?: string | undefined;
  /** Requests platform-wide scope. Ignored by the database unless the user is in platform_staff. */
  platformScope?: boolean | undefined;
  /** Pre-authentication lookup: makes exactly the user row with this email visible. */
  loginEmail?: string | undefined;
  /** Pre-authentication lookup: makes exactly the session with this token hash visible. */
  sessionTokenHash?: string | undefined;
  /** Pre-authentication lookup: makes exactly the one-time token with this hash visible. */
  tokenHash?: string | undefined;
  /**
   * The caller's verified permissions in this tenant. Row-level security uses them to limit what a request can READ
   * (for example, ordinary members cannot list other members). Omit for contexts that should get the least access.
   */
  permissions?: readonly string[] | undefined;
}

const PERMISSION_CODE = /^[a-z_]+(\.[a-z_]+)+$/;

function assertUuid(name: string, value: string): void {
  if (!UUID.test(value)) {
    throw new Error(`Invalid ${name}: expected a UUID`);
  }
}

/**
 * Within an open `withContext` transaction, continues as `userId`. Only for flows where possession of a secret
 * has just proven the identity inside this same transaction (e.g. a consumed one-time token). Never call it with an
 * id taken from request input.
 */
export async function assumeUser(client: PoolClient, userId: string): Promise<void> {
  assertUuid("userId", userId);
  await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
}

/**
 * Runs `fn` inside a transaction with the RLS context applied using transaction-local settings
 * (they vanish at COMMIT/ROLLBACK, so pooled connections never leak context between requests).
 * All tenant-scoped data access must go through this function.
 */
export async function withContext<T>(
  pool: Pool,
  ctx: DbContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (ctx.tenantId !== undefined) assertUuid("tenantId", ctx.tenantId);
  if (ctx.userId !== undefined) assertUuid("userId", ctx.userId);
  for (const p of ctx.permissions ?? []) {
    // A comma would let one entry masquerade as several.
    if (!PERMISSION_CODE.test(p)) throw new Error("Invalid permission code in context");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true),
              set_config('app.user_id', $2, true),
              set_config('app.platform_scope', $3, true),
              set_config('app.login_email', $4, true),
              set_config('app.session_hash', $5, true),
              set_config('app.token_hash', $6, true),
              set_config('app.permissions', $7, true)`,
      [
        ctx.tenantId ?? "",
        ctx.userId ?? "",
        ctx.platformScope === true ? "on" : "off",
        ctx.loginEmail ?? "",
        ctx.sessionTokenHash ?? "",
        ctx.tokenHash ?? "",
        (ctx.permissions ?? []).join(","),
      ],
    );
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Connection may already be broken; surface the original error.
    }
    throw err;
  } finally {
    client.release();
  }
}
