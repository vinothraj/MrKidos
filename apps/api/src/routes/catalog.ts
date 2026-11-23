import type { FastifyInstance } from "fastify";
import { withContext } from "@kidos/db";
import { z } from "zod";
import { AppError } from "../errors";
import { dbContext, makeRequirePermission } from "../guards";
import { cursorTimestamp, decodeCursor, encodeCursor, pageParams } from "../pagination";
import { likePattern } from "../sql-helpers";
import type { Deps, TenantState } from "../types";
import { OFFERING_SELECT, toOffering, type OfferingRow } from "./offerings";

const listQuery = z.object({
  ...pageParams,
  q: z.string().trim().max(100).optional(),
  categoryId: z.uuid().optional(),
  pricingModel: z.enum(["fixed", "hourly", "per_participant", "per_event", "per_day", "package", "custom_quotation"]).optional(),
  maxPriceMinor: z.coerce.number().int().min(0).optional(),
  /** Only offerings suitable for a child of this age. */
  age: z.coerce.number().int().min(0).max(100).optional(),
  /** Only vendors whose published reviews average at least this (vendors without reviews are left out). */
  minRating: z.coerce.number().min(1).max(5).optional(),
  /** Only what this person has saved. */
  savedOnly: z.enum(["true", "false"]).optional(),
});

/** The most offerings one person may save in one community (also enforced by a database trigger). */
const SAVED_LIMIT = 200;

/**
 * What residents see. There is deliberately no tenant filter here: visibility is decided by row-level security from
 * the community the person is acting in (active vendor, serves that community, approved by it when the policy requires).
 */
