import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { withContext } from "@kidos/db";
import type { PoolClient } from "pg";
import { z } from "zod";
import { writeAudit } from "../audit";
import { SESSION_COOKIE } from "../auth/session";
import { hashToken } from "../auth/tokens";
import { base32Encode } from "../auth/totp";
import { AppError, isRlsViolation } from "../errors";
import { dbContext, makeAuthenticate, makeRequireCommunityPermission } from "../guards";
import { cursorTimestamp, decodeCursor, encodeCursor, pageParams } from "../pagination";
import type { Deps, TenantState } from "../types";

/** Resident-level roles every approved member receives. Admin-level roles are never granted through these flows. */
const MEMBER_ROLES = ["resident", "parent_guardian"] as const;
const CODE_LENGTH = 10;

const joinBody = z.object({ code: z.string().min(1).max(40), unitLabel: z.string().trim().min(1).max(60).optional() }).strict();
const requestBody = z.object({ unitLabel: z.string().trim().min(1).max(60), note: z.string().trim().max(500).optional() }).strict();
const memberAction = z
  .object({ action: z.enum(["approve", "reject", "suspend", "reinstate", "remove"]), note: z.string().trim().max(500).optional() })
  .strict();
const codeBody = z
  .object({ label: z.string().trim().min(1).max(80), maxUses: z.number().int().min(1).max(10_000), expiresInDays: z.number().int().min(1).max(365).optional() })
  .strict();
const listQuery = z.object({ ...pageParams, status: z.enum(["pending", "active", "suspended", "removed"]).optional() }).strict();

