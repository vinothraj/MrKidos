import type { FastifyInstance } from "fastify";
import { withContext } from "@kidos/db";
import type { PoolClient } from "pg";
import { z } from "zod";
import { writeAudit } from "../audit";
import { AppError } from "../errors";
import { dbContext, makeRequireVendorPermission } from "../guards";
import type { Deps, TenantState } from "../types";

const MAX_OFFERINGS = 200;
const PRICING_MODELS =["fixed", "hourly", "per_participant", "per_event", "per_day", "package", "custom_quotation"] as const;
const text = (max: number) => z.string().trim().max(max);

const offeringBase = z.object({
  categoryId: z.uuid(),
  name: text(120).min(1),
  description: text(3000).nullable().optional(),
  offeringType: z.enum(["service", "workshop", "experience"]),
  pricingModel: z.enum(PRICING_MODELS),
  priceMinor: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  durationMinutes: z.number().int().min(5).max(1440).nullable().optional(),
  minParticipants: z.number().int().min(1).max(10_000).nullable().optional(),
  maxParticipants: z.number().int().min(1).max(10_000).nullable().optional(),
  ageMin: z.number().int().min(0).max(100).nullable().optional(),
  ageMax: z.number().int().min(0).max(100).nullable().optional(),
  equipment: text(1000).nullable().optional(),
  venueRequirements: text(1000).nullable().optional(),
  additionalCharges: text(1000).nullable().optional(),
  terms: text(3000).nullable().optional(),
  cancellationPolicy: text(1500).nullable().optional(),
  status: z.enum(["draft", "published", "archived"]),
});

/** Rules that span several fields. Applied to the complete offering, never to a partial update. */
function checkCrossFields(v: z.infer<typeof offeringBase>, ctx: z.RefinementCtx): void {
  if (v.pricingModel !== "custom_quotation" && (v.priceMinor === null || v.priceMinor === undefined)) {
    ctx.addIssue({ code: "custom", path: ["priceMinor"], message: "Enter a price, or choose \"custom quotation\"." });
  }
  if (v.minParticipants != null && v.maxParticipants != null && v.maxParticipants < v.minParticipants) {
    ctx.addIssue({ code: "custom", path: ["maxParticipants"], message: "The maximum cannot be less than the minimum." });
  }
  if (v.ageMin != null && v.ageMax != null && v.ageMax < v.ageMin) {
    ctx.addIssue({ code: "custom", path: ["ageMax"], message: "The oldest age cannot be below the youngest." });
  }
}
/**
 * Defaults belong to creation only. They must never be part of the update schema: zod would apply them to an
 * omitted field and a PATCH of just the name would silently reset a published offering back to a draft.
 */
const offeringSchema = offeringBase
  .extend({ offeringType: offeringBase.shape.offeringType.default("service"), status: offeringBase.shape.status.default("draft") })
  .strict()
  .superRefine(checkCrossFields);
const offeringPatch = offeringBase.partial().strict().refine((v) => Object.keys(v).length > 0, "Provide at least one field to change.");

const COLUMNS: Record<string, string> = {
  categoryId: "category_id",
  name: "name",
  description: "description",
  offeringType: "offering_type",
  pricingModel: "pricing_model",
  priceMinor: "price_minor",
  durationMinutes: "duration_minutes",
  minParticipants: "min_participants",
  maxParticipants: "max_participants",
  ageMin: "age_min",
  ageMax: "age_max",
  equipment: "equipment",
  venueRequirements: "venue_requirements",
  additionalCharges: "additional_charges",
  terms: "terms",
  cancellationPolicy: "cancellation_policy",
  status: "status",
};

export interface OfferingRow {
  id: string;
  category_id: string;
  category_name: string;
  name: string;
  description: string | null;
  offering_type: string;
  pricing_model: string;
  price_minor: string | null;
  currency: string;
  duration_minutes: number | null;
  min_participants: number | null;
  max_participants: number | null;
  age_min: number | null;
  age_max: number | null;
  equipment: string | null;
  venue_requirements: string | null;
  additional_charges: string | null;
  terms: string | null;
  cancellation_policy: string | null;
  status: string;
}
export const OFFERING_SELECT = `
  SELECT o.id, o.category_id, c.name AS category_name, o.name, o.description, o.offering_type, o.pricing_model, o.price_minor::text AS price_minor, o.currency::text AS currency,
         o.duration_minutes, o.min_participants, o.max_participants, o.age_min, o.age_max, o.equipment, o.venue_requirements,
         o.additional_charges, o.terms, o.cancellation_policy, o.status
    FROM offerings o JOIN categories c ON c.id = o.category_id`;

