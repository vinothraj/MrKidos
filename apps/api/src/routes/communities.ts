import type { FastifyInstance } from "fastify";
import { withContext } from "@kidos/db";
import type { PoolClient } from "pg";
import { z } from "zod";
import { writeAudit } from "../audit";
import { AppError, forbidden } from "../errors";
import { dbContext, makeAuthenticate, makeRequireCommunityPermission, makeRequirePermission } from "../guards";
import { cursorTimestamp, decodeCursor, encodeCursor, pageParams } from "../pagination";
import type { Deps, TenantState } from "../types";
import { emailSchema } from "./auth";

/* ------------------------------------------------------------------ schemas */

const COMMUNITY_TYPES = ["gated_community", "apartment_complex", "township", "other"] as const;
const text = (max: number) => z.string().trim().max(max);

/** Fields of the PUBLIC profile (shown in the directory once the community is active). */
const publicFields = {
  communityType: z.enum(COMMUNITY_TYPES),
  description: text(2000).nullable(),
  country: text(80).min(1).nullable(),
  state: text(80).min(1).nullable(),
  city: text(80).min(1).nullable(),
  locality: text(120).min(1).nullable(),
  unitCount: z.number().int().min(1).max(100_000).nullable(),
};
/** Fields only the community and platform staff may see. */
const privateFields = {
  address: text(300).min(1).nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  contactName: text(120).min(1).nullable(),
  contactEmail: z.email().max(254).nullable(),
  contactPhone: text(30).min(5).nullable(),
  population: z.number().int().min(0).max(1_000_000).nullable(),
  internalNotes: text(2000).nullable(),
};

const allFields = { ...publicFields, ...privateFields };
/** Every profile field optional (created or changed independently). */
const optionalFields = Object.fromEntries(Object.entries(allFields).map(([k, v]) => [k, v.optional()])) as {
  [K in keyof typeof allFields]: z.ZodOptional<(typeof allFields)[K]>;
};

const createSchema = z.object({ name: text(120).min(2), ...optionalFields }).strict();

const patchSchema = z
  .object({ name: text(120).min(2).optional(), ...optionalFields })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to change.");

const transitionSchema = z.object({ to: z.enum(["draft", "verification", "active", "suspended"]), note: text(1000).optional() }).strict();
const adminSchema = z.object({ email: emailSchema }).strict();
const idParam = z.object({ id: z.uuid() });
const listQuery = z
  .object({
    ...pageParams,
    status: z.enum(["draft", "verification", "active", "suspended"]).optional(),
    q: z.string().trim().max(80).optional(),
  })
  .strict();
