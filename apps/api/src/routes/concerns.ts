import type { FastifyInstance } from "fastify";
import { withContext } from "@kidos/db";
import { z } from "zod";
import { writeAudit } from "../audit";
import { AppError, forbidden } from "../errors";
import { dbContext, makeRequirePermission } from "../guards";
import { Outbox, userEmail } from "../notify";
import type { Deps, TenantState } from "../types";

const text = (max: number) => z.string().trim().max(max);
const idParam = z.object({ id: z.uuid() });
const CATEGORIES = ["child_safety", "conduct", "payment", "other"] as const;
/** The most undecided reports one person may have at once (also enforced by a database trigger). */
const OPEN_LIMIT = 10;

const reportSchema = z
  .object({
    category: z.enum(CATEGORIES),
    vendorId: z.uuid().nullable().optional(),
    subject: text(150).min(1),
    details: text(3000).min(1),
  })
  .strict();
const decisionSchema = z
  .object({ status: z.enum(["reviewing", "resolved", "dismissed"]), resolution: text(1000).optional() })
  .strict();
const listQuery = z.object({ view: z.enum(["active", "resolved", "dismissed", "all"]).default("active") }).strict();

interface ConcernRow {
  id: string;
  category: string;
  subject: string;
  details: string;
  status: string;
  resolution: string | null;
  created_at: Date;
  status_changed_at: Date;
  vendor_id: string | null;
  vendor_name: string | null;
  organization_name: string | null;
  reporter_name: string | null;
  reporter_email: string | null;
}

const SELECT = `SELECT c.id, c.category, c.subject, c.details, c.status, c.resolution, c.created_at, c.status_changed_at, c.vendor_id,
                       v.name AS vendor_name, o.name AS organization_name, u.display_name AS reporter_name, u.email AS reporter_email
                  FROM concerns c
                  LEFT JOIN organizations v ON v.id = c.vendor_id
                  LEFT JOIN organizations o ON o.id = c.tenant_id
                  LEFT JOIN users u ON u.id = c.reporter_id`;

/** What the reporter sees: their own words and the outcome. Never who handled it. */
const toMine = (r: ConcernRow) => ({
  id: r.id,
  category: r.category,
  subject: r.subject,
  vendor: r.vendor_id ? { id: r.vendor_id, name: r.vendor_name } : null,
  status: r.status,
  resolution: r.resolution,
  createdAt: r.created_at.toISOString(),
});

/** What the team sees: everything, including who reported it and where. */
const toTeam = (r: ConcernRow) => ({
  ...toMine(r),
  details: r.details,
  reportedBy: { name: r.reporter_name, email: r.reporter_email },
  organization: r.organization_name,
  decidedAt: r.status === "resolved" || r.status === "dismissed" ? r.status_changed_at.toISOString() : null,
});

/**
 * Safety and conduct concerns. Reports go to the platform team only: no policy gives a vendor or a community any view of
 * them. Emails say only that something was reported (never what), and are sent after the action commits.
 */