export const toOffering = (r: OfferingRow) => ({
  id: r.id,
  categoryId: r.category_id,
  category: r.category_name,
  name: r.name,
  description: r.description,
  offeringType: r.offering_type,
  pricingModel: r.pricing_model,
  priceMinor: r.price_minor === null ? null : Number(r.price_minor),
  currency: r.currency.trim(),
  durationMinutes: r.duration_minutes,
  minParticipants: r.min_participants,
  maxParticipants: r.max_participants,
  ageMin: r.age_min,
  ageMax: r.age_max,
  equipment: r.equipment,
  venueRequirements: r.venue_requirements,
  additionalCharges: r.additional_charges,
  terms: r.terms,
  cancellationPolicy: r.cancellation_policy,
  status: r.status,
});

/** What an offering needs before residents can see it. */
function publishBlockers(o: ReturnType<typeof toOffering>): string[] {
  const out: string[] = [];
  if (!o.description?.trim()) out.push("Add a description so families know what to expect.");
  if (!o.durationMinutes) out.push("Add how long it lasts.");
  if (!o.cancellationPolicy?.trim()) out.push("Add a cancellation policy.");
  return out;
}

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u, "Use 24-hour time like 09:30.");
const rulesBody = z
  .object({ rules: z.array(z.object({ weekday: z.number().int().min(0).max(6), startTime: timeOfDay, endTime: timeOfDay }).strict()).max(28) })
  .strict();
const blockBody = z
  .object({ startsAt: z.iso.datetime({ offset: true }), endsAt: z.iso.datetime({ offset: true }), reason: text(200).nullable().optional() })
  .strict()
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), { message: "The end must be after the start.", path: ["endsAt"] });

