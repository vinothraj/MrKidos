import type { FastifyInstance } from "fastify";
import { withContext } from "@kidos/db";
import type { PoolClient } from "pg";
import { z } from "zod";
import { writeAudit } from "../audit";
import { AppError, forbidden } from "../errors";
import { dbContext, makeRequirePermission, makeRequireVendorPermission } from "../guards";
import { cursorTimestamp, decodeCursor, encodeCursor, pageParams } from "../pagination";
import { insertRow, likePattern, updateRow } from "../sql-helpers";
import type { Deps, TenantState } from "../types";
import { emailSchema } from "./auth";

/* ------------------------------------------------------------------ schemas */

const text = (max: number) => z.string().trim().max(max);
const publicFields = {
  businessType: z.enum(["individual", "business"]),
  tagline: text(140).nullable(),
  description: text(3000).nullable(),
  country: text(80).min(1).nullable(),
  state: text(80).min(1).nullable(),
  city: text(80).min(1).nullable(),
  locality: text(120).min(1).nullable(),
  yearsExperience: z.number().int().min(0).max(80).nullable(),
  website: z.string().trim().max(200).regex(/^https?:\/\/\S+$/u, "Enter a web address starting with http:// or https://.").nullable(),
};
const privateFields = {
  legalName: text(160).min(1).nullable(),
  registrationNumber: text(80).min(1).nullable(),
  contactName: text(120).min(1).nullable(),
  contactEmail: z.email().max(254).nullable(),
  contactPhone: text(30).min(5).nullable(),
  address: text(300).min(1).nullable(),
};
const allFields = { ...publicFields, ...privateFields, internalNotes: text(2000).nullable() };
const optionalFields = Object.fromEntries(Object.entries(allFields).map(([k, v]) => [k, v.optional()])) as {
  [K in keyof typeof allFields]: z.ZodOptional<(typeof allFields)[K]>;
};

const createSchema = z.object({ name: text(120).min(2), ...optionalFields }).strict();
const patchSchema = z
  .object({ name: text(120).min(2).optional(), ...optionalFields })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to change.");

const PUBLIC_COLUMNS: Record<string, string> = {
  businessType: "business_type",
  tagline: "tagline",
  description: "description",
  country: "country",
  state: "state",
  city: "city",
  locality: "locality",
  yearsExperience: "years_experience",
  website: "website",
};
const PRIVATE_COLUMNS: Record<string, string> = {
  legalName: "legal_name",
  registrationNumber: "registration_number",
  contactName: "contact_name",
  contactEmail: "contact_email",
  contactPhone: "contact_phone",
  address: "address",
};

const idParam = z.object({ id: z.uuid() });
const listQuery = z
  .object({
    ...pageParams,
    status: z.enum(["draft", "verification", "active", "suspended"]).optional(),
    q: z.string().trim().max(80).optional(),
    /** Active vendors whose required documents have lapsed (hidden from residents) or lapse within 30 days. */
    vetting: z.enum(["lapsed", "expiring"]).optional(),
  })
  .strict();
const transitionSchema = z.object({ to: z.enum(["draft", "verification", "active", "suspended"]), note: text(1000).optional() }).strict();
const VENDOR_ROLES = ["vendor_owner", "vendor_admin", "vendor_staff", "vendor_service_provider"] as const;
const staffSchema = z.object({ email: emailSchema, role: z.enum(VENDOR_ROLES) }).strict();
const categoriesSchema = z.object({ categoryIds: z.array(z.uuid()).max(20) }).strict();
const areaSchema = z
  .object({
    communityId: z.uuid().optional(),
    city: text(80).min(1).optional(),
    travelFeeMinor: z.number().int().min(0).max(100_000_000).default(0),
    travelNote: text(300).nullable().optional(),
  })
  .strict()
  .refine((v) => (v.communityId === undefined) !== (v.city === undefined), "Give either a community or a city.");

/* -------------------------------------------------------------- row mapping */

