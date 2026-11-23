import type { FastifyInstance } from "fastify";
import { withContext } from "@kidos/db";
import type { PoolClient } from "pg";
import { z } from "zod";
import { writeAudit } from "../audit";
import { AppError, forbidden } from "../errors";
import { dbContext, makeRequireAnyPermission, makeRequirePermission } from "../guards";
import { eligibleVendors, scoreVendors, WEIGHTS_VERSION, type Match, type RequestFacts } from "../matching";
import { Outbox, userEmail, vendorTeamEmails } from "../notify";
import type { Deps, TenantState } from "../types";

const SOURCING_STATES = ["sourcing", "vendor_inquiry", "quotes_received"];
const MAX_INQUIRIES_PER_SEND = 5;
const MAX_INQUIRIES_PER_REQUEST = 8;

const text = (max: number) => z.string().trim().max(max);
const sendSchema = z.object({ vendorIds: z.array(z.uuid()).min(1).max(MAX_INQUIRIES_PER_SEND), message: text(1000).optional() }).strict();
const manualSchema = z.object({ vendorId: z.uuid(), reason: text(500).min(3) }).strict();
const declineSchema = z.object({ reason: text(500).min(3) }).strict();
const quoteSchema = z
  .object({
    lines: z
      .array(
        z
          .object({
            kind: z.enum(["service", "travel", "equipment", "tax", "other"]).default("service"),
            description: text(200).min(1),
            quantity: z.number().int().min(1).max(10_000).default(1),
            unitMinor: z.number().int().min(0).max(1_000_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    validUntil: z.iso.date().nullable().optional(),
    notes: text(1000).nullable().optional(),
  })
  .strict();
const shortlistSchema = z.object({ shortlisted: z.boolean() }).strict();
const scheduleSchema = z
  .object({ start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }), venueText: text(200).nullable().optional() })
  .strict()
  .refine((v) => new Date(v.end) > new Date(v.start), { message: "The end must be after the start.", path: ["end"] });
const idParam = z.object({ id: z.uuid() });

/* ----------------------------------------------------------------- shapes */

export interface QuoteOut {
  id: string;
  vendorId: string;
  vendorName: string | null;
  inquiryId: string;
  status: string;
  totalMinor: number;
  currency: string;
  validUntil: string | null;
  notes: string | null;
  createdAt: string;
  shortlistedAt: string | null;
  lines: { kind: string; description: string; quantity: number; unitMinor: number }[];
}

export async function loadQuotes(c: PoolClient, where: string, params: unknown[]): Promise<QuoteOut[]> {
  const rows = (
    await c.query<{
      id: string; vendor_id: string; vendor_name: string | null; inquiry_id: string; status: string; total_minor: string; currency: string;
      valid_until: string | null; notes: string | null; created_at: Date; shortlisted_at: Date | null;
    }>(
      `SELECT q.id, q.vendor_id, v.name AS vendor_name, q.inquiry_id, q.status, q.total_minor::text AS total_minor, q.currency::text AS currency,
              q.valid_until::text AS valid_until, q.notes, q.created_at, q.shortlisted_at
         FROM quotes q LEFT JOIN organizations v ON v.id = q.vendor_id WHERE ${where} ORDER BY q.total_minor, q.created_at, q.id`,
      params,
    )
  ).rows;
  if (rows.length === 0) return [];
  const lines = (
    await c.query<{ quote_id: string; kind: string; description: string; quantity: number; unit_minor: string }>(
      "SELECT quote_id, kind, description, quantity, unit_minor::text AS unit_minor FROM quote_line_items WHERE quote_id = ANY($1) ORDER BY position, id",
      [rows.map((r) => r.id)],
    )
  ).rows;
  return rows.map((r) => ({
    id: r.id,
    vendorId: r.vendor_id,
    vendorName: r.vendor_name,
    inquiryId: r.inquiry_id,
    status: r.status,
    totalMinor: Number(r.total_minor),
    currency: r.currency.trim(),
    validUntil: r.valid_until,
    notes: r.notes,
    createdAt: r.created_at.toISOString(),
    shortlistedAt: r.shortlisted_at?.toISOString() ?? null,
    lines: lines.filter((l) => l.quote_id === r.id).map((l) => ({ kind: l.kind, description: l.description, quantity: l.quantity, unitMinor: Number(l.unit_minor) })),
  }));
}

export interface PaymentOut {
  id: string;
  kind: string;
  amountMinor: number;
  method: string;
  reference: string | null;
  paidOn: string;
  note: string | null;
}
export interface BookingOut {
  id: string;
  requestId: string;
  status: string;
  vendorId: string;
  vendorName: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  venueText: string | null;
  agreedTotalMinor: number;
  currency: string;
  vendorConfirmedAt: string | null;
  confirmedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  /** What the family has paid the vendor, offline, as recorded by operations. */
  payments: PaymentOut[];
  paidMinor: number;
  balanceMinor: number;
  paymentStatus: "unpaid" | "partial" | "paid";
  /** The platform's fee and what the vendor has paid of it: for operations and the vendor, never the family. */
  platformFeeMinor?: number | null;
  feePaidMinor?: number;
}
export async function loadBookings(c: PoolClient, where: string, params: unknown[], audience: "all" | "vendor" | "family" = "all"): Promise<BookingOut[]> {
  const rows = (
    await c.query<{
      id: string; request_id: string; status: string; vendor_id: string; vendor_name: string | null; scheduled_start: Date | null; scheduled_end: Date | null;
      venue_text: string | null; agreed_total_minor: string; currency: string; vendor_confirmed_at: Date | null; confirmed_at: Date | null;
      completed_at: Date | null; cancelled_at: Date | null; cancel_reason: string | null; platform_fee_minor: string | null;
    }>(
      `SELECT b.id, b.request_id, b.status, b.vendor_id, v.name AS vendor_name, b.scheduled_start, b.scheduled_end, b.venue_text, b.agreed_total_minor::text AS agreed_total_minor,
              b.currency::text AS currency, b.vendor_confirmed_at, b.confirmed_at, b.completed_at, b.cancelled_at, b.cancel_reason, b.platform_fee_minor::text AS platform_fee_minor
         FROM bookings b LEFT JOIN organizations v ON v.id = b.vendor_id WHERE ${where} ORDER BY b.created_at DESC, b.id`,
      params,
    )
  ).rows;
  if (rows.length === 0) return [];
  // row-level security decides which payment rows this caller may read (the family never receives the vendor's fee payments)
  const pay = (
    await c.query<{ id: string; booking_id: string; kind: string; amount_minor: string; method: string; reference: string | null; paid_on: string; note: string | null }>(
      "SELECT id, booking_id, kind, amount_minor::text AS amount_minor, method, reference, paid_on::text AS paid_on, note FROM booking_payments WHERE booking_id = ANY($1) ORDER BY created_at, id",
      [rows.map((r) => r.id)],
    )
  ).rows;
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  return rows.map((r) => {
    const mine = pay.filter((p) => p.booking_id === r.id);
    const toVendor = mine.filter((p) => p.kind === "family_to_vendor");
    const paid = toVendor.reduce((sum, p) => sum + Number(p.amount_minor), 0);
    const agreed = Number(r.agreed_total_minor);
    const out: BookingOut = {
      id: r.id, requestId: r.request_id, status: r.status, vendorId: r.vendor_id, vendorName: r.vendor_name,
      scheduledStart: iso(r.scheduled_start), scheduledEnd: iso(r.scheduled_end), venueText: r.venue_text, agreedTotalMinor: agreed, currency: r.currency.trim(),
      vendorConfirmedAt: iso(r.vendor_confirmed_at), confirmedAt: iso(r.confirmed_at), completedAt: iso(r.completed_at), cancelledAt: iso(r.cancelled_at), cancelReason: r.cancel_reason,
      payments: toVendor.map((p) => ({ id: p.id, kind: p.kind, amountMinor: Number(p.amount_minor), method: p.method, reference: p.reference, paidOn: p.paid_on, note: p.note })),
      paidMinor: paid, balanceMinor: Math.max(0, agreed - paid), paymentStatus: paid >= agreed && agreed > 0 ? "paid" : paid > 0 ? "partial" : "unpaid",
    };
    if (audience !== "family") {
      out.platformFeeMinor = r.platform_fee_minor === null ? null : Number(r.platform_fee_minor);
      out.feePaidMinor = mine.filter((p) => p.kind === "vendor_to_platform").reduce((sum, p) => sum + Number(p.amount_minor), 0);
    }
    return out;
  });
}

export interface ReviewOut {
  id: string;
  bookingId: string;
  vendorId: string;
  vendorName: string | null;
  rating: number;
  body: string | null;
  status: string;
  moderationNote: string | null;
  reply: string | null;
  repliedAt: string | null;
  createdAt: string;
  /** For moderators only. */
  community?: string | null;
  author?: string | null;
}
/** Reviews visible to the caller (row-level security decides which). The author's name goes only to moderators. */
export async function loadReviews(c: PoolClient, where: string, params: unknown[], forModerator = false): Promise<ReviewOut[]> {
  const rows = (
    await c.query<{
      id: string; booking_id: string; vendor_id: string; vendor_name: string | null; community_name: string | null; requester_name: string | null; rating: number; body: string | null;
      status: string; moderation_note: string | null; vendor_reply: string | null; replied_at: Date | null; created_at: Date;
    }>(
      `SELECT r.id, r.booking_id, r.vendor_id, v.name AS vendor_name, o.name AS community_name, u.display_name AS requester_name, r.rating, r.body, r.status,
              r.moderation_note, r.vendor_reply, r.replied_at, r.created_at
         FROM reviews r LEFT JOIN organizations v ON v.id = r.vendor_id LEFT JOIN organizations o ON o.id = r.tenant_id LEFT JOIN users u ON u.id = r.requester_id
        WHERE ${where} ORDER BY r.created_at DESC, r.id LIMIT 100`,
      params,
    )
  ).rows;
  return rows.map((r) => ({
    id: r.id, bookingId: r.booking_id, vendorId: r.vendor_id, vendorName: r.vendor_name, rating: r.rating, body: r.body, status: r.status, moderationNote: r.moderation_note,
    reply: r.vendor_reply, repliedAt: r.replied_at?.toISOString() ?? null, createdAt: r.created_at.toISOString(),
    ...(forModerator ? { community: r.community_name, author: r.requester_name } : {}),
  }));
}
export async function loadReview(c: PoolClient, bookingId: string): Promise<ReviewOut | null> {
  return (await loadReviews(c, "r.booking_id = $1", [bookingId]))[0] ?? null;
}

/**
 * Keeps inquiries, quotes and bookings in step with a request's status change. Runs inside the same transaction, before
 * the request's own update, so the database's workflow and booking triggers see a consistent picture.
 */
export async function prepareTransition(
  c: PoolClient,
  t: { requestId: string; from: string; to: string; note: string | undefined; isStaff: boolean },
): Promise<void> {
  const { requestId: id, from, to } = t;
  const count = async (sql: string) => (await c.query<{ n: number }>(sql, [id])).rows[0]?.n ?? 0;
  const notReady = (message: string) => new AppError(409, "not_ready", message);

  if (to === "vendor_inquiry" && from !== "vendor_inquiry" && (await count("SELECT count(*)::int AS n FROM inquiries WHERE request_id = $1 AND status <> 'withdrawn'")) === 0) {
    throw notReady("Ask at least one vendor first.");
  }
  if (to === "quotes_received" && from === "vendor_inquiry" && (await count("SELECT count(*)::int AS n FROM quotes WHERE request_id = $1 AND status IN ('submitted', 'shortlisted')")) === 0) {
    throw notReady("No vendor has quoted yet.");
  }
  if (to === "shortlisted" && (await count("SELECT count(*)::int AS n FROM quotes WHERE request_id = $1 AND status = 'shortlisted'")) === 0) {
    throw notReady("Shortlist at least one quote to offer the family.");
  }
  if (to === "confirmed") {
    const b = (await c.query<{ id: string; vendor_confirmed_at: Date | null }>("SELECT id, vendor_confirmed_at FROM bookings WHERE request_id = $1 AND status = 'pending_vendor' FOR UPDATE", [id])).rows[0];
    if (!b) throw notReady("There is no booking waiting to be confirmed.");
    if (!b.vendor_confirmed_at) throw new AppError(409, "vendor_not_confirmed", "The vendor has not confirmed the booking yet.");
    await c.query("UPDATE bookings SET status = 'confirmed' WHERE id = $1", [b.id]);
  }
  if (to === "confirmed" || to === "completed") await c.query("UPDATE inquiries SET status = 'withdrawn' WHERE request_id = $1 AND status = 'sent'", [id]);
  if (to === "completed") await c.query("UPDATE bookings SET status = 'completed' WHERE request_id = $1 AND status = 'confirmed'", [id]);
  if (to === "cancelled" || (to === "sourcing" && from === "booking_pending") || to === "closed") {
    const reason = t.note?.trim() || (t.isStaff ? "Cancelled by the team" : "Cancelled by the family");
    await c.query("UPDATE bookings SET status = 'cancelled', cancel_reason = $2 WHERE request_id = $1 AND status IN ('pending_vendor', 'confirmed')", [id, reason]);
    if (to === "sourcing") await c.query("UPDATE quotes SET status = 'rejected' WHERE request_id = $1 AND status = 'accepted'", [id]);
  }
  // Once the request is decided or finished, vendors are no longer waiting for an answer.
  if (["booking_pending", "cancelled", "closed", "rejected"].includes(to)) {
    await c.query("UPDATE inquiries SET status = 'withdrawn' WHERE request_id = $1 AND status = 'sent'", [id]);
  }
}

/* ------------------------------------------------------------------ routes */

export async function sourcingRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool } = deps;
  const requirePermission = makeRequirePermission(deps);
  const requireAny = makeRequireAnyPermission(deps);

  const state = (req: { tenantState?: TenantState }): TenantState => {
    if (!req.tenantState) throw new AppError(400, "tenant_required", "Select an organization first.");
    return req.tenantState;
  };
  const requireOps = (s: TenantState): void => {
    if (!s.platformScope) throw new AppError(403, "platform_scope_required", "Sourcing is for the operations team.");
  };
  const requireVendorContext = (s: TenantState): void => {
    if (s.platformScope) throw new AppError(403, "vendor_context_required", "Switch to the vendor you are working for.");
  };

  interface RequestRow {
    id: string; tenant_id: string; requester_id: string; status: string; title: string; description: string | null; category_id: string | null; category_name: string | null;
    preferred_date: string | null; flexible_dates: boolean; participant_count: number | null; age_min: number | null; age_max: number | null;
    budget_max_minor: string | null; venue_text: string | null; answers: Record<string, unknown>; form_schema: { fields: { key: string; label: string; options?: { value: string; label: string }[] }[] };
    community_name: string; locality: string | null; city: string | null;
  }
  async function loadRequest(c: PoolClient, id: string, lock = false): Promise<RequestRow> {
    const row = (
      await c.query<RequestRow>(
        `SELECT r.id, r.tenant_id, r.requester_id, r.status, r.title, r.description, r.category_id, cat.name AS category_name, r.preferred_date::text AS preferred_date, r.flexible_dates,
                r.participant_count, r.age_min, r.age_max, r.budget_max_minor::text AS budget_max_minor, r.venue_text, r.answers, rt.form_schema,
                o.name AS community_name, cp.locality, cp.city
           FROM requests r JOIN request_types rt ON rt.id = r.request_type_id JOIN organizations o ON o.id = r.tenant_id
           LEFT JOIN categories cat ON cat.id = r.category_id LEFT JOIN community_profiles cp ON cp.tenant_id = r.tenant_id
          WHERE r.id = $1 ${lock ? "FOR UPDATE OF r" : ""}`,
        [id],
      )
    ).rows[0];
    if (!row) throw new AppError(404, "not_found", "Request not found.");
    return row;
  }
  const facts = (r: RequestRow): RequestFacts => ({
    id: r.id, tenantId: r.tenant_id, categoryId: r.category_id, preferredDate: r.preferred_date, participantCount: r.participant_count, ageMin: r.age_min, ageMax: r.age_max,
    budgetMaxMinor: r.budget_max_minor === null ? null : Number(r.budget_max_minor),
  });
  const assertSourcing = (r: RequestRow): void => {
    if (!SOURCING_STATES.includes(r.status)) throw new AppError(409, "not_in_sourcing", "This request is not at the stage of finding vendors.");
  };

  /* ---------------------------------------------------------- the ops view */

  app.get("/requests/:id/sourcing", { preHandler: requirePermission("requests.read_all") }, async (req) => {
    const s = state(req);
    requireOps(s);
    const { id } = idParam.parse(req.params);
    return withContext(pool, dbContext(s), async (c) => {
      const r = await loadRequest(c, id);
      const matches = (
        await c.query<{ vendor_id: string; vendor_name: string; offering_id: string | null; offering_name: string | null; score: number; reasons: Match["reasons"]; source: string; manual_reason: string | null }>(
          `SELECT m.vendor_id, v.name AS vendor_name, m.offering_id, o.name AS offering_name, m.score, m.reasons, m.source, m.manual_reason
             FROM request_matches m JOIN organizations v ON v.id = m.vendor_id LEFT JOIN offerings o ON o.id = m.offering_id WHERE m.request_id = $1 ORDER BY m.score DESC, v.name`,
          [id],
        )
      ).rows;
      const inquiries = (
        await c.query<{ id: string; vendor_id: string; vendor_name: string; status: string; message: string | null; sent_at: Date; responded_at: Date | null; decline_reason: string | null }>(
          "SELECT i.id, i.vendor_id, v.name AS vendor_name, i.status, i.message, i.sent_at, i.responded_at, i.decline_reason FROM inquiries i JOIN organizations v ON v.id = i.vendor_id WHERE i.request_id = $1 ORDER BY i.sent_at, i.id",
          [id],
        )
      ).rows;
      const quotes = await loadQuotes(c, "q.request_id = $1", [id]);
      const bookings = await loadBookings(c, "b.request_id = $1", [id]);
      const asked = new Set(inquiries.filter((i) => i.status !== "withdrawn").map((i) => i.vendor_id));
      return {
        status: r.status,
        canMatch: SOURCING_STATES.includes(r.status),
        matches: matches.map((m) => ({
          vendorId: m.vendor_id, vendorName: m.vendor_name, offering: m.offering_id ? { id: m.offering_id, name: m.offering_name } : null,
          score: m.score, reasons: m.reasons, source: m.source, manualReason: m.manual_reason, asked: asked.has(m.vendor_id),
        })),
        inquiries: inquiries.map((i) => ({
          id: i.id, vendorId: i.vendor_id, vendorName: i.vendor_name, status: i.status, message: i.message, sentAt: i.sent_at.toISOString(),
          respondedAt: i.responded_at?.toISOString() ?? null, declineReason: i.decline_reason,
        })),
        quotes,
        booking: bookings.find((b) => b.status !== "cancelled") ?? null,
        cancelledBookings: bookings.filter((b) => b.status === "cancelled"),
      };
    });
  });

  /* -------------------------------------------------------------- matching */

  async function persistMatches(c: PoolClient, r: RequestRow, matches: Match[], userId: string): Promise<void> {
    await c.query("DELETE FROM request_matches WHERE request_id = $1 AND source = 'auto'", [r.id]);
    for (const m of matches.slice(0, 10)) {
      await c.query(
        `INSERT INTO request_matches (tenant_id, request_id, vendor_id, offering_id, score, reasons, source, weights_version, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'auto', $7, $8) ON CONFLICT (request_id, vendor_id) DO NOTHING`,
        [r.tenant_id, r.id, m.vendorId, m.offeringId, m.score, JSON.stringify(m.reasons), WEIGHTS_VERSION, userId],
      );
    }
  }

  app.post("/requests/:id/matching/run", { preHandler: requirePermission("matching.run") }, async (req) => {
    const s = state(req);
    requireOps(s);
    const { id } = idParam.parse(req.params);
    const count = await withContext(pool, dbContext(s), async (c) => {
      const r = await loadRequest(c, id, true);
      assertSourcing(r);
      const matches = await scoreVendors(c, facts(r), await eligibleVendors(c, r.tenant_id));
      await persistMatches(c, r, matches, s.userId);
      await writeAudit(c, { tenantId: r.tenant_id, actorUserId: s.userId, action: "request.matching_run", entityType: "request", entityId: id, metadata: { suggested: Math.min(matches.length, 10) }, requestId: req.id });
      return Math.min(matches.length, 10);
    });
    return { suggested: count };
  });

  /** Adds a vendor the scoring did not suggest, with a logged reason. Safety rules still apply: it must be eligible. */
  app.post("/requests/:id/matching/manual", { preHandler: requirePermission("matching.override") }, async (req) => {
    const s = state(req);
    requireOps(s);
    const { id } = idParam.parse(req.params);
    const body = manualSchema.parse(req.body);
    await withContext(pool, dbContext(s), async (c) => {
      const r = await loadRequest(c, id, true);
      assertSourcing(r);
      const eligible = (await eligibleVendors(c, r.tenant_id)).filter((v) => v.id === body.vendorId);
      if (eligible.length === 0) throw new AppError(400, "vendor_not_eligible", "That vendor cannot be offered to this community: it must be active, serve the community, have current documents and be approved by it.");
      const [match] = await scoreVendors(c, facts(r), eligible);
      const there = await c.query("SELECT 1 FROM request_matches WHERE request_id = $1 AND vendor_id = $2", [id, body.vendorId]);
      if (there.rowCount) throw new AppError(409, "already_suggested", "That vendor is already in the list.");
      await c.query(
        `INSERT INTO request_matches (tenant_id, request_id, vendor_id, offering_id, score, reasons, source, manual_reason, weights_version, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7, $8, $9)`,
        [r.tenant_id, id, body.vendorId, match?.offeringId ?? null, match?.score ?? 0, JSON.stringify(match?.reasons ?? []), body.reason, WEIGHTS_VERSION, s.userId],
      );
      await writeAudit(c, { tenantId: r.tenant_id, actorUserId: s.userId, action: "request.match_added", entityType: "request", entityId: id, metadata: { vendorId: body.vendorId }, requestId: req.id });
    });
    return { ok: true };
  });

  /* ------------------------------------------------------------- inquiries */

  app.post("/requests/:id/inquiries", { preHandler: requirePermission("inquiries.send") }, async (req, reply) => {
    const s = state(req);
    requireOps(s);
    const { id } = idParam.parse(req.params);
    const body = sendSchema.parse(req.body);
    const vendorIds = [...new Set(body.vendorIds)];
    const outbox = new Outbox(deps, req.log);
    const sent = await withContext(pool, dbContext(s), async (c) => {
      const r = await loadRequest(c, id, true);
      assertSourcing(r);
      const existing = (await c.query<{ vendor_id: string; status: string }>("SELECT vendor_id, status FROM inquiries WHERE request_id = $1", [id])).rows;
      if (existing.length + vendorIds.length > MAX_INQUIRIES_PER_REQUEST) throw new AppError(422, "limit_reached", `At most ${MAX_INQUIRIES_PER_REQUEST} vendors can be asked about one request.`);
      if (vendorIds.some((v) => existing.some((e) => e.vendor_id === v))) throw new AppError(409, "already_asked", "One of those vendors has already been asked.");
      // only vendors that were suggested for this request, and are STILL eligible now
      const suggested = new Set((await c.query<{ vendor_id: string }>("SELECT vendor_id FROM request_matches WHERE request_id = $1", [id])).rows.map((m) => m.vendor_id));
      const eligible = new Set((await eligibleVendors(c, r.tenant_id)).map((v) => v.id));
      for (const v of vendorIds) {
        if (!suggested.has(v)) throw new AppError(400, "vendor_not_suggested", "Run matching, or add the vendor with a reason, before asking them.");
        if (!eligible.has(v)) throw new AppError(400, "vendor_not_eligible", "A vendor you chose can no longer be offered to this community.");
      }
      const offeringOf = new Map((await c.query<{ vendor_id: string; offering_id: string | null }>("SELECT vendor_id, offering_id FROM request_matches WHERE request_id = $1", [id])).rows.map((m) => [m.vendor_id, m.offering_id]));
      // What a vendor is allowed to know. Never who asked.
      const answers = r.form_schema.fields
        .filter((f) => r.answers[f.key] !== undefined)
        .map((f) => {
          const value = r.answers[f.key];
          const label = (v: unknown) => f.options?.find((o) => o.value === v)?.label ?? String(v);
          return { label: f.label, value: Array.isArray(value) ? value.map(label).join(", ") : typeof value === "boolean" ? (value ? "Yes" : "No") : f.options ? label(value) : String(value) };
        });
      const snapshot = {
        title: r.title, description: r.description, category: r.category_name, preferredDate: r.preferred_date, flexibleDates: r.flexible_dates,
        participantCount: r.participant_count, ageMin: r.age_min, ageMax: r.age_max, budgetMaxMinor: r.budget_max_minor === null ? null : Number(r.budget_max_minor),
        venueText: r.venue_text, community: { name: r.community_name, locality: r.locality, city: r.city }, answers,
      };
      const ids: string[] = [];
      for (const v of vendorIds) {
        const row = await c.query<{ id: string }>(
          "INSERT INTO inquiries (tenant_id, request_id, vendor_id, offering_id, message, snapshot, sent_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
          [r.tenant_id, id, v, offeringOf.get(v) ?? null, body.message?.trim() || null, JSON.stringify(snapshot), s.userId],
        );
        if (row.rows[0]) ids.push(row.rows[0].id);
      }
      // the first inquiries move the request on (and more inquiries after quotes arrived reopen the asking stage)
      if (r.status !== "vendor_inquiry") {
        await c.query("SELECT set_config('app.note', '', true)");
        await c.query("UPDATE requests SET status = 'vendor_inquiry' WHERE id = $1", [id]);
      }
      await writeAudit(c, { tenantId: r.tenant_id, actorUserId: s.userId, action: "request.inquiries_sent", entityType: "request", entityId: id, metadata: { count: ids.length }, requestId: req.id });
      for (const v of vendorIds) outbox.event(deps.config, await vendorTeamEmails(c, v, "inquiries.respond"), "A request to quote", "You have been asked to quote for a family request.", "/app/inquiries");
      return ids;
    });
    await outbox.flush();
    return reply.code(201).send({ sent });
  });

  app.post("/inquiries/:id/withdraw", { preHandler: requirePermission("inquiries.send") }, async (req) => {
    const s = state(req);
    requireOps(s);
    const { id } = idParam.parse(req.params);
    await withContext(pool, dbContext(s), async (c) => {
      const res = await c.query<{ tenant_id: string }>("UPDATE inquiries SET status = 'withdrawn' WHERE id = $1 AND status = 'sent' RETURNING tenant_id", [id]);
      if (!res.rows[0]) throw new AppError(409, "not_open", "That inquiry is not waiting for an answer.");
      await writeAudit(c, { tenantId: res.rows[0].tenant_id, actorUserId: s.userId, action: "inquiry.withdrawn", entityType: "inquiry", entityId: id, requestId: req.id });
    });
    return { ok: true };
  });

  /* ----------------------------------------------------- the vendor's side */

  app.get("/inquiries", { preHandler: requireAny("inquiries.respond") }, async (req) => {
    const s = state(req);
    requireVendorContext(s);
    const q = z.object({ status: z.enum(["sent", "declined", "quoted", "withdrawn"]).optional() }).strict().parse(req.query);
    const rows = await withContext(pool, dbContext(s), async (c) =>
      (
        await c.query<{ id: string; status: string; sent_at: Date; responded_at: Date | null; snapshot: { title?: string; preferredDate?: string | null; participantCount?: number | null; community?: { name?: string } }; quote_status: string | null }>(
          `SELECT i.id, CASE WHEN i.status = 'sent' AND COALESCE(f.closed, false) THEN 'withdrawn' ELSE i.status END AS status, i.sent_at, i.responded_at, i.snapshot,
                  (SELECT qq.status FROM quotes qq WHERE qq.inquiry_id = i.id AND qq.status IN ('submitted', 'shortlisted', 'accepted') LIMIT 1) AS quote_status
             FROM inquiries i LEFT JOIN request_stage_flags f ON f.request_id = i.request_id
            ${q.status ? "WHERE (CASE WHEN i.status = 'sent' AND COALESCE(f.closed, false) THEN 'withdrawn' ELSE i.status END) = $1" : ""} ORDER BY i.sent_at DESC, i.id LIMIT 100`,
          q.status ? [q.status] : [],
        )
      ).rows,
    );
    return {
      data: rows.map((r) => ({
        id: r.id, status: r.status, sentAt: r.sent_at.toISOString(), respondedAt: r.responded_at?.toISOString() ?? null, quoteStatus: r.quote_status,
        title: r.snapshot.title ?? "", preferredDate: r.snapshot.preferredDate ?? null, participantCount: r.snapshot.participantCount ?? null, community: r.snapshot.community?.name ?? "",
      })),
    };
  });

  app.get("/inquiries/:id", { preHandler: requireAny("inquiries.respond") }, async (req) => {
    const s = state(req);
    requireVendorContext(s);
    const { id } = idParam.parse(req.params);
    return withContext(pool, dbContext(s), async (c) => {
      const i = (await c.query<{ id: string; status: string; message: string | null; snapshot: unknown; sent_at: Date; responded_at: Date | null; decline_reason: string | null; request_id: string }>(
        "SELECT i.id, CASE WHEN i.status = 'sent' AND COALESCE(f.closed, false) THEN 'withdrawn' ELSE i.status END AS status, i.message, i.snapshot, i.sent_at, i.responded_at, i.decline_reason, i.request_id FROM inquiries i LEFT JOIN request_stage_flags f ON f.request_id = i.request_id WHERE i.id = $1", [id])).rows[0];
      if (!i) throw new AppError(404, "not_found", "Inquiry not found.");
      const quotes = await loadQuotes(c, "q.inquiry_id = $1", [id]);
      const bookings = await loadBookings(c, "b.request_id = $1", [i.request_id], "vendor");
      const live = bookings.find((b) => b.status !== "cancelled") ?? null;
      return {
        review: live ? await loadReview(c, live.id) : null,
        id: i.id, status: i.status, message: i.message, request: i.snapshot, sentAt: i.sent_at.toISOString(), respondedAt: i.responded_at?.toISOString() ?? null, declineReason: i.decline_reason,
        quotes, booking: bookings.find((b) => b.status !== "cancelled") ?? null,
      };
    });
  });

  app.post("/inquiries/:id/decline", { preHandler: requirePermission("inquiries.respond") }, async (req) => {
    const s = state(req);
    requireVendorContext(s);
    const { id } = idParam.parse(req.params);
    const body = declineSchema.parse(req.body);
    const outbox = new Outbox(deps, req.log);
    await withContext(pool, dbContext(s), async (c) => {
      const res = await c.query("UPDATE inquiries SET status = 'declined', decline_reason = $2, responded_at = now() WHERE id = $1 AND status = 'sent'", [id, body.reason]);
      if (!res.rowCount) throw new AppError(409, "not_open", "That inquiry is not waiting for your answer.");
      await writeAudit(c, { tenantId: s.tenantId, actorUserId: s.userId, action: "inquiry.declined", entityType: "inquiry", entityId: id, requestId: req.id });
      outbox.event(deps.config, [deps.config.opsAlertEmail], "A vendor declined", "A vendor has declined a request to quote.", "/app/requests");
    });
    await outbox.flush();
    return { ok: true };
  });

  /** A vendor quotes for its own inquiry; operations can also capture a quote they obtained by phone. */
  app.post("/inquiries/:id/quote", { preHandler: requirePermission("quotes.create") }, async (req, reply) => {
    const s = state(req);
    const { id } = idParam.parse(req.params);
    const body = quoteSchema.parse(req.body);
    const total = body.lines.reduce((sum, l) => sum + l.quantity * l.unitMinor, 0);
    const outbox = new Outbox(deps, req.log);
    if (total > 100_000_000_000) throw new AppError(400, "validation_failed", "That total is too large.", [{ field: "lines", message: "Check the amounts." }]);
    const quoteId = await withContext(pool, dbContext(s), async (c) => {
      const i = (await c.query<{ id: string; tenant_id: string; request_id: string; vendor_id: string; status: string }>("SELECT id, tenant_id, request_id, vendor_id, status FROM inquiries WHERE id = $1", [id])).rows[0];
      if (!i) throw new AppError(404, "not_found", "Inquiry not found.");
      if (i.status !== "sent" && i.status !== "quoted") throw new AppError(409, "not_open", "That inquiry is no longer waiting for a quote.");
      if (!s.platformScope) {
        const stage = await c.query<{ closed: boolean }>("SELECT closed FROM request_stage_flags WHERE request_id = $1", [i.request_id]);
        if (stage.rows[0]?.closed) throw new AppError(409, "not_open", "That request has moved on, so it no longer needs a quote.");
      }
      if (body.validUntil) {
        const ok = await c.query<{ ok: boolean }>("SELECT $1::date >= current_date AS ok", [body.validUntil]);
        if (!ok.rows[0]?.ok) throw new AppError(400, "validation_failed", "The quote cannot already be out of date.", [{ field: "validUntil", message: "Choose today or a later date." }]);
      }
      const live = await c.query("SELECT 1 FROM quotes WHERE inquiry_id = $1 AND status IN ('submitted', 'shortlisted', 'accepted')", [id]);
      if (live.rowCount) throw new AppError(409, "quote_exists", "There is already a quote. Withdraw it first to send a corrected one.");
      let created: string | undefined;
      try {
        created = (
          await c.query<{ id: string }>(
            "INSERT INTO quotes (tenant_id, request_id, inquiry_id, vendor_id, total_minor, valid_until, notes, submitted_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
            [i.tenant_id, i.request_id, i.id, i.vendor_id, total, body.validUntil ?? null, body.notes?.trim() || null, s.userId],
          )
        ).rows[0]?.id;
      } catch (err) {
        if ((err as { code?: string }).code === "42501") throw forbidden();
        throw err;
      }
      if (!created) throw new Error("quote insert returned no row");
      let position = 0;
      for (const l of body.lines) {
        await c.query("INSERT INTO quote_line_items (tenant_id, quote_id, position, kind, description, quantity, unit_minor) VALUES ($1, $2, $3, $4, $5, $6, $7)", [i.tenant_id, created, position++, l.kind, l.description, l.quantity, l.unitMinor]);
      }
      if (i.status === "sent") await c.query("UPDATE inquiries SET status = 'quoted', responded_at = now() WHERE id = $1", [id]);
      await writeAudit(c, { tenantId: s.platformScope ? i.tenant_id : s.tenantId, actorUserId: s.userId, action: "quote.submitted", entityType: "quote", entityId: created, requestId: req.id });
      if (!s.platformScope) outbox.event(deps.config, [deps.config.opsAlertEmail], "A quote arrived", "A vendor has sent a quote.", `/app/requests/${i.request_id}`);
      return created;
    });
    await outbox.flush();
    const quote = await withContext(pool, dbContext(s), (c) => loadQuotes(c, "q.id = $1", [quoteId]));
    return reply.code(201).send(quote[0]);
  });

  app.post("/quotes/:id/withdraw", { preHandler: requirePermission("quotes.create") }, async (req) => {
    const s = state(req);
    const { id } = idParam.parse(req.params);
    await withContext(pool, dbContext(s), async (c) => {
      const cur = (await c.query<{ status: string; tenant_id: string }>("SELECT status, tenant_id FROM quotes WHERE id = $1", [id])).rows[0];
      if (!cur) throw new AppError(404, "not_found", "Quote not found.");
      if (cur.status === "shortlisted" || cur.status === "accepted") throw new AppError(409, "quote_in_use", "This quote has been offered to the family, so the team must take it off the list first.");
      if (cur.status !== "submitted") throw new AppError(409, "not_open", "This quote can no longer be withdrawn.");
      await c.query("UPDATE quotes SET status = 'withdrawn' WHERE id = $1", [id]);
      await writeAudit(c, { tenantId: s.platformScope ? cur.tenant_id : s.tenantId, actorUserId: s.userId, action: "quote.withdrawn", entityType: "quote", entityId: id, requestId: req.id });
    });
    return { ok: true };
  });

  /* ------------------------------------------------- comparing and offering */

  app.put("/quotes/:id/shortlist", { preHandler: requirePermission("quotes.compare") }, async (req) => {
    const s = state(req);
    requireOps(s);
    const { id } = idParam.parse(req.params);
    const body = shortlistSchema.parse(req.body);
    await withContext(pool, dbContext(s), async (c) => {
      const q = (await c.query<{ status: string; request_id: string; tenant_id: string }>("SELECT status, request_id, tenant_id FROM quotes WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!q) throw new AppError(404, "not_found", "Quote not found.");
      const request = (await c.query<{ status: string }>("SELECT status FROM requests WHERE id = $1", [q.request_id])).rows[0];
      if (request?.status !== "quotes_received") throw new AppError(409, "not_comparing", "Quotes can be shortlisted while the request is at the stage of comparing quotes.");
      const from = body.shortlisted ? "submitted" : "shortlisted";
      const to = body.shortlisted ? "shortlisted" : "submitted";
      if (q.status !== from) throw new AppError(409, "invalid_state", `Only a ${from} quote can be ${body.shortlisted ? "shortlisted" : "taken off the list"}.`);
      await c.query("UPDATE quotes SET status = $2, shortlisted_at = $3 WHERE id = $1", [id, to, body.shortlisted ? new Date() : null]);
      await writeAudit(c, { tenantId: q.tenant_id, actorUserId: s.userId, action: body.shortlisted ? "quote.shortlisted" : "quote.unshortlisted", entityType: "quote", entityId: id, requestId: req.id });
    });
    return { ok: true };
  });

  /** The family chooses one of the offered quotes: it is accepted, the request moves on and the booking is opened. */
  app.post("/requests/:id/quotes/:quoteId/accept", { preHandler: requirePermission("quotes.accept") }, async (req, reply) => {
    const s = state(req);
    if (s.platformScope) throw forbidden(); // only the family accepts, never the team on their behalf
    const { id, quoteId } = z.object({ id: z.uuid(), quoteId: z.uuid() }).parse(req.params);
    const outbox = new Outbox(deps, req.log);
    const bookingId = await withContext(pool, dbContext(s), async (c) => {
      const r = (await c.query<{ status: string; tenant_id: string }>("SELECT status, tenant_id FROM requests WHERE id = $1 AND requester_id = $2 FOR UPDATE", [id, s.userId])).rows[0];
      if (!r) throw new AppError(404, "not_found", "Request not found.");
      if (r.status !== "shortlisted") throw new AppError(409, "not_offered", "There are no options to choose from right now.");
      const q = (await c.query<{ vendor_id: string; total_minor: string; currency: string; status: string }>("SELECT vendor_id, total_minor::text AS total_minor, currency::text AS currency, status FROM quotes WHERE id = $1 AND request_id = $2", [quoteId, id])).rows[0];
      if (!q) throw new AppError(404, "not_found", "That option was not found.");
      if (q.status !== "shortlisted") throw new AppError(409, "not_offered", "That option is not on offer.");
      await c.query("UPDATE quotes SET status = 'accepted' WHERE id = $1", [quoteId]);
      await c.query("SELECT set_config('app.note', '', true)");
      await c.query("UPDATE requests SET status = 'booking_pending' WHERE id = $1", [id]);
      const booking = await c.query<{ id: string }>(
        "INSERT INTO bookings (tenant_id, request_id, quote_id, vendor_id, agreed_total_minor, currency, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
        [r.tenant_id, id, quoteId, q.vendor_id, q.total_minor, q.currency.trim(), s.userId],
      );
      const created = booking.rows[0]?.id;
      if (!created) throw new Error("booking insert returned no row");
      await writeAudit(c, { tenantId: r.tenant_id, actorUserId: s.userId, action: "quote.accepted", entityType: "quote", entityId: quoteId, metadata: { requestId: id }, requestId: req.id });
      outbox.event(deps.config, [deps.config.opsAlertEmail], "A family chose an option", "A family has chosen one of the options. A booking is ready to schedule.", `/app/requests/${id}`);
      return created;
    });
    await outbox.flush();
    return reply.code(201).send({ requestId: id, bookingId });
  });

  /* -------------------------------------------------------------- bookings */

  app.get("/bookings", { preHandler: requireAny("bookings.confirm", "inquiries.respond") }, async (req) => {
    const s = state(req);
    const q = z.object({ status: z.enum(["pending_vendor", "confirmed", "completed", "cancelled"]).optional() }).strict().parse(req.query);
    const rows = await withContext(pool, dbContext(s), async (c) => loadBookings(c, q.status ? "b.status = $1" : "true", q.status ? [q.status] : []));
    // a vendor reads its own bookings only; operations (platform scope) read all
    if (!s.platformScope && !s.permissions.has("inquiries.respond")) throw forbidden();
    return { data: rows };
  });

  app.post("/bookings/:id/schedule", { preHandler: requirePermission("bookings.confirm") }, async (req) => {
    const s = state(req);
    requireOps(s);
    const { id } = idParam.parse(req.params);
    const body = scheduleSchema.parse(req.body);
    const outbox = new Outbox(deps, req.log);
    await withContext(pool, dbContext(s), async (c) => {
      if (new Date(body.start) < new Date()) throw new AppError(400, "validation_failed", "The booking cannot start in the past.", [{ field: "start", message: "Choose a later time." }]);
      const cur = (await c.query<{ status: string; tenant_id: string; vendor_confirmed_at: Date | null; vendor_id: string; request_id: string }>("SELECT status, tenant_id, vendor_confirmed_at, vendor_id, request_id FROM bookings WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!cur) throw new AppError(404, "not_found", "Booking not found.");
      if (cur.status !== "pending_vendor") throw new AppError(409, "invalid_state", "Only a booking waiting for the vendor can be rescheduled.");
      await c.query("UPDATE inquiries SET status = 'withdrawn' WHERE request_id = $1 AND status = 'sent'", [(await c.query<{ request_id: string }>("SELECT request_id FROM bookings WHERE id = $1", [id])).rows[0]?.request_id]);
      // a changed time needs the vendor's agreement again
      await c.query("UPDATE bookings SET scheduled_start = $2, scheduled_end = $3, venue_text = $4, vendor_confirmed_at = NULL, vendor_confirmed_by = NULL WHERE id = $1", [id, body.start, body.end, body.venueText?.trim() || null]);
      await writeAudit(c, { tenantId: cur.tenant_id, actorUserId: s.userId, action: "booking.scheduled", entityType: "booking", entityId: id, requestId: req.id });
      outbox.event(deps.config, await vendorTeamEmails(c, cur.vendor_id, "inquiries.respond"), "Please confirm a date", "A date and place have been set for a booking. Please confirm it.", "/app/inquiries");
      const asker = (await c.query<{ requester_id: string }>("SELECT requester_id FROM requests WHERE id = $1", [cur.request_id])).rows[0];
      if (asker) outbox.event(deps.config, [await userEmail(c, asker.requester_id)], "A date has been proposed", "A date and place have been proposed for your booking.", `/app/requests/${cur.request_id}`);
    });
    await outbox.flush();
    return { ok: true };
  });

  app.post("/bookings/:id/vendor-confirm", { preHandler: requirePermission("inquiries.respond") }, async (req) => {
    const s = state(req);
    requireVendorContext(s);
    const { id } = idParam.parse(req.params);
    const outbox = new Outbox(deps, req.log);
    await withContext(pool, dbContext(s), async (c) => {
      const cur = (await c.query<{ status: string; scheduled_start: Date | null }>("SELECT status, scheduled_start FROM bookings WHERE id = $1", [id])).rows[0];
      if (!cur) throw new AppError(404, "not_found", "Booking not found.");
      if (cur.status !== "pending_vendor") throw new AppError(409, "invalid_state", "This booking is not waiting for you.");
      if (!cur.scheduled_start) throw new AppError(409, "not_scheduled", "The team has not set a date yet.");
      await c.query("UPDATE bookings SET vendor_confirmed_at = now(), vendor_confirmed_by = $2 WHERE id = $1", [id, s.userId]);
      await writeAudit(c, { tenantId: s.tenantId, actorUserId: s.userId, action: "booking.vendor_confirmed", entityType: "booking", entityId: id, requestId: req.id });
      outbox.event(deps.config, [deps.config.opsAlertEmail], "A vendor confirmed a date", "A vendor has confirmed a booking date. It is ready for you to confirm.", "/app/requests");
    });
    await outbox.flush();
    return { ok: true };
  });

  app.post("/bookings/:id/vendor-decline", { preHandler: requirePermission("inquiries.respond") }, async (req) => {
    const s = state(req);
    requireVendorContext(s);
    const { id } = idParam.parse(req.params);
    const body = declineSchema.parse(req.body);
    const outbox = new Outbox(deps, req.log);
    await withContext(pool, dbContext(s), async (c) => {
      const res = await c.query("UPDATE bookings SET status = 'cancelled', cancel_reason = $2 WHERE id = $1 AND status = 'pending_vendor'", [id, `Declined by the vendor: ${body.reason}`]);
      if (!res.rowCount) throw new AppError(409, "invalid_state", "This booking is not waiting for you.");
      await writeAudit(c, { tenantId: s.tenantId, actorUserId: s.userId, action: "booking.vendor_declined", entityType: "booking", entityId: id, requestId: req.id });
      outbox.event(deps.config, [deps.config.opsAlertEmail], "A vendor declined a booking", "A vendor has declined a booking. It needs another vendor.", "/app/requests");
    });
    await outbox.flush();
    return { ok: true };
  });
}
