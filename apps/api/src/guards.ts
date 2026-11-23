import type { FastifyReply, FastifyRequest } from "fastify";
import { withContext } from "@kidos/db";
import type { PoolClient } from "pg";
import { z } from "zod";
import { writeAudit } from "./audit";
import { hashSessionToken, SESSION_COOKIE } from "./auth/session";
import { AppError, forbidden, unauthenticated } from "./errors";
import { PLATFORM_ORG_ID, type Deps, type TenantState } from "./types";

const uuid = z.uuid();

export interface AuthenticateOptions {
  /**
   * Accept a session whose second factor is still outstanding. Only the MFA verification and logout routes set this;
   * everywhere else a pending session is treated as not yet signed in (401 mfa_required).
   */
  allowMfaPending?: boolean;
}

/**
 * Loads and validates the session from the cookie. One UPDATE validates (not revoked, not expired, not idle)
 * and refreshes last_seen_at at most once a minute. Throws 401 otherwise.
 */
export function makeAuthenticate({ pool, config }: Deps, options: AuthenticateOptions = {}) {
  return async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = req.cookies[SESSION_COOKIE];
    if (!token || token.length > 200) throw unauthenticated();

    const tokenHash = hashSessionToken(token);
    const session = await withContext(pool, { sessionTokenHash: tokenHash }, async (c) => {
      const { rows } = await c.query<{
        id: string;
        user_id: string;
        active_tenant_id: string | null;
        mfa_required: boolean;
        mfa_verified_at: Date | null;
      }>(
        `UPDATE sessions
            SET last_seen_at = CASE WHEN last_seen_at < now() - interval '1 minute' THEN now() ELSE last_seen_at END
          WHERE token_hash = $1
            AND revoked_at IS NULL
            AND expires_at > now()
            AND last_seen_at > now() - ($2::double precision * interval '1 minute')
        RETURNING id, user_id, active_tenant_id, mfa_required, mfa_verified_at`,
        [tokenHash, config.sessionIdleMinutes],
      );
      return rows[0];
    });
    if (!session) {
      void reply.clearCookie(SESSION_COOKIE, { path: "/" });
      throw unauthenticated();
    }

    const user = await withContext(pool, { userId: session.user_id }, async (c) => {
      const { rows } = await c.query<{
        id: string;
        email: string;
        display_name: string;
        status: string;
        email_verified_at: Date | null;
      }>("SELECT id, email, display_name, status, email_verified_at FROM users WHERE id = $1 AND deleted_at IS NULL", [
        session.user_id,
      ]);
      return rows[0];
    });
    if (!user || user.status !== "active") {
      void reply.clearCookie(SESSION_COOKIE, { path: "/" });
      throw unauthenticated();
    }

    const mfaVerified = session.mfa_verified_at !== null;
    const mfaPending = session.mfa_required && !mfaVerified;
    if (mfaPending && options.allowMfaPending !== true) {
      throw new AppError(401, "mfa_required", "Second-factor verification is required.");
    }

    req.auth = {
      sessionId: session.id,
      userId: user.id,
      email: user.email,
      displayName: user.display_name,
      activeTenantId: session.active_tenant_id,
      emailVerified: user.email_verified_at !== null,
      mfaVerified,
      mfaPending,
    };
  };
}

