import type { FastifyInstance } from "fastify";
import { withContext } from "@kidos/db";
import { z } from "zod";
import { writeAudit } from "../audit";
import { AppError } from "../errors";
import { dbContext, makeAuthenticate, makeRequireCommunityPermission, resolveTenantState } from "../guards";
import type { Deps, TenantState } from "../types";

/**
 * Community banners (migration 0020): short announcements for a community's Home screen. Administrators manage them
 * under /communities/:id/banners; members read the ones currently showing through /me/banners. What a caller may see is
 * decided by row-level security; these routes add no visibility filters of their own.
 */
export const BANNER_PICTURES = ["none", "family", "community", "celebrate", "kids", "explore", "bannerCandles", "bannerBirthday", "bannerPicnic", "bannerPark"] as const;
const MAX_BANNERS = 20;

const day = z.iso.date();
const fields = z.object({
  title: z.string().trim().min(1).max(80),
  message: z.string().trim().max(280),
  picture: z.enum(BANNER_PICTURES),
  // Only somewhere inside the signed-in app: a banner can never send residents to another site.
  linkPath: z.string().regex(/^\/app(\/[A-Za-z0-9_-]+)*\/?$/u, "Choose a page inside the app.").nullable(),
  linkLabel: z.string().trim().min(1).max(40).nullable(),
  startsOn: day.nullable(),
  endsOn: day.nullable(),
  active: z.boolean(),
});
type Fields = z.infer<typeof fields>;
// No .default() here: the PATCH merges into the stored record and validates the whole (see CLAUDE.md).
const createBody = fields.partial({ message: true, picture: true, linkPath: true, linkLabel: true, startsOn: true, endsOn: true, active: true }).strict();
const patchBody = fields.partial().strict().refine((v) => Object.keys(v).length > 0, "Provide at least one field to change.");
const ids = z.object({ id: z.uuid(), bannerId: z.uuid() });
const idOnly = z.object({ id: z.uuid() });

function checkWhole(f: Fields): void {
  if ((f.linkPath === null) !== (f.linkLabel === null)) {
    throw new AppError(400, "validation_failed", "A link needs both a page and the words on its button.", [{ field: f.linkPath === null ? "linkPath" : "linkLabel", message: "Fill in both, or neither." }]);
  }
  if (f.startsOn && f.endsOn && f.endsOn < f.startsOn) {
    throw new AppError(400, "validation_failed", "The last day must be on or after the first day.", [{ field: "endsOn", message: "Pick a day on or after the first day." }]);
  }
}

interface Row {
  id: string;
  title: string;
  message: string;
  picture: string;
  link_path: string | null;
  link_label: string | null;
  starts_on: string | null;
  ends_on: string | null;
  active: boolean;
  updated_at: Date;
}
const COLS = "id, title, message, picture, link_path, link_label, starts_on::text, ends_on::text, active, updated_at";
const toBanner = (r: Row) => ({
  id: r.id,
  title: r.title,
  message: r.message,
  picture: r.picture,
  linkPath: r.link_path,
  linkLabel: r.link_label,
  startsOn: r.starts_on,
  endsOn: r.ends_on,
  active: r.active,
  updatedAt: r.updated_at.toISOString(),
});

