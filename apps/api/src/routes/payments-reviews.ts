import type { FastifyInstance } from "fastify";
import { withContext } from "@kidos/db";
import { z } from "zod";
import { writeAudit } from "../audit";
import { AppError, forbidden } from "../errors";
import { dbContext, makeRequireAnyPermission, makeRequirePermission } from "../guards";
import { Outbox, vendorTeamEmails } from "../notify";
import type { Deps, TenantState } from "../types";
import { loadBookings, loadReviews } from "./sourcing";

const text = (max: number) => z.string().trim().max(max);
const idParam = z.object({ id: z.uuid() });
const paymentSchema = z
  .object({
    kind: z.enum(["family_to_vendor", "vendor_to_platform"]),
    amountMinor: z.number().int().min(1).max(1_000_000_000),
    method: z.enum(["cash", "upi", "bank_transfer", "card_offline", "other"]),
    reference: text(100).nullable().optional(),
    paidOn: z.iso.date(),
    note: text(300).nullable().optional(),
  })
  .strict();
const feeSchema = z.object({ feeMinor: z.number().int().min(0).max(1_000_000_000).nullable() }).strict();
const reviewSchema = z.object({ rating: z.number().int().min(1).max(5), body: text(1000).nullable().optional() }).strict();
const moderationSchema = z.object({ decision: z.enum(["publish", "reject"]), note: text(300).optional() }).strict();
const replySchema = z.object({ reply: text(1000).min(1) }).strict();