export async function catalogRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool } = deps;
  const requirePermission = makeRequirePermission(deps);

  const state = (req: { tenantState?: TenantState }): TenantState => {
    if (!req.tenantState) throw new AppError(400, "tenant_required", "Select a community first.");
    return req.tenantState;
  };
  /** The catalog is a community experience; platform scope has no community to browse for. */
  const requireCommunityContext = (s: TenantState): void => {
    if (s.platformScope) throw new AppError(403, "community_required", "Switch to a community to browse its catalog.");
  };

  app.get("/catalog/offerings", { preHandler: requirePermission("catalog.read") }, async (req) => {
    const s = state(req);
    requireCommunityContext(s);
    const q = listQuery.parse(req.query);
    const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
    const rows = await withContext(pool, dbContext(s), async (c) => {
      const params: unknown[] = [q.limit + 1];
      const where: string[] = ["o.status = 'published'"];
      if (q.categoryId) {
        params.push(q.categoryId);
        // a parent category includes its sub-categories
        where.push(`(o.category_id = $${params.length} OR c.parent_id = $${params.length})`);
      }
      if (q.pricingModel) {
        params.push(q.pricingModel);
        where.push(`o.pricing_model = $${params.length}`);
      }
      if (q.maxPriceMinor !== undefined) {
        params.push(q.maxPriceMinor);
        where.push(`(o.price_minor IS NULL OR o.price_minor <= $${params.length})`);
      }
      if (q.age !== undefined) {
        params.push(q.age);
        where.push(`(o.age_min IS NULL OR o.age_min <= $${params.length}) AND (o.age_max IS NULL OR o.age_max >= $${params.length})`);
      }
      if (q.minRating !== undefined) {
        params.push(q.minRating);
        where.push(`rt.a >= $${params.length}`);
      }
      // Saved offerings are the caller's own rows (row-level security), joined below; no user filter is needed or wanted here.
      if (q.savedOnly === "true") where.push("s.offering_id IS NOT NULL");
      if (q.q) {
        params.push(likePattern(q.q));
        where.push(`(o.name ILIKE $${params.length} ESCAPE '\\' OR o.description ILIKE $${params.length} ESCAPE '\\' OR v.name ILIKE $${params.length} ESCAPE '\\')`);
      }
      if (cursor) {
        params.push(cursor.t, cursor.i);
        where.push(`(o.created_at, o.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      }
      const res = await c.query<OfferingRow & { vendor_id: string; vendor_name: string; cursor_t: string; review_count: number | null; rating_avg: string | null; saved: boolean }>(
        `${OFFERING_SELECT.replace(
          "FROM offerings o",
          ", o.tenant_id AS vendor_id, v.name AS vendor_name, rt.n AS review_count, round(rt.a, 1)::text AS rating_avg, (s.offering_id IS NOT NULL) AS saved, " +
            cursorTimestamp("o.created_at") +
            " AS cursor_t FROM offerings o",
        )}
          JOIN organizations v ON v.id = o.tenant_id
          LEFT JOIN LATERAL (SELECT count(*)::int AS n, avg(r.rating) AS a FROM reviews r WHERE r.vendor_id = o.tenant_id AND r.status = 'published') rt ON true
          LEFT JOIN saved_offerings s ON s.offering_id = o.id
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
        ...toOffering(r),
        vendor: { id: r.vendor_id, name: r.vendor_name },
        rating: { count: r.review_count ?? 0, average: r.rating_avg ? Number(r.rating_avg) : null },
        saved: r.saved,
      })),
      page: { hasMore, nextCursor: hasMore && last ? encodeCursor(last.cursor_t, last.id) : null },
    };
  });

  /**
   * Save an offering for later. Idempotent. An offering the person cannot see (unpublished, or a vendor their community
   * does not show them) answers 404, exactly as one that does not exist.
   */
  app.put("/catalog/offerings/:id/saved", { preHandler: requirePermission("catalog.read") }, async (req, reply) => {
    const s = state(req);
    requireCommunityContext(s);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await withContext(pool, dbContext(s), async (c) => {
      const visible = await c.query("SELECT 1 FROM offerings WHERE id = $1 AND status = 'published'", [id]);
      if (!visible.rowCount) throw new AppError(404, "not_found", "Offering not found.");
      const already = await c.query("SELECT 1 FROM saved_offerings WHERE offering_id = $1", [id]);
      if (already.rowCount) return;
      const mine = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM saved_offerings");
      if ((mine.rows[0]?.n ?? 0) >= SAVED_LIMIT) {
        throw new AppError(422, "too_many_saved", `You can save up to ${SAVED_LIMIT} activities. Remove one to save another.`);
      }
      await c.query("INSERT INTO saved_offerings (tenant_id, user_id, offering_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [s.tenantId, s.userId, id]);
    });
    return reply.code(204).send();
  });

  /** Remove a saved offering. Idempotent: removing one that is not saved is fine. */
  app.delete("/catalog/offerings/:id/saved", { preHandler: requirePermission("catalog.read") }, async (req, reply) => {
    const s = state(req);
    requireCommunityContext(s);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await withContext(pool, dbContext(s), (c) => c.query("DELETE FROM saved_offerings WHERE offering_id = $1", [id]));
    return reply.code(204).send();
  });

  /** A vendor's public page: only the public profile, its categories and its published offerings. Never private or internal fields. */
  app.get("/catalog/vendors/:id", { preHandler: requirePermission("catalog.read") }, async (req) => {
    const s = state(req);
    requireCommunityContext(s);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return withContext(pool, dbContext(s), async (c) => {
      const v = await c.query<{
        id: string;
        name: string;
        tagline: string | null;
        description: string | null;
        business_type: string | null;
        city: string | null;
        locality: string | null;
        website: string | null;
        years_experience: number | null;
      }>(
        `SELECT o.id, o.name, p.tagline, p.description, p.business_type, p.city, p.locality, p.website, p.years_experience
           FROM organizations o LEFT JOIN vendor_profiles p ON p.tenant_id = o.id WHERE o.id = $1 AND o.type = 'vendor'`,
        [id],
      );
      const vendor = v.rows[0];
      // Row-level security returns nothing for a vendor this community may not see: same answer as one that does not exist.
      if (!vendor) throw new AppError(404, "not_found", "Vendor not found.");
      const cats = await c.query<{ name: string }>(
        "SELECT cat.name FROM vendor_categories vc JOIN categories cat ON cat.id = vc.category_id WHERE vc.tenant_id = $1 ORDER BY cat.name",
        [id],
      );
      const offerings = await c.query<OfferingRow>(`${OFFERING_SELECT} WHERE o.tenant_id = $1 AND o.status = 'published' ORDER BY o.name, o.id`, [id]);
      // The caller's own saved rows only (row-level security).
      const savedIds = new Set((await c.query<{ offering_id: string }>("SELECT offering_id FROM saved_offerings WHERE offering_id = ANY($1::uuid[])", [offerings.rows.map((o) => o.id)])).rows.map((r) => r.offering_id));
      // Published reviews only (row-level security), anonymous: a family is never named.
      const reviews = await c.query<{ rating: number; body: string | null; vendor_reply: string | null; created_at: Date }>(
        "SELECT rating, body, vendor_reply, created_at FROM reviews WHERE vendor_id = $1 AND status = 'published' ORDER BY created_at DESC LIMIT 20", [id]);
      const summary = (await c.query<{ n: number; avg: string | null }>("SELECT count(*)::int AS n, round(avg(rating), 1)::text AS avg FROM reviews WHERE vendor_id = $1 AND status = 'published'", [id])).rows[0];
      return {
        id: vendor.id,
        name: vendor.name,
        tagline: vendor.tagline,
        description: vendor.description,
        businessType: vendor.business_type,
        city: vendor.city,
        locality: vendor.locality,
        website: vendor.website,
        yearsExperience: vendor.years_experience,
        categories: cats.rows.map((r) => r.name),
        offerings: offerings.rows.map((o) => ({ ...toOffering(o), saved: savedIds.has(o.id) })),
        rating: { count: summary?.n ?? 0, average: summary?.avg ? Number(summary.avg) : null },
        reviews: reviews.rows.map((r) => ({ rating: r.rating, body: r.body, reply: r.vendor_reply, at: r.created_at.toISOString() })),
      };
    });
  });
}