/** 10 random base32 characters (50 bits), shown as XXXXX-XXXXX. */
function newInviteCode(): string {
  const raw = base32Encode(randomBytes(7)).slice(0, CODE_LENGTH);
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** Accepts any case and separators; returns the canonical form, or null when it cannot be a code. */
function normalizeCode(input: string): string | null {
  const canonical = input.toUpperCase().replace(/[^A-Z2-7]/gu, "");
  return canonical.length === CODE_LENGTH ? canonical : null;
}

const invalidCode = () => new AppError(400, "invalid_code", "That code is not valid, has expired, or has been used up.");

export async function membershipRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool, config } = deps;
  const authenticate = makeAuthenticate(deps);
  const requireCommunity = makeRequireCommunityPermission(deps);
  // Guessing codes is rate limited per session (falling back to IP), on top of the global limit.
  const joinLimit = {
    rateLimit: {
      max: config.authRateLimitPerMinute,
      timeWindow: "1 minute",
      keyGenerator: (req: { cookies?: Record<string, string | undefined>; ip: string }) => req.cookies?.[SESSION_COOKIE] ?? req.ip,
    },
  };

  const state = (req: { tenantState?: TenantState }): TenantState => {
    if (!req.tenantState) throw new AppError(400, "tenant_required", "Select an organization first.");
    return req.tenantState;
  };

  function requireVerified(req: { auth?: { emailVerified: boolean; userId: string } }): { userId: string } {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "unauthenticated", "Authentication is required.");
    if (!auth.emailVerified) throw new AppError(403, "email_verification_required", "Verify your email address to continue.");
    return auth;
  }

  async function existingMembership(c: PoolClient, communityId: string, userId: string): Promise<string | undefined> {
    const res = await c.query<{ status: string }>("SELECT status FROM memberships WHERE tenant_id = $1 AND user_id = $2", [communityId, userId]);
    return res.rows[0]?.status;
  }

  function conflictFor(status: string): AppError {
    if (status === "active") return new AppError(409, "already_member", "You are already a member of this community.");
    if (status === "pending") return new AppError(409, "request_pending", "Your request to join is already waiting for approval.");
    return new AppError(409, "contact_admin", "Please contact the community administrator about your membership.");
  }

  /* ----------------------------------------------------------- joining (residents) */

  /** Join instantly with an invite code from the community. */
  app.post("/communities/join", { config: joinLimit, preHandler: authenticate }, async (req, reply) => {
    const { userId } = requireVerified(req);
    const body = joinBody.parse(req.body);
    const canonical = normalizeCode(body.code);
    if (!canonical) throw invalidCode();
    const codeHash = hashToken(canonical);

    // The code itself is what lets us see which community it belongs to; the tenant comes from that row, not from input.
    const found = await withContext(pool, { userId, tokenHash: codeHash }, async (c) => {
      const res = await c.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM invite_codes
          WHERE code_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND uses < max_uses`,
        [codeHash],
      );
      return res.rows[0];
    });
    if (!found) throw invalidCode();

    // Several people can race for the last place. The loser is refused either by the atomic counter below or, when the
    // code was already used up by the time its insert is checked, by the database's own row-level policy. Both mean
    // "that code is no longer valid".
    const community = await withContext(pool, { userId, tenantId: found.tenant_id, tokenHash: codeHash }, async (c) => {
      const org = await c.query<{ name: string }>("SELECT name FROM organizations WHERE id = $1 AND type = 'community' AND status = 'active'", [found.tenant_id]);
      if (!org.rows[0]) throw invalidCode();
      const current = await existingMembership(c, found.tenant_id, userId);
      if (current) throw conflictFor(current);
      await c.query(
        "INSERT INTO memberships (tenant_id, user_id, status, join_method, unit_label, decided_at) VALUES ($1, $2, 'active', 'invite_code', $3, now())",
        [found.tenant_id, userId, body.unitLabel ?? null],
      );
      for (const key of MEMBER_ROLES) {
        await c.query(
          "INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = $3 AND tenant_id IS NULL ON CONFLICT DO NOTHING",
          [found.tenant_id, userId, key],
        );
      }
      // Atomic: if another person used the last place first, this affects no row and everything above rolls back.
      const used = await c.query(
        `UPDATE invite_codes SET uses = uses + 1
          WHERE code_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND uses < max_uses`,
        [codeHash],
      );
      if (!used.rowCount) throw invalidCode();
      await writeAudit(c, { tenantId: found.tenant_id, actorUserId: userId, action: "membership.joined_with_code", entityType: "user", entityId: userId, requestId: req.id });
      return { id: found.tenant_id, name: org.rows[0].name };
    }).catch((err: unknown) => {
      if (isRlsViolation(err)) throw invalidCode();
      throw err;
    });
    return reply.code(201).send({ community });
  });

  /** Ask to join a community from the directory. An administrator decides. */
  app.post("/communities/:id/join-requests", { config: joinLimit, preHandler: authenticate }, async (req, reply) => {
    const { userId } = requireVerified(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = requestBody.parse(req.body);

    // Only communities that appear in the public directory can be asked to join.
    const listed = await withContext(pool, { userId }, async (c) => {
      const res = await c.query<{ name: string }>("SELECT name FROM organizations WHERE id = $1 AND type = 'community' AND status = 'active'", [id]);
      return res.rows[0];
    });
    if (!listed) throw new AppError(404, "not_found", "Community not found.");

    await withContext(pool, { userId, tenantId: id }, async (c) => {
      // Narrow, deliberate use of a tenant the person is not yet a member of: read one policy, add one pending row.
      const mode = await c.query<{ value: string }>("SELECT value FROM community_policies WHERE tenant_id = $1 AND key = 'resident_join_mode'", [id]);
      if ((mode.rows[0]?.value ?? "admin_approval") === "invite_code_only") {
        throw new AppError(403, "join_requires_invite", "This community only accepts residents who have an invite code.");
      }
      const current = await existingMembership(c, id, userId);
      if (current) throw conflictFor(current);
      await c.query(
        "INSERT INTO memberships (tenant_id, user_id, status, join_method, unit_label, request_note) VALUES ($1, $2, 'pending', 'admin_approval', $3, $4)",
        [id, userId, body.unitLabel, body.note ?? null],
      );
      await writeAudit(c, { tenantId: id, actorUserId: userId, action: "membership.join_requested", entityType: "user", entityId: userId, requestId: req.id });
    }).catch((err: unknown) => {
      // The community stopped being joinable between the lookup and the insert (for example it was just suspended).
      if (isRlsViolation(err)) throw new AppError(404, "not_found", "Community not found.");
      throw err;
    });
    return reply.code(201).send({ community: { id, name: listed.name }, status: "pending" });
  });

  app.get("/me/join-requests", { preHandler: authenticate }, async (req) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "unauthenticated", "Authentication is required.");
    const rows = await withContext(pool, { userId: auth.userId }, async (c) => {
      const res = await c.query<{ tenant_id: string; name: string; unit_label: string | null; created_at: Date }>(
        `SELECT m.tenant_id, o.name, m.unit_label, m.created_at
           FROM memberships m JOIN organizations o ON o.id = m.tenant_id
          WHERE m.user_id = $1 AND m.status = 'pending' ORDER BY m.created_at DESC`,
        [auth.userId],
      );
      return res.rows;
    });
    return { data: rows.map((r) => ({ communityId: r.tenant_id, communityName: r.name, unitLabel: r.unit_label, requestedAt: r.created_at.toISOString() })) };
  });

  app.delete("/me/join-requests/:communityId", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "unauthenticated", "Authentication is required.");
    const { communityId } = z.object({ communityId: z.uuid() }).parse(req.params);
    // A person may only withdraw their own pending request (the database allows nothing more).
    const withdrawn = await withContext(pool, { userId: auth.userId, tenantId: communityId }, async (c) => {
      const res = await c.query("UPDATE memberships SET status = 'removed', decided_at = now() WHERE tenant_id = $1 AND user_id = $2 AND status = 'pending'", [communityId, auth.userId]);
      if (res.rowCount) await writeAudit(c, { tenantId: communityId, actorUserId: auth.userId, action: "membership.join_withdrawn", requestId: req.id });
      return res.rowCount ?? 0;
    });
    if (!withdrawn) throw new AppError(404, "not_found", "No pending request found.");
    return reply.code(204).send();
  });

  /* ----------------------------------------------------- members (administrators) */

  app.get("/communities/:id/members", { preHandler: requireCommunity("memberships.approve") }, async (req) => {
    const s = state(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const q = listQuery.parse(req.query);
    const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
    const rows = await withContext(pool, dbContext(s), async (c) => {
      const params: unknown[] = [id, q.limit + 1];
      let where = "m.tenant_id = $1";
      if (q.status) {
        params.push(q.status);
        where += ` AND m.status = $${params.length}`;
      }
      if (cursor) {
        params.push(cursor.t, cursor.i);
        where += ` AND (m.created_at, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
      }
      const res = await c.query<{
        id: string;
        user_id: string;
        display_name: string;
        email: string;
        status: string;
        join_method: string | null;
        unit_label: string | null;
        request_note: string | null;
        created_at: Date;
        decided_at: Date | null;
        roles: string[];
        cursor_t: string;
      }>(
        `SELECT m.id, m.user_id, u.display_name, u.email, m.status, m.join_method, m.unit_label, m.request_note, m.created_at, m.decided_at,
                COALESCE(array_agg(r.key ORDER BY r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles,
                ${cursorTimestamp("m.created_at")} AS cursor_t
           FROM memberships m
           JOIN users u ON u.id = m.user_id
           LEFT JOIN role_assignments ra ON ra.tenant_id = m.tenant_id AND ra.user_id = m.user_id
           LEFT JOIN roles r ON r.id = ra.role_id
          WHERE ${where}
          GROUP BY m.id, u.display_name, u.email
          ORDER BY m.created_at DESC, m.id DESC LIMIT $2`,
        params,
      );
      return res.rows;
    });
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const last = page[page.length - 1];
    return {
      data: page.map((r) => ({
        userId: r.user_id,
        displayName: r.display_name,
        email: r.email,
        status: r.status,
        joinMethod: r.join_method,
        unitLabel: r.unit_label,
        requestNote: r.request_note,
        roles: r.roles,
        requestedAt: r.created_at.toISOString(),
        decidedAt: r.decided_at?.toISOString() ?? null,
      })),
      page: { hasMore, nextCursor: hasMore && last ? encodeCursor(last.cursor_t, last.id) : null },
    };
  });

  /** Approve or reject a request, suspend, reinstate or remove a member. */
  app.patch("/communities/:id/members/:userId", { preHandler: requireCommunity("memberships.approve") }, async (req) => {
    const s = state(req);
    const { id, userId } = z.object({ id: z.uuid(), userId: z.uuid() }).parse(req.params);
    const body = memberAction.parse(req.body);
    if (userId === s.userId) throw new AppError(422, "cannot_act_on_self", "You cannot change your own membership.");

    await withContext(pool, dbContext(s), async (c) => {
      const target = await c.query<{ status: string; is_admin: boolean }>(
        `SELECT m.status,
                EXISTS (SELECT 1 FROM role_assignments ra JOIN roles r ON r.id = ra.role_id
                         WHERE ra.tenant_id = m.tenant_id AND ra.user_id = m.user_id AND r.key = 'community_admin' AND r.tenant_id IS NULL) AS is_admin
           FROM memberships m WHERE m.tenant_id = $1 AND m.user_id = $2 FOR UPDATE`,
        [id, userId],
      );
      const t = target.rows[0];
      if (!t) throw new AppError(404, "not_found", "Member not found.");
      // Administrators are managed by the platform team (see /communities/:id/admins), not by each other.
      if (t.is_admin && !s.platformScope) throw new AppError(403, "forbidden", "Community administrators are managed by the platform team.");

      const rules: Record<string, { from: string[]; to: string }> = {
        approve: { from: ["pending"], to: "active" },
        reject: { from: ["pending"], to: "removed" },
        suspend: { from: ["active"], to: "suspended" },
        reinstate: { from: ["suspended"], to: "active" },
        remove: { from: ["active", "suspended"], to: "removed" },
      };
      const rule = rules[body.action];
      if (!rule || !rule.from.includes(t.status)) {
        throw new AppError(409, "invalid_state", `A member who is ${t.status} cannot be changed that way.`);
      }
      await c.query("UPDATE memberships SET status = $3, decided_by = $4, decided_at = now() WHERE tenant_id = $1 AND user_id = $2", [id, userId, rule.to, s.userId]);
      if (body.action === "approve") {
        for (const key of MEMBER_ROLES) {
          await c.query(
            "INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = $3 AND tenant_id IS NULL ON CONFLICT DO NOTHING",
            [id, userId, key],
          );
        }
      }
      if (body.action === "remove" || body.action === "reject") {
        await c.query(
          `DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2
              AND role_id IN (SELECT id FROM roles WHERE tenant_id IS NULL AND key IN ('resident', 'parent_guardian', 'family_member'))`,
          [id, userId],
        );
      }
      await writeAudit(c, {
        tenantId: id,
        actorUserId: s.userId,
        action: `membership.${body.action}`,
        entityType: "user",
        entityId: userId,
        ...(body.note ? { metadata: { note: body.note } } : {}),
        requestId: req.id,
      });
    });
    return { userId, status: ({ approve: "active", reject: "removed", suspend: "suspended", reinstate: "active", remove: "removed" } as const)[body.action] };
  });

  /* ------------------------------------------------------------- invite codes */

  app.post("/communities/:id/invite-codes", { preHandler: requireCommunity("memberships.approve") }, async (req, reply) => {
    const s = state(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = codeBody.parse(req.body);
    const code = newInviteCode();
    const created = await withContext(pool, dbContext(s), async (c) => {
      const org = await c.query("SELECT 1 FROM organizations WHERE id = $1 AND type = 'community' AND status = 'active'", [id]);
      if (!org.rowCount) throw new AppError(422, "community_not_active", "Invite codes can be created once the community is active.");
      // Community security setting (migration 0019): a code never lives longer than the community allows.
      const cap = await c.query<{ value: unknown }>("SELECT value FROM community_policies WHERE tenant_id = $1 AND key = 'invite_code_max_days'", [id]);
      const capValue = cap.rows[0]?.value;
      const maxDays = typeof capValue === "string" && /^\d+$/u.test(capValue) ? Number(capValue) : null;
      const days = maxDays === null ? (body.expiresInDays ?? null) : Math.min(body.expiresInDays ?? maxDays, maxDays);
      const res = await c.query<{ id: string; created_at: Date; expires_at: Date | null }>(
        `INSERT INTO invite_codes (tenant_id, code_hash, code_hint, label, max_uses, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::int IS NULL THEN NULL ELSE now() + ($6::int * interval '1 day') END, $7)
         RETURNING id, created_at, expires_at`,
        [id, hashToken(normalizeCode(code) ?? ""), code.slice(-4), body.label, body.maxUses, days, s.userId],
      );
      const row = res.rows[0];
      if (!row) throw new Error("invite insert returned no row");
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "membership.invite_created", entityType: "invite_code", entityId: row.id, metadata: { label: body.label, maxUses: body.maxUses, expiresInDays: days }, requestId: req.id });
      return row;
    });
    // The code is shown exactly once; only its hash is stored.
    return reply.code(201).send({ id: created.id, code, label: body.label, maxUses: body.maxUses, expiresAt: created.expires_at?.toISOString() ?? null });
  });

  app.get("/communities/:id/invite-codes", { preHandler: requireCommunity("memberships.approve") }, async (req) => {
    const s = state(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const rows = await withContext(pool, dbContext(s), async (c) => {
      const res = await c.query<{ id: string; label: string; code_hint: string; max_uses: number; uses: number; expires_at: Date | null; revoked_at: Date | null; created_at: Date; state: string }>(
        `SELECT id, label, code_hint, max_uses, uses, expires_at, revoked_at, created_at,
                CASE WHEN revoked_at IS NOT NULL THEN 'revoked'
                     WHEN expires_at IS NOT NULL AND expires_at <= now() THEN 'expired'
                     WHEN uses >= max_uses THEN 'used_up' ELSE 'active' END AS state
           FROM invite_codes WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`,
        [id],
      );
      return res.rows;
    });
    return {
      data: rows.map((r) => ({
        id: r.id,
        label: r.label,
        hint: `…${r.code_hint}`,
        maxUses: r.max_uses,
        uses: r.uses,
        state: r.state,
        expiresAt: r.expires_at?.toISOString() ?? null,
        createdAt: r.created_at.toISOString(),
      })),
    };
  });

  app.delete("/communities/:id/invite-codes/:codeId", { preHandler: requireCommunity("memberships.approve") }, async (req, reply) => {
    const s = state(req);
    const { id, codeId } = z.object({ id: z.uuid(), codeId: z.uuid() }).parse(req.params);
    await withContext(pool, dbContext(s), async (c) => {
      const res = await c.query("UPDATE invite_codes SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL", [codeId, id]);
      if (!res.rowCount) throw new AppError(404, "not_found", "Invite code not found.");
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "membership.invite_revoked", entityType: "invite_code", entityId: codeId, requestId: req.id });
    });
    return reply.code(204).send();
  });
}
