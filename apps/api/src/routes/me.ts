import type { FastifyInstance } from "fastify";
import { withContext } from "@kidos/db";
import { z } from "zod";
import { writeAudit } from "../audit";
import { AppError } from "../errors";
import { dbContext, makeAuthenticate, resolveTenantState } from "../guards";
import type { Deps } from "../types";

const switchSchema = z.object({ tenantId: z.uuid().nullable() }).strict();
const sessionIdParam = z.object({ id: z.uuid() });
export const PALETTES = ["classic", "ocean", "forest"] as const;
const appearanceSchema = z.object({ themeMode: z.enum(["system", "light", "dark"]), palette: z.enum(PALETTES).nullable() }).strict();

export async function meRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool } = deps;
  const authenticate = makeAuthenticate(deps);
  app.addHook("preHandler", authenticate);

  app.get("/me", async (req) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "unauthenticated", "Authentication is required.");

    const tenants = await withContext(pool, { userId: auth.userId }, async (c) => {
      const { rows } = await c.query<{ id: string; name: string; type: string; status: string; roles: string[] }>(
        `SELECT o.id, o.name, o.type, o.status,
                COALESCE(array_agg(r.key ORDER BY r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
           FROM memberships m
           JOIN organizations o ON o.id = m.tenant_id
           LEFT JOIN role_assignments ra ON ra.tenant_id = m.tenant_id AND ra.user_id = m.user_id
           LEFT JOIN roles r ON r.id = ra.role_id
          WHERE m.user_id = $1 AND m.status = 'active'
          GROUP BY o.id, o.name, o.type, o.status
          ORDER BY o.name`,
        [auth.userId],
      );
      return rows;
    });

    const mfaEnabled = await withContext(pool, { userId: auth.userId }, async (c) => {
      const { rowCount } = await c.query("SELECT 1 FROM mfa_credentials WHERE user_id = $1 AND confirmed_at IS NOT NULL", [
        auth.userId,
      ]);
      return (rowCount ?? 0) > 0;
    });

    // Lets the client offer "platform mode" only to people who can actually use it (the API still checks on every call).
    const platformStaff = await withContext(pool, { userId: auth.userId }, async (c) => {
      const { rowCount } = await c.query("SELECT 1 FROM platform_staff WHERE user_id = $1", [auth.userId]);
      return (rowCount ?? 0) > 0;
    });

    // If the organization this session was acting in has since been suspended, /me still has to work (so the person can
    // see that and pick another organization): treat it as "no active organization".
    let state;
    let activeSuspended = false;
    try {
      state = await resolveTenantState(req, deps);
    } catch (err) {
      if (!(err instanceof AppError && err.code === "tenant_suspended")) throw err;
      activeSuspended = true;
    }
    // Appearance: the person's own choice, and the palette of the community they are acting in (if any).
    const prefs = await withContext(pool, { userId: auth.userId }, async (c) => {
      const { rows } = await c.query<{ theme_mode: string; palette: string | null }>(
        "SELECT theme_mode, palette FROM user_preferences WHERE user_id = $1",
        [auth.userId],
      );
      return rows[0];
    });
    let communityPalette: string | null = null;
    if (state?.tenantId && !state.platformScope) {
      const s = state;
      communityPalette = await withContext(pool, dbContext(s), async (c) => {
        const { rows } = await c.query<{ palette: string }>("SELECT palette FROM community_branding WHERE tenant_id = $1", [s.tenantId]);
        return rows[0]?.palette ?? null;
      });
    }

    return {
      user: { id: auth.userId, email: auth.email, displayName: auth.displayName, emailVerified: auth.emailVerified },
      appearance: { themeMode: prefs?.theme_mode ?? "system", palette: prefs?.palette ?? null, communityPalette },
      platformStaff,
      mfaEnabled,
      mfaEnrollmentRequired: state?.mfaEnrollmentRequired ?? false,
      activeOrganizationSuspended: activeSuspended,
      tenants,
      activeTenantId: state?.tenantId ?? null,
      platformScope: state?.platformScope ?? false,
      permissions: state ? [...state.permissions].sort() : [],
    };
  });

  /** A person's display preferences: light, dark or their device's setting, and an optional palette of their own. */
  app.put("/me/appearance", async (req) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "unauthenticated", "Authentication is required.");
    const body = appearanceSchema.parse(req.body);
    await withContext(pool, { userId: auth.userId }, async (c) => {
      // No ON CONFLICT: the update grant is per column, so check for the row first (see CLAUDE.md).
      const updated = await c.query(
        "UPDATE user_preferences SET theme_mode = $2, palette = $3, updated_at = now() WHERE user_id = $1",
        [auth.userId, body.themeMode, body.palette],
      );
      if (!updated.rowCount) {
        await c.query("INSERT INTO user_preferences (user_id, theme_mode, palette) VALUES ($1, $2, $3)", [auth.userId, body.themeMode, body.palette]);
      }
    });
    return { themeMode: body.themeMode, palette: body.palette };
  });

  app.post("/me/tenants/switch", async (req, reply) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "unauthenticated", "Authentication is required.");
    const { tenantId } = switchSchema.parse(req.body);

    // The tenant is set in context so the audit row can be written against it, but nothing tenant-scoped is read
    // before the membership check below, which throws for non-members.
    await withContext(pool, { userId: auth.userId, tenantId: tenantId ?? undefined }, async (c) => {
      if (tenantId !== null) {
        const found = await c.query<{ status: string }>(
          `SELECT o.status FROM memberships m JOIN organizations o ON o.id = m.tenant_id
            WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.status = 'active'`,
          [tenantId, auth.userId],
        );
        if (!found.rows[0]) throw new AppError(403, "tenant_forbidden", "You are not a member of this organization.");
        if (found.rows[0].status === "suspended") throw new AppError(403, "tenant_suspended", "This organization is suspended. Contact the platform team.");
      }
      await c.query("UPDATE sessions SET active_tenant_id = $1 WHERE id = $2", [tenantId, auth.sessionId]);
      await writeAudit(c, {
        tenantId,
        actorUserId: auth.userId,
        action: "tenant.switch",
        entityType: "organization",
        ...(tenantId !== null ? { entityId: tenantId } : {}),
        requestId: req.id,
      });
    });
    return reply.code(204).send();
  });

  app.get("/me/sessions", async (req) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "unauthenticated", "Authentication is required.");
    const rows = await withContext(pool, { userId: auth.userId }, async (c) => {
      const res = await c.query<{ id: string; created_at: Date; last_seen_at: Date; user_agent: string | null }>(
        `SELECT id, created_at, last_seen_at, user_agent FROM sessions
          WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
          ORDER BY last_seen_at DESC`,
        [auth.userId],
      );
      return res.rows;
    });
    return {
      data: rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at.toISOString(),
        lastSeenAt: r.last_seen_at.toISOString(),
        userAgent: r.user_agent,
        current: r.id === auth.sessionId,
      })),
    };
  });

  /** Signs out every other device at once (for a lost phone or a shared computer). This device stays signed in. */
  app.post("/me/sessions/revoke-others", async (req) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "unauthenticated", "Authentication is required.");
    const count = await withContext(pool, { userId: auth.userId }, async (c) => {
      const res = await c.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL", [auth.userId, auth.sessionId]);
      const n = res.rowCount ?? 0;
      await writeAudit(c, { actorUserId: auth.userId, action: "auth.sessions_revoked_others", metadata: { count: n }, requestId: req.id });
      return n;
    });
    return { signedOut: count };
  });

  /**
   * The person's own sign-ins over the last 30 days, from their own session records (row-level security: own rows
   * only), so they can spot one they do not recognise. Device text only; no addresses or tokens.
   */
  app.get("/me/sign-ins", async (req) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "unauthenticated", "Authentication is required.");
    const rows = await withContext(pool, { userId: auth.userId }, async (c) =>
      (
        await c.query<{ id: string; created_at: Date; last_seen_at: Date; user_agent: string | null; revoked: boolean; expired: boolean }>(
          `SELECT id, created_at, last_seen_at, user_agent, (revoked_at IS NOT NULL) AS revoked, (expires_at <= now()) AS expired
             FROM sessions WHERE user_id = $1 AND created_at > now() - interval '30 days'
            ORDER BY created_at DESC LIMIT 20`,
          [auth.userId],
        )
      ).rows,
    );
    return {
      data: rows.map((r) => ({
        signedInAt: r.created_at.toISOString(),
        lastSeenAt: r.last_seen_at.toISOString(),
        device: r.user_agent ? r.user_agent.slice(0, 120) : null,
        state: r.id === auth.sessionId ? "this_device" : r.revoked ? "signed_out" : r.expired ? "expired" : "active",
      })),
    };
  });

  app.delete("/me/sessions/:id", async (req, reply) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "unauthenticated", "Authentication is required.");
    const { id } = sessionIdParam.parse(req.params);
    const revoked = await withContext(pool, { userId: auth.userId }, async (c) => {
      const res = await c.query("UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL", [
        id,
        auth.userId,
      ]);
      if (res.rowCount) {
        await writeAudit(c, { actorUserId: auth.userId, action: "auth.session_revoked", entityType: "session", entityId: id, requestId: req.id });
      }
      return res.rowCount ?? 0;
    });
    if (!revoked) throw new AppError(404, "not_found", "Session not found.");
    return reply.code(204).send();
  });
}