interface VendorRow {
  id: string;
  name: string;
  status: string;
  created_at: Date;
  business_type: string | null;
  tagline: string | null;
  description: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  locality: string | null;
  years_experience: number | null;
  website: string | null;
  legal_name: string | null;
  registration_number: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  address: string | null;
  internal_notes: string | null;
  vetting: string | null;
  vetting_valid_until: string | null;
}

/**
 * Whether an ACTIVE vendor's vetting is still current. 'lapsed' vendors are hidden from residents by the database until
 * their documents are renewed; 'expiring' ones lapse within 30 days. Not applicable (null) before activation.
 */
const VETTING_STATE = `
  CASE WHEN o.status <> 'active' THEN NULL
       WHEN vs.tenant_id IS NULL OR NOT vs.complete OR (vs.valid_until IS NOT NULL AND vs.valid_until < current_date) THEN 'lapsed'
       WHEN vs.valid_until IS NOT NULL AND vs.valid_until <= current_date + 30 THEN 'expiring'
       ELSE 'current' END`;

const VENDOR_SELECT = `
  SELECT o.id, o.name, o.status, o.created_at,
         p.business_type, p.tagline, p.description, p.country, p.state, p.city, p.locality, p.years_experience, p.website,
         v.legal_name, v.registration_number, v.contact_name, v.contact_email, v.contact_phone, v.address,
         NULLIF(n.notes, '') AS internal_notes,
         ${VETTING_STATE} AS vetting, vs.valid_until::text AS vetting_valid_until
    FROM organizations o
    LEFT JOIN vendor_profiles p ON p.tenant_id = o.id
    LEFT JOIN vendor_private v ON v.tenant_id = o.id
    LEFT JOIN vendor_internal_notes n ON n.tenant_id = o.id
    LEFT JOIN vendor_vetting_summary vs ON vs.tenant_id = o.id`;

function toVendor(r: VendorRow) {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    businessType: r.business_type,
    tagline: r.tagline,
    description: r.description,
    country: r.country,
    state: r.state,
    city: r.city,
    locality: r.locality,
    yearsExperience: r.years_experience,
    website: r.website,
    legalName: r.legal_name,
    registrationNumber: r.registration_number,
    contactName: r.contact_name,
    contactEmail: r.contact_email,
    contactPhone: r.contact_phone,
    address: r.address,
    internalNotes: r.internal_notes,
    vetting: r.vetting ? { state: r.vetting, validUntil: r.vetting_valid_until } : null,
  };
}

/* ------------------------------------------------------------ status workflow */

interface Transition {
  from: string;
  to: string;
  permission: string;
  noteRequired: boolean;
}

/** Registration, Contact verification, Profile, Categories, Locations, Offerings, Documents, Review, Approval, Activation. */
export const VENDOR_TRANSITIONS: Transition[] = [
  { from: "draft", to: "verification", permission: "vendors.update", noteRequired: false },
  { from: "verification", to: "draft", permission: "vendors.update", noteRequired: true },
  { from: "verification", to: "active", permission: "vendors.approve", noteRequired: true },
  { from: "active", to: "suspended", permission: "vendors.suspend", noteRequired: true },
  { from: "suspended", to: "active", permission: "vendors.approve", noteRequired: true },
];

/** What still stands in the way of moving to `to`, written for the people doing onboarding. */
export async function vendorBlockers(c: PoolClient, id: string, to: string): Promise<string[]> {
  const out: string[] = [];
  if (to === "verification") {
    const { rows } = await c.query<VendorRow>(`${VENDOR_SELECT} WHERE o.id = $1`, [id]);
    const r = rows[0];
    const need = (ok: unknown, message: string) => {
      if (!ok) out.push(message);
    };
    need(r?.description, "Add a description of what the vendor offers.");
    need(r?.country, "Add the country.");
    need(r?.state, "Add the state.");
    need(r?.city, "Add the city.");
    need(r?.contact_name, "Add a contact person.");
    need(r?.contact_email || r?.contact_phone, "Add a contact email or phone number.");
    const cats = await c.query("SELECT 1 FROM vendor_categories WHERE tenant_id = $1 LIMIT 1", [id]);
    need(cats.rowCount, "Choose at least one category.");
    const areas = await c.query("SELECT 1 FROM vendor_service_areas WHERE tenant_id = $1 LIMIT 1", [id]);
    need(areas.rowCount, "Add at least one place the vendor serves (a community or a city).");
  }
  if (to === "active") {
    const missing = await c.query<{ label: string }>(
      `SELECT r.label FROM vetting_requirements r
        WHERE r.is_required AND NOT EXISTS (
          SELECT 1 FROM vendor_documents d
           WHERE d.tenant_id = $1 AND d.requirement_key = r.key AND d.status = 'verified'
             AND (d.expires_on IS NULL OR d.expires_on >= current_date))
        ORDER BY r.sort_order`,
      [id],
    );
    for (const m of missing.rows) out.push(`Verify a current document for: ${m.label}.`);
  }
  return out;
}