const directoryQuery = z.object({ q: z.string().trim().max(60).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();

/* ---------------------------------------------------------- field mappings */

const PUBLIC_COLUMNS: Record<string, string> = {
  communityType: "community_type",
  description: "description",
  country: "country",
  state: "state",
  city: "city",
  locality: "locality",
  unitCount: "unit_count",
};
const PRIVATE_COLUMNS: Record<string, string> = {
  address: "address",
  latitude: "latitude",
  longitude: "longitude",
  contactName: "contact_name",
  contactEmail: "contact_email",
  contactPhone: "contact_phone",
  population: "population",
};

/** Notes the platform team keeps about a community live in their own platform-only table, never in community_private. */
async function saveInternalNotes(c: PoolClient, id: string, notes: string | null, userId: string): Promise<void> {
  if (notes === null || notes.trim() === "") {
    await c.query("UPDATE community_internal_notes SET notes = '', updated_by = $2, updated_at = now() WHERE tenant_id = $1", [id, userId]);
    return;
  }
  await c.query(
    `INSERT INTO community_internal_notes (tenant_id, notes, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id) DO UPDATE SET notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [id, notes.trim(), userId],
  );
}

interface CommunityRow {
  id: string;
  name: string;
  status: string;
  created_at: Date;
  community_type: string | null;
  description: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  locality: string | null;
  unit_count: number | null;
  address: string | null;
  latitude: string | null;
  longitude: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  population: number | null;
  internal_notes: string | null;
}

const COMMUNITY_SELECT = `
  SELECT o.id, o.name, o.status, o.created_at,
         p.community_type, p.description, p.country, p.state, p.city, p.locality, p.unit_count,
         v.address, v.latitude, v.longitude, v.contact_name, v.contact_email, v.contact_phone, v.population,
         NULLIF(n.notes, '') AS internal_notes
    FROM organizations o
    LEFT JOIN community_profiles p ON p.tenant_id = o.id
    LEFT JOIN community_private v ON v.tenant_id = o.id
    LEFT JOIN community_internal_notes n ON n.tenant_id = o.id`; // n is platform-only: other callers get NULL from row-level security

function toCommunity(r: CommunityRow) {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    communityType: r.community_type,
    description: r.description,
    country: r.country,
    state: r.state,
    city: r.city,
    locality: r.locality,
    unitCount: r.unit_count,
    address: r.address,
    latitude: r.latitude === null ? null : Number(r.latitude),
    longitude: r.longitude === null ? null : Number(r.longitude),
    contactName: r.contact_name,
    contactEmail: r.contact_email,
    contactPhone: r.contact_phone,
    population: r.population,
    internalNotes: r.internal_notes,
  };
}

/* ------------------------------------------------------------ status workflow */

interface Transition {
  from: string;
  to: string;
  /** Permission needed (held in the acting context: platform roles in platform scope, tenant roles otherwise). */
  permission: string;
  noteRequired: boolean;
}

/** The onboarding workflow: Registration, Verification, Administrator assignment and configuration, Approval, Activation. */
export const COMMUNITY_TRANSITIONS: Transition[] = [
  { from: "draft", to: "verification", permission: "communities.update", noteRequired: false },
  { from: "verification", to: "draft", permission: "communities.update", noteRequired: true },
  { from: "verification", to: "active", permission: "communities.approve", noteRequired: true },
  { from: "active", to: "suspended", permission: "communities.approve", noteRequired: true },
  { from: "suspended", to: "active", permission: "communities.approve", noteRequired: true },
];

/** What still stands in the way of moving to `to` (empty list = ready). Messages are written for the people doing onboarding. */
async function blockers(c: PoolClient, id: string, to: string): Promise<string[]> {
  const out: string[] = [];
  if (to === "verification") {
    const { rows } = await c.query<CommunityRow>(`${COMMUNITY_SELECT} WHERE o.id = $1`, [id]);
    const r = rows[0];
    const need = (ok: unknown, message: string) => {
      if (!ok) out.push(message);
    };
    need(r?.country, "Add the country.");
    need(r?.state, "Add the state.");
    need(r?.city, "Add the city.");
    need(r?.locality, "Add the locality.");
    need(r?.address, "Add the street address.");
    need(r?.unit_count, "Add the number of homes (units).");
    need(r?.contact_name, "Add a contact person.");
    need(r?.contact_email || r?.contact_phone, "Add a contact email or phone number.");
  }
  if (to === "active") {
    const { rows } = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM role_assignments ra
         JOIN roles r ON r.id = ra.role_id AND r.key = 'community_admin' AND r.tenant_id IS NULL
         JOIN memberships m ON m.tenant_id = ra.tenant_id AND m.user_id = ra.user_id AND m.status = 'active'
        WHERE ra.tenant_id = $1`,
      [id],
    );
    if ((rows[0]?.n ?? 0) < 1) out.push("Assign at least one community administrator.");
  }
  return out;
}

/* ------------------------------------------------------------------- routes */

export async function communityRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool } = deps;
  const requirePermission = makeRequirePermission(deps);
  const requireCommunity = makeRequireCommunityPermission(deps);
  const authenticate = makeAuthenticate(deps);

  const state = (req: { tenantState?: TenantState }): TenantState => {
    if (!req.tenantState) throw new AppError(400, "tenant_required", "Select an organization first.");
    return req.tenantState;
  };
  const requirePlatformScope = (s: TenantState): void => {
    if (!s.platformScope) throw new AppError(403, "platform_scope_required", "This action is for the platform operations team.");
  };

  /* ---- directory: any signed-in user can find ACTIVE communities (public profile only) ---- */

  app.get("/directory/communities", { preHandler: authenticate }, async (req) => {
    const q = directoryQuery.parse(req.query);
    const auth = req.auth;
    if (!auth) throw new AppError(401, "unauthenticated", "Authentication is required.");
    const pattern = q.q ? `%${q.q.replace(/[\\%_]/gu, (m) => `\\${m}`)}%` : null;
    const rows = await withContext(pool, { userId: auth.userId }, async (c) => {
      const res = await c.query<{ id: string; name: string; city: string | null; locality: string | null; community_type: string | null }>(
        `SELECT o.id, o.name, p.city, p.locality, p.community_type
           FROM organizations o JOIN community_profiles p ON p.tenant_id = o.id
          WHERE o.type = 'community' AND o.status = 'active'
            AND ($1::text IS NULL OR o.name ILIKE $1 ESCAPE '\\' OR p.city ILIKE $1 ESCAPE '\\' OR p.locality ILIKE $1 ESCAPE '\\')
          ORDER BY o.name LIMIT $2`,
        [pattern, q.limit],
      );
      return res.rows;
    });
    return { data: rows.map((r) => ({ id: r.id, name: r.name, city: r.city, locality: r.locality, communityType: r.community_type })) };
  });

  /* ---- registration and listing (platform operations) ---- */

  app.post("/communities", { preHandler: requirePermission("communities.create") }, async (req, reply) => {
    const s = state(req);
    requirePlatformScope(s);
    const body = createSchema.parse(req.body) as Record<string, unknown> & { name: string };
    const id = await withContext(pool, dbContext(s), async (c) => {
      const org = await c.query<{ id: string }>("INSERT INTO organizations (type, name, status) VALUES ('community', $1, 'draft') RETURNING id", [body.name]);
      const newId = org.rows[0]?.id;
      if (!newId) throw new Error("organization insert returned no row");
      await insertProfile(c, newId, body);
      if (typeof body["internalNotes"] === "string") await saveInternalNotes(c, newId, body["internalNotes"], s.userId);
      await c.query("INSERT INTO community_status_history (tenant_id, to_status, changed_by) VALUES ($1, 'draft', $2)", [newId, s.userId]);
      await writeAudit(c, { tenantId: newId, actorUserId: s.userId, action: "community.created", entityType: "organization", entityId: newId, requestId: req.id });
      return newId;
    });
    return reply.code(201).send(await loadCommunity(s, id));
  });

  app.get("/communities", { preHandler: requirePermission("communities.read") }, async (req) => {
    const s = state(req);
    requirePlatformScope(s);
    const q = listQuery.parse(req.query);
    const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
    const rows = await withContext(pool, dbContext(s), async (c) => {
      const params: unknown[] = [q.limit + 1];
      const where: string[] = ["o.type = 'community'"];
      if (q.status) {
        params.push(q.status);
        where.push(`o.status = $${params.length}`);
      }
      if (q.q) {
        params.push(`%${q.q.replace(/[\\%_]/gu, (m) => `\\${m}`)}%`);
        where.push(`(o.name ILIKE $${params.length} ESCAPE '\\' OR p.city ILIKE $${params.length} ESCAPE '\\')`);
      }
      if (cursor) {
        params.push(cursor.t, cursor.i);
        where.push(`(o.created_at, o.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      }
      const res = await c.query<CommunityRow & { cursor_t: string }>(
        `${COMMUNITY_SELECT.replace("SELECT o.id,", `SELECT ${cursorTimestamp("o.created_at")} AS cursor_t, o.id,`)}
          WHERE ${where.join(" AND ")} ORDER BY o.created_at DESC, o.id DESC LIMIT $1`,
        params,
      );
      return res.rows;
    });
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const last = page[page.length - 1];
    return {
      data: page.map((r) => ({ ...toCommunity(r), address: undefined, latitude: undefined, longitude: undefined, contactName: undefined, contactEmail: undefined, contactPhone: undefined, internalNotes: undefined })),
      page: { hasMore, nextCursor: hasMore && last ? encodeCursor(last.cursor_t, last.id) : null },
    };
  });

  /* ---- one community ---- */

  app.get("/communities/:id", { preHandler: requireCommunity("communities.read") }, async (req) => {
    const s = state(req);
    const { id } = idParam.parse(req.params);
    const community = await loadCommunity(s, id);
    const transitions = await withContext(pool, dbContext(s), async (c) => {
      const out = [];
      for (const t of COMMUNITY_TRANSITIONS.filter((x) => x.from === community.status && s.permissions.has(x.permission))) {
        out.push({ to: t.to, noteRequired: t.noteRequired, blockers: await blockers(c, id, t.to) });
      }
      return out;
    });
    return { ...community, transitions };
  });

  app.patch("/communities/:id", { preHandler: requireCommunity("communities.update") }, async (req) => {
    const s = state(req);
    const { id } = idParam.parse(req.params);
    const body = patchSchema.parse(req.body) as Record<string, unknown>;
    if ("internalNotes" in body && !s.platformScope) {
      throw new AppError(403, "platform_only_field", "Internal notes can only be changed by the platform team.");
    }
    await withContext(pool, dbContext(s), async (c) => {
      const exists = await c.query("SELECT 1 FROM organizations WHERE id = $1 AND type = 'community'", [id]);
      if (!exists.rowCount) throw new AppError(404, "not_found", "Community not found.");
      if (typeof body["name"] === "string") await c.query("UPDATE organizations SET name = $2 WHERE id = $1", [id, body["name"]]);
      await updateTable(c, "community_profiles", PUBLIC_COLUMNS, id, body);
      await updateTable(c, "community_private", PRIVATE_COLUMNS, id, body);
      if ("internalNotes" in body) await saveInternalNotes(c, id, typeof body["internalNotes"] === "string" ? body["internalNotes"] : null, s.userId);
      await writeAudit(c, {
        tenantId: id,
        actorUserId: s.userId,
        action: "community.updated",
        entityType: "organization",
        entityId: id,
        metadata: { fields: Object.keys(body) }, // field names only; values may be personal data
        requestId: req.id,
      });
    });
    return loadCommunity(s, id);
  });

  // Any role that may read the community can reach this route; the specific permission each step needs
  // (update to submit, approve to activate or suspend) is checked against the workflow table below.
  app.post("/communities/:id/transitions", { preHandler: requireCommunity("communities.read") }, async (req) => {
    const s = state(req);
    const { id } = idParam.parse(req.params);
    const body = transitionSchema.parse(req.body);
    await withContext(pool, dbContext(s), async (c) => {
      const cur = await c.query<{ status: string }>("SELECT status FROM organizations WHERE id = $1 AND type = 'community' FOR UPDATE", [id]);
      const from = cur.rows[0]?.status;
      if (!from) throw new AppError(404, "not_found", "Community not found.");
      const t = COMMUNITY_TRANSITIONS.find((x) => x.from === from && x.to === body.to);
      if (!t) throw new AppError(409, "invalid_transition", `A community that is ${from} cannot move to ${body.to}.`);
      if (!s.permissions.has(t.permission)) throw forbidden();
      if (t.noteRequired && !body.note?.trim()) throw new AppError(400, "note_required", "Add a note explaining this change.");
      const pending = await blockers(c, id, body.to);
      if (pending.length > 0) throw new AppError(422, "transition_blocked", "This community is not ready for that step yet.", pending);
      await c.query("UPDATE organizations SET status = $2 WHERE id = $1", [id, body.to]);
      await c.query("INSERT INTO community_status_history (tenant_id, from_status, to_status, note, changed_by) VALUES ($1, $2, $3, $4, $5)", [
        id,
        from,
        body.to,
        body.note?.trim() ?? null,
        s.userId,
      ]);
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "community.status_changed", entityType: "organization", entityId: id, metadata: { from, to: body.to }, requestId: req.id });
    });
    return loadCommunity(s, id);
  });

  app.get("/communities/:id/history", { preHandler: requireCommunity("communities.read") }, async (req) => {
    const s = state(req);
    const { id } = idParam.parse(req.params);
    const rows = await withContext(pool, dbContext(s), async (c) => {
      const res = await c.query<{ id: string; from_status: string | null; to_status: string; note: string | null; display_name: string | null; created_at: Date }>(
        `SELECT h.id, h.from_status, h.to_status, h.note, u.display_name, h.created_at
           FROM community_status_history h LEFT JOIN users u ON u.id = h.changed_by
          WHERE h.tenant_id = $1 ORDER BY h.created_at DESC, h.id DESC LIMIT 100`,
        [id],
      );
      return res.rows;
    });
    return { data: rows.map((r) => ({ id: r.id, from: r.from_status, to: r.to_status, note: r.note, changedBy: r.display_name, at: r.created_at.toISOString() })) };
  });

  /* ---- community administrators (assigned by platform operations) ---- */

  async function listAdmins(s: TenantState, id: string) {
    return withContext(pool, dbContext(s), async (c) => {
      const res = await c.query<{ id: string; display_name: string; email: string }>(
        `SELECT u.id, u.display_name, u.email
           FROM role_assignments ra
           JOIN roles r ON r.id = ra.role_id AND r.key = 'community_admin' AND r.tenant_id IS NULL
           JOIN users u ON u.id = ra.user_id
           JOIN memberships m ON m.tenant_id = ra.tenant_id AND m.user_id = ra.user_id AND m.status = 'active'
          WHERE ra.tenant_id = $1 ORDER BY u.display_name`,
        [id],
      );
      return res.rows.map((r) => ({ userId: r.id, displayName: r.display_name, email: r.email }));
    });
  }

  app.get("/communities/:id/admins", { preHandler: requireCommunity("communities.read") }, async (req) => {
    const { id } = idParam.parse(req.params);
    return { data: await listAdmins(state(req), id) };
  });

  app.post("/communities/:id/admins", { preHandler: requireCommunity("communities.assign_admin") }, async (req, reply) => {
    const s = state(req);
    requirePlatformScope(s);
    const { id } = idParam.parse(req.params);
    const { email } = adminSchema.parse(req.body);
    await withContext(pool, dbContext(s), async (c) => {
      const org = await c.query("SELECT 1 FROM organizations WHERE id = $1 AND type = 'community'", [id]);
      if (!org.rowCount) throw new AppError(404, "not_found", "Community not found.");
      const user = await c.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1 AND status = 'active' AND deleted_at IS NULL", [email]);
      const userId = user.rows[0]?.id;
      if (!userId) throw new AppError(404, "user_not_found", "No account uses that email. Ask the person to register first.");
      await c.query(
        `INSERT INTO memberships (tenant_id, user_id, status, join_method, decided_by, decided_at)
         VALUES ($1, $2, 'active', 'admin_added', $3, now())
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = 'active', decided_by = $3, decided_at = now()`,
        [id, userId, s.userId],
      );
      await c.query(
        `INSERT INTO role_assignments (tenant_id, user_id, role_id)
         SELECT $1, $2, id FROM roles WHERE key = 'community_admin' AND tenant_id IS NULL
         ON CONFLICT DO NOTHING`,
        [id, userId],
      );
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "community.admin_assigned", entityType: "user", entityId: userId, requestId: req.id });
    });
    return reply.code(201).send({ data: await listAdmins(s, id) });
  });

  app.delete("/communities/:id/admins/:userId", { preHandler: requireCommunity("communities.assign_admin") }, async (req, reply) => {
    const s = state(req);
    requirePlatformScope(s);
    const { id, userId } = z.object({ id: z.uuid(), userId: z.uuid() }).parse(req.params);
    await withContext(pool, dbContext(s), async (c) => {
      const org = await c.query<{ status: string }>("SELECT status FROM organizations WHERE id = $1 AND type = 'community' FOR UPDATE", [id]);
      if (!org.rows[0]) throw new AppError(404, "not_found", "Community not found.");
      if (org.rows[0].status === "active") {
        const admins = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM role_assignments ra JOIN roles r ON r.id = ra.role_id AND r.key = 'community_admin' AND r.tenant_id IS NULL
            WHERE ra.tenant_id = $1 AND ra.user_id <> $2`,
          [id, userId],
        );
        if ((admins.rows[0]?.n ?? 0) < 1) throw new AppError(422, "last_admin", "An active community needs at least one administrator. Assign another first.");
      }
      const res = await c.query(
        `DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2
            AND role_id IN (SELECT id FROM roles WHERE key = 'community_admin' AND tenant_id IS NULL)`,
        [id, userId],
      );
      if (!res.rowCount) throw new AppError(404, "not_found", "That person is not an administrator of this community.");
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "community.admin_removed", entityType: "user", entityId: userId, requestId: req.id });
    });
    return reply.code(204).send();
  });

  /* ---- helpers needing the pool ---- */

  async function loadCommunity(s: TenantState, id: string) {
    const row = await withContext(pool, dbContext(s), async (c) => {
      const res = await c.query<CommunityRow>(`${COMMUNITY_SELECT} WHERE o.id = $1 AND o.type = 'community'`, [id]);
      return res.rows[0];
    });
    if (!row) throw new AppError(404, "not_found", "Community not found.");
    return toCommunity(row);
  }
}