export async function offeringRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool } = deps;
  const requireVendor = makeRequireVendorPermission(deps);

  const state = (req: { tenantState?: TenantState }): TenantState => {
    if (!req.tenantState) throw new AppError(400, "tenant_required", "Select an organization first.");
    return req.tenantState;
  };

  async function assertCategory(c: PoolClient, categoryId: string): Promise<void> {
    const ok = await c.query("SELECT 1 FROM categories WHERE id = $1 AND is_active AND parent_id IS NOT NULL", [categoryId]);
    if (!ok.rowCount) throw new AppError(400, "validation_failed", "Choose a category from the list.", [{ field: "categoryId", message: "Choose an available category." }]);
  }

  async function loadOffering(c: PoolClient, id: string, offeringId: string) {
    const res = await c.query<OfferingRow>(`${OFFERING_SELECT} WHERE o.id = $1 AND o.tenant_id = $2`, [offeringId, id]);
    return res.rows[0] ? toOffering(res.rows[0]) : undefined;
  }

  /* ---------------------------------------------------------------- offerings */

  app.get("/vendors/:id/offerings", { preHandler: requireVendor("offerings.manage") }, async (req) => {
    const s = state(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const rows = await withContext(pool, dbContext(s), async (c) => (await c.query<OfferingRow>(`${OFFERING_SELECT} WHERE o.tenant_id = $1 ORDER BY o.status, o.name, o.id`, [id])).rows);
    return { data: rows.map(toOffering) };
  });

  app.post("/vendors/:id/offerings", { preHandler: requireVendor("offerings.manage") }, async (req, reply) => {
    const s = state(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = offeringSchema.parse(req.body);
    if (body.status === "archived") throw new AppError(400, "validation_failed", "A new offering starts as a draft or published.", [{ field: "status", message: "Choose draft or published." }]);
    const created = await withContext(pool, dbContext(s), async (c) => {
      const org = await c.query("SELECT 1 FROM organizations WHERE id = $1 AND type = 'vendor'", [id]);
      if (!org.rowCount) throw new AppError(404, "not_found", "Vendor not found.");
      await assertCategory(c, body.categoryId);
      const held = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM offerings WHERE tenant_id = $1", [id]);
      if ((held.rows[0]?.n ?? 0) >= MAX_OFFERINGS) throw new AppError(422, "limit_reached", `A vendor can have at most ${MAX_OFFERINGS} offerings. Archive ones you no longer use.`);
      const cols = Object.entries(COLUMNS).filter(([k]) => k in body);
      const res = await c.query<{ id: string }>(
        `INSERT INTO offerings (tenant_id, ${cols.map(([, col]) => col).join(", ")}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")}) RETURNING id`,
        [id, ...cols.map(([k]) => (body as Record<string, unknown>)[k] ?? null)],
      );
      const offeringId = res.rows[0]?.id;
      if (!offeringId) throw new Error("offering insert returned no row");
      const offering = await loadOffering(c, id, offeringId);
      if (!offering) throw new Error("offering not found after insert");
      if (offering.status === "published") {
        const missing = publishBlockers(offering);
        if (missing.length) throw new AppError(422, "not_ready_to_publish", "This offering is not ready to be published yet.", missing);
      }
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "offering.created", entityType: "offering", entityId: offeringId, requestId: req.id });
      return offering;
    });
    return reply.code(201).send(created);
  });

  /** Changes are merged with the stored offering and the COMPLETE result is validated again, so a partial update can never break a rule. */
  app.patch("/vendors/:id/offerings/:offeringId", { preHandler: requireVendor("offerings.manage") }, async (req) => {
    const s = state(req);
    const { id, offeringId } = z.object({ id: z.uuid(), offeringId: z.uuid() }).parse(req.params);
    const patch = offeringPatch.parse(req.body) as Record<string, unknown>;
    return withContext(pool, dbContext(s), async (c) => {
      const current = await c.query<OfferingRow>(`${OFFERING_SELECT} WHERE o.id = $1 AND o.tenant_id = $2 FOR UPDATE OF o`, [offeringId, id]);
      const row = current.rows[0];
      if (!row) throw new AppError(404, "not_found", "Offering not found.");
      const existing = toOffering(row);
      const merged = offeringSchema.safeParse({
        categoryId: existing.categoryId,
        name: existing.name,
        description: existing.description,
        offeringType: existing.offeringType,
        pricingModel: existing.pricingModel,
        priceMinor: existing.priceMinor,
        durationMinutes: existing.durationMinutes,
        minParticipants: existing.minParticipants,
        maxParticipants: existing.maxParticipants,
        ageMin: existing.ageMin,
        ageMax: existing.ageMax,
        equipment: existing.equipment,
        venueRequirements: existing.venueRequirements,
        additionalCharges: existing.additionalCharges,
        terms: existing.terms,
        cancellationPolicy: existing.cancellationPolicy,
        status: existing.status,
        ...patch,
      });
      if (!merged.success) throw merged.error;
      if (typeof patch["categoryId"] === "string") await assertCategory(c, patch["categoryId"]);
      const cols = Object.entries(COLUMNS).filter(([k]) => k in patch);
      await c.query(`UPDATE offerings SET ${cols.map(([, col], i) => `${col} = $${i + 3}`).join(", ")} WHERE id = $1 AND tenant_id = $2`, [
        offeringId,
        id,
        ...cols.map(([k]) => patch[k] ?? null),
      ]);
      const updated = await loadOffering(c, id, offeringId);
      if (!updated) throw new Error("offering not found after update");
      if (updated.status === "published") {
        const missing = publishBlockers(updated);
        if (missing.length) throw new AppError(422, "not_ready_to_publish", "This offering is not ready to be published yet.", missing);
      }
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "offering.updated", entityType: "offering", entityId: offeringId, metadata: { fields: Object.keys(patch) }, requestId: req.id });
      return updated;
    });
  });

  /* ------------------------------------------------------------- availability */

  async function loadAvailability(s: TenantState, id: string) {
    return withContext(pool, dbContext(s), async (c) => {
      const rules = await c.query<{ weekday: number; start_time: string; end_time: string }>(
        "SELECT weekday, to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time FROM vendor_availability_rules WHERE tenant_id = $1 ORDER BY weekday, start_time",
        [id],
      );
      const blocks = await c.query<{ id: string; starts_at: Date; ends_at: Date; reason: string | null }>(
        "SELECT id, starts_at, ends_at, reason FROM vendor_unavailable_blocks WHERE tenant_id = $1 AND ends_at > now() - interval '1 day' ORDER BY starts_at",
        [id],
      );
      return {
        weeklyHours: rules.rows.map((r) => ({ weekday: r.weekday, startTime: r.start_time, endTime: r.end_time })),
        unavailable: blocks.rows.map((b) => ({ id: b.id, startsAt: b.starts_at.toISOString(), endsAt: b.ends_at.toISOString(), reason: b.reason })),
      };
    });
  }

  app.get("/vendors/:id/availability", { preHandler: requireVendor("availability.manage") }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return loadAvailability(state(req), id);
  });

  /** Replaces the weekly working hours. */
  app.put("/vendors/:id/availability/weekly-hours", { preHandler: requireVendor("availability.manage") }, async (req) => {
    const s = state(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { rules } = rulesBody.parse(req.body);
    for (const r of rules) {
      if (r.endTime <= r.startTime) throw new AppError(400, "validation_failed", "Each slot must end after it starts.", [{ field: "rules", message: `On weekday ${r.weekday} the slot ${r.startTime}-${r.endTime} ends before it starts.` }]);
    }
    const sorted = [...rules].sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (prev && cur && prev.weekday === cur.weekday && cur.startTime < prev.endTime) {
        throw new AppError(400, "validation_failed", "Slots on the same day cannot overlap.", [{ field: "rules", message: `On weekday ${cur.weekday} ${prev.startTime}-${prev.endTime} overlaps ${cur.startTime}-${cur.endTime}.` }]);
      }
    }
    await withContext(pool, dbContext(s), async (c) => {
      const org = await c.query("SELECT 1 FROM organizations WHERE id = $1 AND type = 'vendor'", [id]);
      if (!org.rowCount) throw new AppError(404, "not_found", "Vendor not found.");
      await c.query("DELETE FROM vendor_availability_rules WHERE tenant_id = $1", [id]);
      for (const r of sorted) {
        await c.query("INSERT INTO vendor_availability_rules (tenant_id, weekday, start_time, end_time) VALUES ($1, $2, $3, $4)", [id, r.weekday, r.startTime, r.endTime]);
      }
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "vendor.weekly_hours_set", requestId: req.id });
    });
    return loadAvailability(s, id);
  });

  app.post("/vendors/:id/availability/unavailable", { preHandler: requireVendor("availability.manage") }, async (req, reply) => {
    const s = state(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = blockBody.parse(req.body);
    await withContext(pool, dbContext(s), async (c) => {
      const org = await c.query("SELECT 1 FROM organizations WHERE id = $1 AND type = 'vendor'", [id]);
      if (!org.rowCount) throw new AppError(404, "not_found", "Vendor not found.");
      await c.query("INSERT INTO vendor_unavailable_blocks (tenant_id, starts_at, ends_at, reason) VALUES ($1, $2, $3, $4)", [id, body.startsAt, body.endsAt, body.reason ?? null]);
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "vendor.unavailable_added", requestId: req.id });
    });
    return reply.code(201).send(await loadAvailability(s, id));
  });

  app.delete("/vendors/:id/availability/unavailable/:blockId", { preHandler: requireVendor("availability.manage") }, async (req, reply) => {
    const s = state(req);
    const { id, blockId } = z.object({ id: z.uuid(), blockId: z.uuid() }).parse(req.params);
    await withContext(pool, dbContext(s), async (c) => {
      const res = await c.query("DELETE FROM vendor_unavailable_blocks WHERE id = $1 AND tenant_id = $2", [blockId, id]);
      if (!res.rowCount) throw new AppError(404, "not_found", "Not found.");
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "vendor.unavailable_removed", requestId: req.id });
    });
    return reply.code(204).send();
  });
}