/* ------------------------------------------------------------------- routes */

export async function vendorRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool } = deps;
  const requirePermission = makeRequirePermission(deps);
  const requireVendor = makeRequireVendorPermission(deps);

  const state = (req: { tenantState?: TenantState }): TenantState => {
    if (!req.tenantState) throw new AppError(400, "tenant_required", "Select an organization first.");
    return req.tenantState;
  };
  const requirePlatformScope = (s: TenantState): void => {
    if (!s.platformScope) throw new AppError(403, "platform_scope_required", "This action is for the platform operations team.");
  };

  async function loadVendor(s: TenantState, id: string) {
    const row = await withContext(pool, dbContext(s), async (c) => (await c.query<VendorRow>(`${VENDOR_SELECT} WHERE o.id = $1 AND o.type = 'vendor'`, [id])).rows[0]);
    if (!row) throw new AppError(404, "not_found", "Vendor not found.");
    return toVendor(row);
  }

  async function saveInternalNotes(c: PoolClient, id: string, notes: string | null, userId: string): Promise<void> {
    await c.query(
      `INSERT INTO vendor_internal_notes (tenant_id, notes, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO UPDATE SET notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [id, notes?.trim() ?? "", userId],
    );
  }

  /* ---- registration and listing (platform operations) ---- */

  app.post("/vendors", { preHandler: requirePermission("vendors.create") }, async (req, reply) => {
    const s = state(req);
    requirePlatformScope(s);
    const body = createSchema.parse(req.body) as Record<string, unknown> & { name: string };
    const id = await withContext(pool, dbContext(s), async (c) => {
      const org = await c.query<{ id: string }>("INSERT INTO organizations (type, name, status) VALUES ('vendor', $1, 'draft') RETURNING id", [body.name]);
      const newId = org.rows[0]?.id;
      if (!newId) throw new Error("organization insert returned no row");
      await insertRow(c, "vendor_profiles", "tenant_id", newId, PUBLIC_COLUMNS, body);
      await insertRow(c, "vendor_private", "tenant_id", newId, PRIVATE_COLUMNS, body);
      if (typeof body["internalNotes"] === "string") await saveInternalNotes(c, newId, body["internalNotes"], s.userId);
      await c.query("INSERT INTO vendor_status_history (tenant_id, to_status, changed_by) VALUES ($1, 'draft', $2)", [newId, s.userId]);
      await writeAudit(c, { tenantId: newId, actorUserId: s.userId, action: "vendor.created", entityType: "organization", entityId: newId, requestId: req.id });
      return newId;
    });
    return reply.code(201).send(await loadVendor(s, id));
  });

  app.get("/vendors", { preHandler: requirePermission("vendors.read") }, async (req) => {
    const s = state(req);
    requirePlatformScope(s);
    const q = listQuery.parse(req.query);
    const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
    const rows = await withContext(pool, dbContext(s), async (c) => {
      const params: unknown[] = [q.limit + 1];
      const where: string[] = ["o.type = 'vendor'"];
      if (q.status) {
        params.push(q.status);
        where.push(`o.status = $${params.length}`);
      }
      if (q.q) {
        params.push(likePattern(q.q));
        where.push(`(o.name ILIKE $${params.length} ESCAPE '\\' OR p.city ILIKE $${params.length} ESCAPE '\\')`);
      }
      if (q.vetting) {
        params.push(q.vetting);
        where.push(`(${VETTING_STATE}) = $${params.length}`);
      }
      if (cursor) {
        params.push(cursor.t, cursor.i);
        where.push(`(o.created_at, o.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      }
      const res = await c.query<{ id: string; name: string; status: string; created_at: Date; business_type: string | null; city: string | null; locality: string | null; vetting: string | null; vetting_valid_until: string | null; cursor_t: string }>(
        `SELECT o.id, o.name, o.status, o.created_at, p.business_type, p.city, p.locality, ${VETTING_STATE} AS vetting, vs.valid_until::text AS vetting_valid_until,
                ${cursorTimestamp("o.created_at")} AS cursor_t
           FROM organizations o LEFT JOIN vendor_profiles p ON p.tenant_id = o.id LEFT JOIN vendor_vetting_summary vs ON vs.tenant_id = o.id
          WHERE ${where.join(" AND ")} ORDER BY o.created_at DESC, o.id DESC LIMIT $1`,
        params,
      );
      return res.rows;
    });
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const last = page[page.length - 1];
    return {
      data: page.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        businessType: r.business_type,
        city: r.city,
        locality: r.locality,
        vetting: r.vetting ? { state: r.vetting, validUntil: r.vetting_valid_until } : null,
        createdAt: r.created_at.toISOString(),
      })),
      page: { hasMore, nextCursor: hasMore && last ? encodeCursor(last.cursor_t, last.id) : null },
    };
  });

  /* ---- one vendor ---- */

  app.get("/vendors/:id", { preHandler: requireVendor("vendors.read") }, async (req) => {
    const s = state(req);
    const { id } = idParam.parse(req.params);
    const vendor = await loadVendor(s, id);
    const extras = await withContext(pool, dbContext(s), async (c) => {
      const transitions = [];
      for (const t of VENDOR_TRANSITIONS.filter((x) => x.from === vendor.status && s.permissions.has(x.permission))) {
        transitions.push({ to: t.to, noteRequired: t.noteRequired, blockers: await vendorBlockers(c, id, t.to) });
      }
      const cats = await c.query<{ category_id: string }>("SELECT category_id FROM vendor_categories WHERE tenant_id = $1", [id]);
      return { transitions, categoryIds: cats.rows.map((r) => r.category_id) };
    });
    return { ...vendor, ...extras };
  });

  app.patch("/vendors/:id", { preHandler: requireVendor("vendors.update") }, async (req) => {
    const s = state(req);
    const { id } = idParam.parse(req.params);
    const body = patchSchema.parse(req.body) as Record<string, unknown>;
    if ("internalNotes" in body && !s.platformScope) {
      throw new AppError(403, "platform_only_field", "Internal notes can only be changed by the platform team.");
    }
    await withContext(pool, dbContext(s), async (c) => {
      const exists = await c.query("SELECT 1 FROM organizations WHERE id = $1 AND type = 'vendor'", [id]);
      if (!exists.rowCount) throw new AppError(404, "not_found", "Vendor not found.");
      if (typeof body["name"] === "string") await c.query("UPDATE organizations SET name = $2 WHERE id = $1", [id, body["name"]]);
      await updateRow(c, "vendor_profiles", "tenant_id", id, PUBLIC_COLUMNS, body);
      await updateRow(c, "vendor_private", "tenant_id", id, PRIVATE_COLUMNS, body);
      if ("internalNotes" in body) await saveInternalNotes(c, id, typeof body["internalNotes"] === "string" ? body["internalNotes"] : null, s.userId);
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "vendor.updated", entityType: "organization", entityId: id, metadata: { fields: Object.keys(body) }, requestId: req.id });
    });
    return loadVendor(s, id);
  });

  app.post("/vendors/:id/transitions", { preHandler: requireVendor("vendors.read") }, async (req) => {
    const s = state(req);
    const { id } = idParam.parse(req.params);
    const body = transitionSchema.parse(req.body);
    await withContext(pool, dbContext(s), async (c) => {
      const cur = await c.query<{ status: string }>("SELECT status FROM organizations WHERE id = $1 AND type = 'vendor' FOR UPDATE", [id]);
      const from = cur.rows[0]?.status;
      if (!from) throw new AppError(404, "not_found", "Vendor not found.");
      const t = VENDOR_TRANSITIONS.find((x) => x.from === from && x.to === body.to);
      if (!t) throw new AppError(409, "invalid_transition", `A vendor that is ${from} cannot move to ${body.to}.`);
      if (!s.permissions.has(t.permission)) throw forbidden();
      if (t.noteRequired && !body.note?.trim()) throw new AppError(400, "note_required", "Add a note explaining this change.");
      const pending = await vendorBlockers(c, id, body.to);
      if (pending.length > 0) throw new AppError(422, "transition_blocked", "This vendor is not ready for that step yet.", pending);
      await c.query("UPDATE organizations SET status = $2 WHERE id = $1", [id, body.to]);
      await c.query("INSERT INTO vendor_status_history (tenant_id, from_status, to_status, note, changed_by) VALUES ($1, $2, $3, $4, $5)", [id, from, body.to, body.note?.trim() ?? null, s.userId]);
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "vendor.status_changed", entityType: "organization", entityId: id, metadata: { from, to: body.to }, requestId: req.id });
    });
    return loadVendor(s, id);
  });

  app.get("/vendors/:id/history", { preHandler: requireVendor("vendors.read") }, async (req) => {
    const s = state(req);
    const { id } = idParam.parse(req.params);
    const rows = await withContext(pool, dbContext(s), async (c) =>
      (
        await c.query<{ id: string; from_status: string | null; to_status: string; note: string | null; display_name: string | null; created_at: Date }>(
          `SELECT h.id, h.from_status, h.to_status, h.note, u.display_name, h.created_at
             FROM vendor_status_history h LEFT JOIN users u ON u.id = h.changed_by
            WHERE h.tenant_id = $1 ORDER BY h.created_at DESC, h.id DESC LIMIT 100`,
          [id],
        )
      ).rows,
    );
    return { data: rows.map((r) => ({ id: r.id, from: r.from_status, to: r.to_status, note: r.note, changedBy: r.display_name, at: r.created_at.toISOString() })) };
  });

  /* ---- categories the vendor works in ---- */

  app.put("/vendors/:id/categories", { preHandler: requireVendor("vendors.update") }, async (req) => {
    const s = state(req);
    const { id } = idParam.parse(req.params);
    const { categoryIds } = categoriesSchema.parse(req.body);
    const unique = [...new Set(categoryIds)];
    await withContext(pool, dbContext(s), async (c) => {
      const exists = await c.query("SELECT 1 FROM organizations WHERE id = $1 AND type = 'vendor'", [id]);
      if (!exists.rowCount) throw new AppError(404, "not_found", "Vendor not found.");
      if (unique.length > 0) {
        const ok = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM categories WHERE id = ANY($1) AND is_active AND parent_id IS NOT NULL", [unique]);
        if ((ok.rows[0]?.n ?? 0) !== unique.length) {
          throw new AppError(400, "validation_failed", "Choose categories from the list.", [{ field: "categoryIds", message: "One or more categories are not available." }]);
        }
      }
      await c.query("DELETE FROM vendor_categories WHERE tenant_id = $1", [id]);
      for (const categoryId of unique) await c.query("INSERT INTO vendor_categories (tenant_id, category_id) VALUES ($1, $2)", [id, categoryId]);
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "vendor.categories_set", metadata: { count: unique.length }, requestId: req.id });
    });
    return { categoryIds: unique };
  });

  /* ---- places the vendor serves ---- */

  interface AreaRow {
    id: string;
    community_id: string | null;
    community_name: string | null;
    city: string | null;
    travel_fee_minor: number;
    travel_note: string | null;
  }
  const toArea = (r: AreaRow) => ({ id: r.id, communityId: r.community_id, communityName: r.community_name, city: r.city, travelFeeMinor: r.travel_fee_minor, travelNote: r.travel_note });

  async function listAreas(s: TenantState, id: string) {
    return withContext(pool, dbContext(s), async (c) =>
      (
        await c.query<AreaRow>(
          `SELECT a.id, a.community_id, o.name AS community_name, a.city, a.travel_fee_minor, a.travel_note
             FROM vendor_service_areas a LEFT JOIN organizations o ON o.id = a.community_id
            WHERE a.tenant_id = $1 ORDER BY lower(coalesce(o.name, a.city)), a.id`,
          [id],
        )
      ).rows.map(toArea),
    );
  }

  app.get("/vendors/:id/service-areas", { preHandler: requireVendor("vendors.read") }, async (req) => {
    const { id } = idParam.parse(req.params);
    return { data: await listAreas(state(req), id) };
  });

  app.post("/vendors/:id/service-areas", { preHandler: requireVendor("vendors.update") }, async (req, reply) => {
    const s = state(req);
    const { id } = idParam.parse(req.params);
    const body = areaSchema.parse(req.body);
    await withContext(pool, dbContext(s), async (c) => {
      const exists = await c.query("SELECT 1 FROM organizations WHERE id = $1 AND type = 'vendor'", [id]);
      if (!exists.rowCount) throw new AppError(404, "not_found", "Vendor not found.");
      if (body.communityId) {
        // Only communities in the public directory (active) can be added.
        const community = await c.query("SELECT 1 FROM organizations WHERE id = $1 AND type = 'community' AND status = 'active'", [body.communityId]);
        if (!community.rowCount) throw new AppError(404, "not_found", "Community not found.");
      }
      try {
        await c.query("INSERT INTO vendor_service_areas (tenant_id, community_id, city, travel_fee_minor, travel_note) VALUES ($1, $2, $3, $4, $5)", [
          id,
          body.communityId ?? null,
          body.city ?? null,
          body.travelFeeMinor,
          body.travelNote ?? null,
        ]);
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new AppError(409, "already_listed", "That place is already listed.");
        throw err;
      }
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "vendor.service_area_added", requestId: req.id });
    });
    return reply.code(201).send({ data: await listAreas(s, id) });
  });

  app.delete("/vendors/:id/service-areas/:areaId", { preHandler: requireVendor("vendors.update") }, async (req, reply) => {
    const s = state(req);
    const { id, areaId } = z.object({ id: z.uuid(), areaId: z.uuid() }).parse(req.params);
    await withContext(pool, dbContext(s), async (c) => {
      const res = await c.query("DELETE FROM vendor_service_areas WHERE id = $1 AND tenant_id = $2", [areaId, id]);
      if (!res.rowCount) throw new AppError(404, "not_found", "Service area not found.");
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "vendor.service_area_removed", requestId: req.id });
    });
    return reply.code(204).send();
  });

  /* ---- the vendor's own people ---- */

  async function listStaff(s: TenantState, id: string) {
    return withContext(pool, dbContext(s), async (c) =>
      (
        await c.query<{ user_id: string; display_name: string; email: string; status: string; roles: string[] }>(
          `SELECT m.user_id, u.display_name, u.email, m.status,
                  COALESCE(array_agg(r.key ORDER BY r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
             FROM memberships m JOIN users u ON u.id = m.user_id
             LEFT JOIN role_assignments ra ON ra.tenant_id = m.tenant_id AND ra.user_id = m.user_id
             LEFT JOIN roles r ON r.id = ra.role_id
            WHERE m.tenant_id = $1 AND m.status IN ('active', 'suspended')
            GROUP BY m.user_id, u.display_name, u.email, m.status ORDER BY u.display_name`,
          [id],
        )
      ).rows.map((r) => ({ userId: r.user_id, displayName: r.display_name, email: r.email, status: r.status, roles: r.roles })),
    );
  }

  app.get("/vendors/:id/staff", { preHandler: requireVendor("vendors.read") }, async (req) => {
    const { id } = idParam.parse(req.params);
    return { data: await listStaff(state(req), id) };
  });

  app.post("/vendors/:id/staff", { preHandler: requireVendor("vendor_staff.manage") }, async (req, reply) => {
    const s = state(req);
    const { id } = idParam.parse(req.params);
    const body = staffSchema.parse(req.body);
    // The owner of a vendor is chosen by the platform team; owners can then invite their own staff.
    if (body.role === "vendor_owner" && !s.platformScope) throw new AppError(403, "platform_only_role", "Only the platform team can assign an owner.");

    // Look the person up by exactly this email (visible to nobody else through this context).
    const person = await withContext(pool, { userId: s.userId, loginEmail: body.email }, async (c) =>
      (await c.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1 AND status = 'active' AND deleted_at IS NULL", [body.email])).rows[0],
    );
    if (!person) throw new AppError(404, "user_not_found", "No account uses that email. Ask the person to register first.");

    await withContext(pool, dbContext(s), async (c) => {
      const org = await c.query("SELECT 1 FROM organizations WHERE id = $1 AND type = 'vendor'", [id]);
      if (!org.rowCount) throw new AppError(404, "not_found", "Vendor not found.");
      await c.query(
        `INSERT INTO memberships (tenant_id, user_id, status, join_method, decided_by, decided_at)
         VALUES ($1, $2, 'active', 'admin_added', $3, now())
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = 'active', decided_by = $3, decided_at = now()`,
        [id, person.id, s.userId],
      );
      await c.query(
        "INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = $3 AND tenant_id IS NULL ON CONFLICT DO NOTHING",
        [id, person.id, body.role],
      );
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "vendor.staff_added", entityType: "user", entityId: person.id, metadata: { role: body.role }, requestId: req.id });
    });
    return reply.code(201).send({ data: await listStaff(s, id) });
  });

  app.delete("/vendors/:id/staff/:userId", { preHandler: requireVendor("vendor_staff.manage") }, async (req, reply) => {
    const s = state(req);
    const { id, userId } = z.object({ id: z.uuid(), userId: z.uuid() }).parse(req.params);
    if (userId === s.userId) throw new AppError(422, "cannot_act_on_self", "You cannot remove yourself.");
    await withContext(pool, dbContext(s), async (c) => {
      const org = await c.query<{ status: string }>("SELECT status FROM organizations WHERE id = $1 AND type = 'vendor' FOR UPDATE", [id]);
      if (!org.rows[0]) throw new AppError(404, "not_found", "Vendor not found.");
      const target = await c.query<{ is_owner: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM role_assignments ra JOIN roles r ON r.id = ra.role_id
                         WHERE ra.tenant_id = m.tenant_id AND ra.user_id = m.user_id AND r.key = 'vendor_owner' AND r.tenant_id IS NULL) AS is_owner
           FROM memberships m WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.status IN ('active', 'suspended')`,
        [id, userId],
      );
      if (!target.rows[0]) throw new AppError(404, "not_found", "That person is not on this vendor's team.");
      if (target.rows[0].is_owner) {
        if (!s.platformScope) throw new AppError(403, "platform_only_role", "Only the platform team can remove an owner.");
        if (org.rows[0].status === "active") {
          const others = await c.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM role_assignments ra JOIN roles r ON r.id = ra.role_id AND r.key = 'vendor_owner' AND r.tenant_id IS NULL
              WHERE ra.tenant_id = $1 AND ra.user_id <> $2`,
            [id, userId],
          );
          if ((others.rows[0]?.n ?? 0) < 1) throw new AppError(422, "last_owner", "An active vendor needs at least one owner. Assign another first.");
        }
      }
      await c.query(
        `DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2
            AND role_id IN (SELECT id FROM roles WHERE tenant_id IS NULL AND key IN ('vendor_owner', 'vendor_admin', 'vendor_staff', 'vendor_service_provider'))`,
        [id, userId],
      );
      await c.query("UPDATE memberships SET status = 'removed', decided_by = $3, decided_at = now() WHERE tenant_id = $1 AND user_id = $2", [id, userId, s.userId]);
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "vendor.staff_removed", entityType: "user", entityId: userId, requestId: req.id });
    });
    return reply.code(204).send();
  });
}