async function loadPermissions(
  deps: Deps,
  tenantId: string,
  userId: string,
  platformScope: boolean,
): Promise<{ permissions: Set<string>; requiresMfa: boolean; missingCredential: boolean }> {
  return withContext(deps.pool, { tenantId, userId, platformScope }, async (c) => {
    const perms = await c.query<{ permission_code: string }>(
      `SELECT DISTINCT rp.permission_code
         FROM role_assignments ra
         JOIN role_permissions rp ON rp.role_id = ra.role_id
        WHERE ra.user_id = $1 AND ra.tenant_id = $2`,
      [userId, tenantId],
    );
    const mfa = await c.query<{ requires: boolean }>(
      `SELECT COALESCE(bool_or(r.requires_mfa), false) AS requires
         FROM role_assignments ra
         JOIN roles r ON r.id = ra.role_id
        WHERE ra.user_id = $1 AND ra.tenant_id = $2`,
      [userId, tenantId],
    );
    // Community security setting (migration 0019): everyone acting here must use two-step verification.
    const policy = platformScope
      ? { rows: [] as { required: boolean }[] }
      : await c.query<{ required: boolean }>(
          "SELECT value = 'true'::jsonb AS required FROM community_policies WHERE tenant_id = $1 AND key = 'require_two_step_all_members'",
          [tenantId],
        );
    const policyRequiresMfa = policy.rows[0]?.required === true;
    // A session verified before the person turned two-step off must not count: under this policy the credential has to exist.
    const hasCredential = policyRequiresMfa
      ? ((await c.query("SELECT 1 FROM mfa_credentials WHERE user_id = $1 AND confirmed_at IS NOT NULL", [userId])).rowCount ?? 0) > 0
      : true;
    return {
      permissions: new Set(perms.rows.map((r) => r.permission_code)),
      requiresMfa: mfa.rows[0]?.requires === true || policyRequiresMfa,
      missingCredential: !hasCredential,
    };
  });
}

/**
 * Resolves which tenant this request acts in and what the user may do there.
 * The database trusts app.tenant_id, so THIS function is the gate: an active membership is verified
 * before any tenant-scoped query runs. Platform scope additionally requires platform_staff membership.
 */
export async function resolveTenantState(req: FastifyRequest, deps: Deps): Promise<TenantState | undefined> {
  if (req.tenantState) return req.tenantState;
  const auth = req.auth;
  if (!auth) throw unauthenticated();

  const platformHeader = req.headers["x-platform-scope"];
  const tenantHeader = req.headers["x-tenant-id"];
  if (Array.isArray(platformHeader) || Array.isArray(tenantHeader)) {
    throw new AppError(400, "invalid_header", "Duplicate context headers are not allowed.");
  }

  let tenantId: string;
  let platformScope = false;

  if (platformHeader === "on") {
    const isStaff = await withContext(deps.pool, { userId: auth.userId }, async (c) => {
      const { rowCount } = await c.query("SELECT 1 FROM platform_staff WHERE user_id = $1", [auth.userId]);
      return (rowCount ?? 0) > 0;
    });
    if (!isStaff) throw forbidden();
    tenantId = PLATFORM_ORG_ID;
    platformScope = true;
  } else {
    const requested = tenantHeader ?? auth.activeTenantId ?? undefined;
    if (requested === undefined || requested === "") return undefined;
    if (!uuid.safeParse(requested).success) throw new AppError(400, "invalid_header", "X-Tenant-Id must be a UUID.");
    tenantId = requested;
  }

  const membership = await withContext(deps.pool, { userId: auth.userId }, async (c) => {
    const { rows } = await c.query<{ status: string }>(
      `SELECT o.status FROM memberships m JOIN organizations o ON o.id = m.tenant_id
        WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.status = 'active'`,
      [tenantId, auth.userId],
    );
    return rows[0];
  });
  if (!membership) throw new AppError(403, "tenant_forbidden", "You are not a member of this organization.");
  // A suspended organization is switched off for its own people. Platform staff (platform scope) are unaffected.
  if (membership.status === "suspended" && !platformScope) {
    throw new AppError(403, "tenant_suspended", "This organization is suspended. Contact the platform team.");
  }

  const { permissions, requiresMfa, missingCredential } = await loadPermissions(deps, tenantId, auth.userId, platformScope);
  req.tenantState = {
    tenantId,
    userId: auth.userId,
    platformScope,
    permissions,
    mfaEnrollmentRequired: requiresMfa && (!auth.mfaVerified || missingCredential),
  };
  return req.tenantState;
}

/**
 * Route guard: authenticated, in a verified tenant, holding `permission` there, with a verified email, and
 * (when one of the user's roles here requires it) having completed MFA.
 */