export async function bannerRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool } = deps;
  const authenticate = makeAuthenticate(deps);
  const requireCommunity = makeRequireCommunityPermission(deps);
  const state = (req: { tenantState?: TenantState }): TenantState => {
    if (!req.tenantState) throw new AppError(400, "tenant_required", "Select an organization first.");
    return req.tenantState;
  };

  /** The banners showing right now in the community the person is acting in (empty anywhere else). */
  app.get("/me/banners", { preHandler: authenticate }, async (req) => {
    const s = await resolveTenantState(req, deps);
    if (!s || s.platformScope || s.mfaEnrollmentRequired) return { data: [] };
    const rows = await withContext(pool, dbContext(s), async (c) => {
      const org = await c.query("SELECT 1 FROM organizations WHERE id = $1 AND type = 'community'", [s.tenantId]);
      if (!org.rowCount) return [];
      // "Showing now" is asked explicitly, so an administrator's Home shows what residents see, not every draft.
      return (
        await c.query<Row>(
          `SELECT ${COLS} FROM community_banners
            WHERE tenant_id = $1 AND active AND (starts_on IS NULL OR starts_on <= current_date) AND (ends_on IS NULL OR ends_on >= current_date)
            ORDER BY created_at DESC LIMIT 5`,
          [s.tenantId],
        )
      ).rows;
    });
    return { data: rows.map(toBanner) };
  });

  app.get("/communities/:id/banners", { preHandler: requireCommunity("communities.update") }, async (req) => {
    const s = state(req);
    const { id } = idOnly.parse(req.params);
    const rows = await withContext(pool, dbContext(s), async (c) => (await c.query<Row>(`SELECT ${COLS} FROM community_banners WHERE tenant_id = $1 ORDER BY created_at DESC`, [id])).rows);
    return { data: rows.map(toBanner) };
  });

  app.post("/communities/:id/banners", { preHandler: requireCommunity("communities.update") }, async (req, reply) => {
    const s = state(req);
    const { id } = idOnly.parse(req.params);
    const b = createBody.parse(req.body);
    const whole: Fields = {
      title: b.title,
      message: b.message ?? "",
      picture: b.picture ?? "celebrate",
      linkPath: b.linkPath ?? null,
      linkLabel: b.linkLabel ?? null,
      startsOn: b.startsOn ?? null,
      endsOn: b.endsOn ?? null,
      active: b.active ?? true,
    };
    checkWhole(whole);
    const row = await withContext(pool, dbContext(s), async (c) => {
      const org = await c.query("SELECT 1 FROM organizations WHERE id = $1 AND type = 'community'", [id]);
      if (!org.rowCount) throw new AppError(404, "not_found", "Community not found.");
      const n = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM community_banners WHERE tenant_id = $1", [id]);
      if ((n.rows[0]?.n ?? 0) >= MAX_BANNERS) throw new AppError(409, "too_many_banners", `A community can keep up to ${MAX_BANNERS} banners. Delete an old one first.`);
      const res = await c.query<Row>(
        `INSERT INTO community_banners (tenant_id, title, message, picture, link_path, link_label, starts_on, ends_on, active, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING ${COLS}`,
        [id, whole.title, whole.message, whole.picture, whole.linkPath, whole.linkLabel, whole.startsOn, whole.endsOn, whole.active, s.userId],
      );
      const created = res.rows[0];
      if (!created) throw new Error("banner insert returned no row");
      // The banner's words are the administrator's own public notice, but audit records stay minimal: ids and switches only.
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "community.banner_created", entityType: "banner", entityId: created.id, metadata: { active: whole.active, picture: whole.picture }, requestId: req.id });
      return created;
    });
    return reply.code(201).send(toBanner(row));
  });

  app.patch("/communities/:id/banners/:bannerId", { preHandler: requireCommunity("communities.update") }, async (req) => {
    const s = state(req);
    const { id, bannerId } = ids.parse(req.params);
    const patch = patchBody.parse(req.body);
    const row = await withContext(pool, dbContext(s), async (c) => {
      const cur = (await c.query<Row>(`SELECT ${COLS} FROM community_banners WHERE id = $1 AND tenant_id = $2`, [bannerId, id])).rows[0];
      if (!cur) throw new AppError(404, "not_found", "Banner not found.");
      const whole = fields.parse({ ...toBanner(cur), ...patch, updatedAt: undefined, id: undefined });
      checkWhole(whole);
      const res = await c.query<Row>(
        `UPDATE community_banners SET title = $3, message = $4, picture = $5, link_path = $6, link_label = $7, starts_on = $8, ends_on = $9, active = $10,
                updated_by = $11, updated_at = now()
          WHERE id = $1 AND tenant_id = $2 RETURNING ${COLS}`,
        [bannerId, id, whole.title, whole.message, whole.picture, whole.linkPath, whole.linkLabel, whole.startsOn, whole.endsOn, whole.active, s.userId],
      );
      const updated = res.rows[0];
      if (!updated) throw new AppError(404, "not_found", "Banner not found.");
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "community.banner_changed", entityType: "banner", entityId: bannerId, metadata: { fields: Object.keys(patch) }, requestId: req.id });
      return updated;
    });
    return toBanner(row);
  });

  app.delete("/communities/:id/banners/:bannerId", { preHandler: requireCommunity("communities.update") }, async (req, reply) => {
    const s = state(req);
    const { id, bannerId } = ids.parse(req.params);
    await withContext(pool, dbContext(s), async (c) => {
      const res = await c.query("DELETE FROM community_banners WHERE id = $1 AND tenant_id = $2", [bannerId, id]);
      if (!res.rowCount) throw new AppError(404, "not_found", "Banner not found.");
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "community.banner_deleted", entityType: "banner", entityId: bannerId, requestId: req.id });
    });
    return reply.code(204).send();
  });
}