/* ------------------------------------------------------------ SQL helpers */

async function insertProfile(c: PoolClient, id: string, body: Record<string, unknown>): Promise<void> {
  const pub = columnsFrom(PUBLIC_COLUMNS, body);
  const priv = columnsFrom(PRIVATE_COLUMNS, body);
  await c.query(
    `INSERT INTO community_profiles (tenant_id${pub.cols.map((x) => `, ${x}`).join("")}) VALUES ($1${pub.cols.map((_, i) => `, $${i + 2}`).join("")})`,
    [id, ...pub.values],
  );
  await c.query(
    `INSERT INTO community_private (tenant_id${priv.cols.map((x) => `, ${x}`).join("")}) VALUES ($1${priv.cols.map((_, i) => `, $${i + 2}`).join("")})`,
    [id, ...priv.values],
  );
}

/** Maps only whitelisted API keys to columns; any other key is ignored (the schema already rejects unknown keys). */
function columnsFrom(map: Record<string, string>, body: Record<string, unknown>): { cols: string[]; values: unknown[] } {
  const cols: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(map)) {
    if (key in body) {
      cols.push(column);
      values.push(body[key]);
    }
  }
  return { cols, values };
}

async function updateTable(c: PoolClient, table: "community_profiles" | "community_private", map: Record<string, string>, id: string, body: Record<string, unknown>): Promise<void> {
  const { cols, values } = columnsFrom(map, body);
  if (cols.length === 0) return;
  await c.query(`UPDATE ${table} SET ${cols.map((col, i) => `${col} = $${i + 2}`).join(", ")} WHERE tenant_id = $1`, [id, ...values]);
}