export async function concernRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool } = deps;
  const requirePermission = makeRequirePermission(deps);

  const state = (req: { tenantState?: TenantState }): TenantState => {
    if (!req.tenantState) throw new AppError(400, "tenant_required", "Select an organization first.");
    return req.tenantState;
  };

  app.post("/concerns", { preHandler: requirePermission("concerns.create") }, async (req, reply) => {
    const s = state(req);
    if (s.platformScope) throw forbidden();
    const body = reportSchema.parse(req.body);
    const outbox = new Outbox(deps, req.log);
    const created = await withContext(pool, dbContext(s), async (c) => {
      if (body.vendorId) {
        // only a vendor this person could see (row-level security): the same answer as one that does not exist
        const seen = await c.query("SELECT 1 FROM organizations WHERE id = $1 AND type = 'vendor'", [body.vendorId]);
        if (!seen.rowCount) throw new AppError(404, "vendor_not_found", "We could not find that vendor.");
      }
      const open = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM concerns WHERE reporter_id = $1 AND status IN ('open', 'reviewing')", [s.userId]);
      if ((open.rows[0]?.n ?? 0) >= OPEN_LIMIT) {
        throw new AppError(422, "too_many_open", "You already have several reports the team has not finished with. Please wait for an answer before sending more.");
      }
      const res = await c.query<{ id: string }>(
        "INSERT INTO concerns (tenant_id, reporter_id, category, vendor_id, subject, details) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        [s.tenantId, s.userId, body.category, body.vendorId ?? null, body.subject, body.details],
      );
      const id = res.rows[0]?.id;
      if (!id) throw new Error("concern insert returned no row");
      // The audit record names the category, never the words.
      await writeAudit(c, { tenantId: s.tenantId, actorUserId: s.userId, action: "concern.reported", entityType: "concern", entityId: id, metadata: { category: body.category }, requestId: req.id });
      outbox.event(
        deps.config,
        [deps.config.opsAlertEmail],
        body.category === "child_safety" ? "A safety concern was reported" : "A concern was reported",
        body.category === "child_safety" ? "Someone has reported a child-safety concern. Please look at it today." : "Someone has reported a concern. Please look at it.",
        "/app/concerns",
      );
      return id;
    });
    await outbox.flush();
    return reply.code(201).send({ id: created });
  });

  /** The reporter's own reports (any organization they have acted in), newest first. */
  app.get("/concerns/mine", { preHandler: requirePermission("concerns.create") }, async (req) => {
    const s = state(req);
    if (s.platformScope) throw forbidden();
    const rows = await withContext(pool, dbContext(s), async (c) => (await c.query<ConcernRow>(`${SELECT} WHERE c.reporter_id = $1 ORDER BY c.created_at DESC, c.id DESC LIMIT 50`, [s.userId])).rows);
    return { data: rows.map(toMine) };
  });

  /** The team's queue. Child-safety reports come first, then the oldest. */
  app.get("/concerns", { preHandler: requirePermission("concerns.manage") }, async (req) => {
    const s = state(req);
    if (!s.platformScope) throw new AppError(403, "platform_scope_required", "This is for the platform team.");
    const q = listQuery.parse(req.query);
    const where = q.view === "active" ? "c.status IN ('open', 'reviewing')" : q.view === "all" ? "true" : "c.status = $1";
    const rows = await withContext(pool, dbContext(s), async (c) =>
      (await c.query<ConcernRow>(`${SELECT} WHERE ${where} ORDER BY (c.category = 'child_safety') DESC, c.created_at, c.id LIMIT 100`, q.view === "resolved" || q.view === "dismissed" ? [q.view] : [])).rows,
    );
    return { data: rows.map(toTeam) };
  });

  /** Take a report on, or decide it. A decision needs the words the reporter will read. */
  app.put("/concerns/:id/status", { preHandler: requirePermission("concerns.manage") }, async (req) => {
    const s = state(req);
    if (!s.platformScope) throw new AppError(403, "platform_scope_required", "This is for the platform team.");
    const { id } = idParam.parse(req.params);
    const body = decisionSchema.parse(req.body);
    const deciding = body.status !== "reviewing";
    if (deciding && !body.resolution?.trim()) throw new AppError(400, "resolution_required", "Tell the reporter what was decided. They will read it.");
    if (!deciding && body.resolution?.trim()) throw new AppError(400, "resolution_not_allowed", "An outcome is written when the report is decided.");
    const outbox = new Outbox(deps, req.log);
    const out = await withContext(pool, dbContext(s), async (c) => {
      const cur = (await c.query<{ reporter_id: string; tenant_id: string }>("SELECT reporter_id, tenant_id FROM concerns WHERE id = $1", [id])).rows[0];
      if (!cur) throw new AppError(404, "not_found", "Report not found.");
      // a guarded update: it succeeds only from a state this decision may follow
      const allowedFrom = body.status === "reviewing" ? "('open')" : "('open', 'reviewing')";
      let updated;
      try {
        updated = await c.query(`UPDATE concerns SET status = $2, resolution = $3 WHERE id = $1 AND status IN ${allowedFrom}`, [id, body.status, deciding ? body.resolution?.trim() : null]);
      } catch (err) {
        if ((err as { code?: string }).code === "42501") throw new AppError(409, "invalid_state", "That report cannot be moved to that state.");
        throw err;
      }
      if (!updated.rowCount) throw new AppError(409, "invalid_state", "That report cannot be moved to that state.");
      await writeAudit(c, { tenantId: cur.tenant_id, actorUserId: s.userId, action: `concern.${body.status}`, entityType: "concern", entityId: id, requestId: req.id });
      if (deciding) outbox.event(deps.config, [await userEmail(c, cur.reporter_id)], "An update on your report", "The team has looked at the concern you reported. You can read the outcome.", "/app/concerns");
      return toTeam((await c.query<ConcernRow>(`${SELECT} WHERE c.id = $1`, [id])).rows[0] as ConcernRow);
    });
    await outbox.flush();
    return out;
  });
}