export async function paymentsReviewsRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool } = deps;
  const requirePermission = makeRequirePermission(deps);
  const requireAny = makeRequireAnyPermission(deps);

  const state = (req: { tenantState?: TenantState }): TenantState => {
    if (!req.tenantState) throw new AppError(400, "tenant_required", "Select an organization first.");
    return req.tenantState;
  };
  const requireOps = (s: TenantState): void => {
    if (!s.platformScope) throw new AppError(403, "platform_scope_required", "This is for the operations team.");
  };

  /* ------------------------------------------------------------- payments */

  /** Operations record money that moved OFFLINE. Nothing here moves money; the records are append-only. */
  app.post("/bookings/:id/payments", { preHandler: requirePermission("payments.record") }, async (req, reply) => {
    const s = state(req);
    requireOps(s);
    const { id } = idParam.parse(req.params);
    const body = paymentSchema.parse(req.body);
    const out = await withContext(pool, dbContext(s), async (c) => {
      const b = (await c.query<{ status: string; tenant_id: string; agreed: string; fee: string | null }>("SELECT status, tenant_id, agreed_total_minor::text AS agreed, platform_fee_minor::text AS fee FROM bookings WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!b) throw new AppError(404, "not_found", "Booking not found.");
      if (b.status !== "confirmed" && b.status !== "completed") throw new AppError(409, "booking_not_active", "Payments are recorded once a booking is confirmed.");
      const today = await c.query<{ ok: boolean }>("SELECT $1::date <= current_date AS ok", [body.paidOn]);
      if (!today.rows[0]?.ok) throw new AppError(400, "validation_failed", "A payment cannot be dated in the future.", [{ field: "paidOn", message: "Choose today or an earlier date." }]);
      const paid = Number((await c.query<{ n: string }>("SELECT coalesce(sum(amount_minor), 0)::text AS n FROM booking_payments WHERE booking_id = $1 AND kind = $2", [id, body.kind])).rows[0]?.n ?? 0);
      const limit = body.kind === "family_to_vendor" ? Number(b.agreed) : b.fee === null ? null : Number(b.fee);
      if (limit === null) throw new AppError(409, "fee_not_set", "Set the platform fee for this booking before recording a payment of it.");
      if (paid + body.amountMinor > limit) throw new AppError(409, "overpaid", `That would be more than the ${body.kind === "family_to_vendor" ? "agreed price" : "platform fee"} (${(limit - paid) / 100} left).`);
      const created = await c.query<{ id: string }>(
        "INSERT INTO booking_payments (tenant_id, booking_id, kind, amount_minor, method, reference, paid_on, note, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
        [b.tenant_id, id, body.kind, body.amountMinor, body.method, body.reference?.trim() || null, body.paidOn, body.note?.trim() || null, s.userId],
      );
      await writeAudit(c, { tenantId: b.tenant_id, actorUserId: s.userId, action: "payment.recorded", entityType: "booking", entityId: id, metadata: { kind: body.kind, amountMinor: body.amountMinor }, requestId: req.id });
      void created;
      return (await loadBookings(c, "b.id = $1", [id]))[0];
    });
    return reply.code(201).send(out);
  });

  app.put("/bookings/:id/fee", { preHandler: requirePermission("payments.record") }, async (req) => {
    const s = state(req);
    requireOps(s);
    const { id } = idParam.parse(req.params);
    const { feeMinor } = feeSchema.parse(req.body);
    return withContext(pool, dbContext(s), async (c) => {
      const b = (await c.query<{ status: string; tenant_id: string; agreed: string; fee: string | null }>("SELECT status, tenant_id, agreed_total_minor::text AS agreed, platform_fee_minor::text AS fee FROM bookings WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!b) throw new AppError(404, "not_found", "Booking not found.");
      if (b.status !== "confirmed" && b.status !== "completed") throw new AppError(409, "booking_not_active", "The fee is set once a booking is confirmed.");
      // an unchanged fee is not a change (and a finished booking refuses even a no-op update)
      if ((b.fee === null ? null : Number(b.fee)) === feeMinor) return (await loadBookings(c, "b.id = $1", [id]))[0];
      if (feeMinor !== null && feeMinor > Number(b.agreed)) throw new AppError(400, "validation_failed", "The fee cannot be more than the agreed price.", [{ field: "feeMinor", message: "Enter a smaller amount." }]);
      const paid = Number((await c.query<{ n: string }>("SELECT coalesce(sum(amount_minor), 0)::text AS n FROM booking_payments WHERE booking_id = $1 AND kind = 'vendor_to_platform'", [id])).rows[0]?.n ?? 0);
      if ((feeMinor ?? 0) < paid) throw new AppError(409, "fee_below_paid", "The fee cannot be less than what the vendor has already paid.");
      try {
        await c.query("UPDATE bookings SET platform_fee_minor = $2 WHERE id = $1", [id, feeMinor]);
      } catch (err) {
        if ((err as { code?: string }).code === "42501") throw forbidden();
        throw err;
      }
      await writeAudit(c, { tenantId: b.tenant_id, actorUserId: s.userId, action: "booking.fee_set", entityType: "booking", entityId: id, requestId: req.id });
      return (await loadBookings(c, "b.id = $1", [id]))[0];
    });
  });

  /* -------------------------------------------------------------- reviews */

  /** A family reviews a COMPLETED booking, once. The review stays private until operations publish it. */
  app.post("/bookings/:id/review", { preHandler: requirePermission("reviews.create") }, async (req, reply) => {
    const s = state(req);
    if (s.platformScope) throw forbidden();
    const { id } = idParam.parse(req.params);
    const body = reviewSchema.parse(req.body);
    const outbox = new Outbox(deps, req.log);
    const review = await withContext(pool, dbContext(s), async (c) => {
      const b = (await c.query<{ status: string; tenant_id: string; vendor_id: string; request_id: string }>("SELECT status, tenant_id, vendor_id, request_id FROM bookings WHERE id = $1", [id])).rows[0];
      if (!b) throw new AppError(404, "not_found", "Booking not found.");
      if (b.status !== "completed") throw new AppError(409, "not_completed", "You can leave a review once the booking is completed.");
      const existing = await c.query("SELECT 1 FROM reviews WHERE booking_id = $1", [id]);
      if (existing.rowCount) throw new AppError(409, "already_reviewed", "You have already reviewed this booking.");
      try {
        const created = await c.query<{ id: string }>("INSERT INTO reviews (tenant_id, booking_id, vendor_id, requester_id, rating, body) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id", [b.tenant_id, id, b.vendor_id, s.userId, body.rating, body.body?.trim() || null]);
        const rid = created.rows[0]?.id;
        if (!rid) throw new Error("review insert returned no row");
        await writeAudit(c, { tenantId: b.tenant_id, actorUserId: s.userId, action: "review.created", entityType: "review", entityId: rid, requestId: req.id });
        outbox.event(deps.config, [deps.config.opsAlertEmail], "A review to look at", "A family has left a review. It needs checking before it is published.", "/app/reviews");
        return (await loadReviews(c, "r.id = $1", [rid]))[0];
      } catch (err) {
        if ((err as { code?: string }).code === "42501") throw new AppError(403, "not_your_booking", "Only the family that made the request can review it.");
        throw err;
      }
    });
    await outbox.flush();
    return reply.code(201).send(review);
  });

  /** Operations' moderation queue (platform), or a vendor's own published reviews (vendor context). */
  app.get("/reviews", { preHandler: requireAny("reviews.moderate", "reviews.reply") }, async (req) => {
    const s = state(req);
    const q = z.object({ status: z.enum(["pending", "published", "rejected"]).optional() }).strict().parse(req.query);
    return withContext(pool, dbContext(s), async (c) => {
      if (s.platformScope) {
        if (!s.permissions.has("reviews.moderate")) throw forbidden();
        return { data: await loadReviews(c, "r.status = $1", [q.status ?? "pending"], true) };
      }
      if (!s.permissions.has("reviews.reply")) throw forbidden();
      // a vendor reads its own published reviews (row-level security would hide anything else)
      return { data: await loadReviews(c, "r.vendor_id = $1 AND r.status = 'published'", [s.tenantId]) };
    });
  });

  app.put("/reviews/:id/moderation", { preHandler: requirePermission("reviews.moderate") }, async (req) => {
    const s = state(req);
    requireOps(s);
    const { id } = idParam.parse(req.params);
    const body = moderationSchema.parse(req.body);
    if (body.decision === "reject" && !body.note?.trim()) throw new AppError(400, "note_required", "Say why this review is not published. The author will see it.");
    const outbox = new Outbox(deps, req.log);
    const out = await withContext(pool, dbContext(s), async (c) => {
      const cur = (await c.query<{ status: string; tenant_id: string; vendor_id: string }>("SELECT status, tenant_id, vendor_id FROM reviews WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!cur) throw new AppError(404, "not_found", "Review not found.");
      try {
        await c.query("UPDATE reviews SET status = $2, moderation_note = $3 WHERE id = $1", [id, body.decision === "publish" ? "published" : "rejected", body.note?.trim() || null]);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "42501") throw new AppError(409, "invalid_state", "That review cannot be moved to that state.");
        throw err;
      }
      await writeAudit(c, { tenantId: cur.tenant_id, actorUserId: s.userId, action: `review.${body.decision === "publish" ? "published" : "rejected"}`, entityType: "review", entityId: id, requestId: req.id });
      if (body.decision === "publish") outbox.event(deps.config, await vendorTeamEmails(c, cur.vendor_id, "reviews.reply"), "A new review", "A family has reviewed your work. You can read it and reply.", "/app/reviews");
      return (await loadReviews(c, "r.id = $1", [id], true))[0];
    });
    await outbox.flush();
    return out;
  });

  app.post("/reviews/:id/reply", { preHandler: requirePermission("reviews.reply") }, async (req) => {
    const s = state(req);
    if (s.platformScope) throw new AppError(403, "vendor_context_required", "Switch to the vendor you are replying for.");
    const { id } = idParam.parse(req.params);
    const { reply } = replySchema.parse(req.body);
    return withContext(pool, dbContext(s), async (c) => {
      const res = await c.query("UPDATE reviews SET vendor_reply = $2 WHERE id = $1 AND status = 'published' AND vendor_reply IS NULL", [id, reply]);
      if (!res.rowCount) throw new AppError(409, "cannot_reply", "This review cannot be answered (it is not published, is not yours, or already has a reply).");
      await writeAudit(c, { tenantId: s.tenantId, actorUserId: s.userId, action: "review.replied", entityType: "review", entityId: id, requestId: req.id });
      return (await loadReviews(c, "r.id = $1", [id]))[0];
    });
  });
}