export function makeRequirePermission(deps: Deps) {
  const authenticate = makeAuthenticate(deps);
  return function requirePermission(permission: string) {
    return async function guard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
      await authenticate(req, reply);
      const state = await resolveTenantState(req, deps);
      if (!state) throw new AppError(400, "tenant_required", "Select an organization first (X-Tenant-Id or switch tenant).");
      if (!state.permissions.has(permission)) {
        await recordDenied(deps, req, state, permission);
        throw forbidden();
      }
      if (!req.auth?.emailVerified) {
        throw new AppError(403, "email_verification_required", "Verify your email address to continue.");
      }
      if (state.mfaEnrollmentRequired) {
        throw new AppError(403, "mfa_enrollment_required", "Two-step verification is required here (by your role or by this community). Set it up to continue.");
      }
    };
  };
}

/** Like `makeRequirePermission`, but any ONE of the permissions is enough (for routes several audiences share). */
export function makeRequireAnyPermission(deps: Deps) {
  const authenticate = makeAuthenticate(deps);
  return function requireAnyPermission(...permissions: string[]) {
    return async function guard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
      await authenticate(req, reply);
      const state = await resolveTenantState(req, deps);
      if (!state) throw new AppError(400, "tenant_required", "Select an organization first (X-Tenant-Id or switch tenant).");
      if (!permissions.some((p) => state.permissions.has(p))) {
        await recordDenied(deps, req, state, permissions.join(" or "));
        throw forbidden();
      }
      if (!req.auth?.emailVerified) throw new AppError(403, "email_verification_required", "Verify your email address to continue.");
      if (state.mfaEnrollmentRequired) throw new AppError(403, "mfa_enrollment_required", "Two-step verification is required here (by your role or by this community). Set it up to continue.");
    };
  };
}

/**
 * Guard for routes shaped /communities/:id/...
 *  - platform staff in platform scope may address any community;
 *  - everyone else may address only the community they are currently acting in (verified membership), and
 *    a different id answers 404 so existence is not revealed.
 * Also enforces the permission, verified email and MFA rules of makeRequirePermission.
 */
export function makeRequireCommunityPermission(deps: Deps) {
  const requirePermission = makeRequirePermission(deps);
  return function requireCommunityPermission(permission: string) {
    const base = requirePermission(permission);
    return async function guard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
      await base(req, reply);
      const id = (req.params as { id?: string } | undefined)?.id;
      const state = req.tenantState;
      if (!state || !id || !uuid.safeParse(id).success) throw new AppError(404, "not_found", "Community not found.");
      if (!state.platformScope && state.tenantId !== id) throw new AppError(404, "not_found", "Community not found.");
    };
  };
}

/**
 * Guard for routes shaped /vendors/:id/...: same rules as communities. Platform staff in platform scope may address any
 * vendor; a vendor's own staff may address only the vendor they are acting in; any other id answers 404.
 */
export function makeRequireVendorPermission(deps: Deps) {
  const requirePermission = makeRequirePermission(deps);
  return function requireVendorPermission(permission: string) {
    const base = requirePermission(permission);
    return async function guard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
      await base(req, reply);
      const id = (req.params as { id?: string } | undefined)?.id;
      const state = req.tenantState;
      if (!state || !id || !uuid.safeParse(id).success) throw new AppError(404, "not_found", "Vendor not found.");
      if (!state.platformScope && state.tenantId !== id) throw new AppError(404, "not_found", "Vendor not found.");
    };
  };
}

/** Request context for database access, derived from the verified tenant state. */
export function dbContext(state: TenantState) {
  // The verified permissions travel with the context so row-level security can limit what this request may read.
  return { tenantId: state.tenantId, userId: state.userId, platformScope: state.platformScope, permissions: [...state.permissions] };
}

async function recordDenied(deps: Deps, req: FastifyRequest, state: TenantState, permission: string): Promise<void> {
  try {
    await withContext(
      deps.pool,
      { tenantId: state.tenantId, userId: state.userId, platformScope: state.platformScope },
      (c: PoolClient) =>
        writeAudit(c, {
          tenantId: state.tenantId,
          actorUserId: state.userId,
          action: "authz.denied",
          metadata: { permission, method: req.method, route: req.routeOptions.url ?? "" },
          requestId: req.id,
        }),
    );
  } catch (err) {
    req.log.error({ err }, "failed to record authorization denial");
  }
}
