import type { FastifyInstance } from "fastify";
import { withContext } from "@kidos/db";
import type { PoolClient } from "pg";
import { z } from "zod";
import { writeAudit } from "../audit";
import { AppError, forbidden } from "../errors";
import { dbContext, makeRequireAnyPermission, makeRequirePermission } from "../guards";
import { cursorTimestamp, decodeCursor, encodeCursor, pageParams } from "../pagination";
import { likePattern } from "../sql-helpers";
import { validateAnswers, type FormSchema } from "../request-forms";
import type { Deps, TenantState } from "../types";
import { Outbox, userEmail, vendorTeamEmails } from "../notify";
import { loadBookings, loadQuotes, loadReview, prepareTransition } from "./sourcing";

const MAX_OPEN_PER_PERSON = 20;
const MAX_COMMENTS_PER_REQUEST = 200;

const text = (max: number) => z.string().trim().max(max);
const createSchema = z
  .object({
    requestTypeId: z.uuid(),
    title: text(120).min(3),
    description: text(3000).nullable().optional(),
    categoryId: z.uuid().nullable().optional(),
    offeringId: z.uuid().nullable().optional(),
    preferredDate: z.iso.date().nullable().optional(),
    flexibleDates: z.boolean().optional(),
    participantCount: z.number().int().min(1).max(1000).nullable().optional(),
    ageMin: z.number().int().min(0).max(100).nullable().optional(),
    ageMax: z.number().int().min(0).max(100).nullable().optional(),
    budgetMaxMinor: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
    venueText: text(200).nullable().optional(),
    answers: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .refine((v) => v.ageMin == null || v.ageMax == null || v.ageMax >= v.ageMin, { message: "The oldest age cannot be below the youngest.", path: ["ageMax"] });

const listQuery = z
  .object({
    ...pageParams,
    status: z.string().regex(/^[a-z_]+$/u).max(40).optional(),
    open: z.enum(["true", "false"]).optional(),
    sla: z.enum(["overdue", "due_soon"]).optional(),
    assigned: z.enum(["me", "unassigned"]).optional(),
    mine: z.enum(["true", "false"]).optional(),
    q: z.string().trim().max(80).optional(),
    communityId: z.uuid().optional(),
  })
  .strict();
const transitionSchema = z.object({ to: z.string().regex(/^[a-z_]+$/u).max(40), note: text(1000).optional() }).strict();
const commentSchema = z
  .object({ body: text(2000).min(1), visibility: z.enum(["resident", "internal"]).default("resident"), returnToReview: z.boolean().optional() })
  .strict();
const assigneeSchema = z.object({ userId: z.uuid().nullable() }).strict();

type Audience = "all" | "community" | "own";

/** What this person is looking at: the whole platform's requests (operations), their community's, or only their own. */
function audienceOf(s: TenantState): Audience {
  if (s.platformScope) {
    if (s.permissions.has("requests.read_all")) return "all";
    throw forbidden();
  }
  if (s.permissions.has("requests.read_community")) return "community";
  if (s.permissions.has("requests.read_own")) return "own";
  throw forbidden();
}

/** The operations clock only runs while the request waits on operations; the resident's wait is not an ops breach. */
const SLA_STATE = `
  CASE WHEN ws.waiting_on <> 'operations' OR r.sla_due_at IS NULL THEN NULL
       WHEN r.sla_due_at < now() THEN 'overdue'
       WHEN r.sla_due_at < now() + interval '4 hours' THEN 'due_soon'
       ELSE 'on_track' END`;

const LIST_FROM = `
  FROM requests r
  JOIN workflow_statuses ws ON ws.key = r.status
  JOIN organizations o ON o.id = r.tenant_id
  JOIN request_types rt ON rt.id = r.request_type_id
  LEFT JOIN categories cat ON cat.id = r.category_id
  LEFT JOIN users u ON u.id = r.requester_id
  LEFT JOIN users au ON au.id = r.assigned_to`;

interface ListRow {
  id: string;
  request_number: string;
  title: string;
  status: string;
  status_label: string;
  waiting_on: string;
  is_terminal: boolean;
  created_at: Date;
  status_changed_at: Date;
  sla_due_at: Date | null;
  sla_state: string | null;
  assigned_to: string | null;
  assigned_name: string | null;
  tenant_id: string;
  community_name: string;
  type_name: string;
  category_name: string | null;
  requester_id: string;
  requester_name: string | null;
  cursor_t: string;
}

const LIST_COLUMNS = `r.id, r.request_number::text AS request_number, r.title, r.status, ws.label AS status_label, ws.waiting_on, ws.is_terminal,
  r.created_at, r.status_changed_at, r.sla_due_at, ${SLA_STATE} AS sla_state, r.assigned_to, au.display_name AS assigned_name,
  r.tenant_id, o.name AS community_name, rt.name AS type_name, cat.name AS category_name, r.requester_id, u.display_name AS requester_name`;

function toListItem(r: ListRow, audience: Audience, me: string) {
  return {
    id: r.id,
    number: Number(r.request_number),
    title: r.title,
    status: r.status,
    statusLabel: r.status_label,
    waitingOn: r.waiting_on,
    terminal: r.is_terminal,
    type: r.type_name,
    category: r.category_name,
    community: { id: r.tenant_id, name: r.community_name },
    createdAt: r.created_at.toISOString(),
    updatedAt: r.status_changed_at.toISOString(),
    mine: r.requester_id === me,
    // who asked is for the people who run things; a resident only ever sees their own
    ...(audience !== "own" ? { requester: { name: r.requester_name } } : {}),
    // the operations clock and ownership are internal
    ...(audience === "all" ? { slaDueAt: r.sla_due_at?.toISOString() ?? null, slaState: r.sla_state, assignedTo: r.assigned_to ? { id: r.assigned_to, name: r.assigned_name } : null } : {}),
  };
}

export async function requestRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool } = deps;

  /** Emails for the status changes a family would otherwise only notice by opening the app. Minimal: no details, just a link. */
  async function statusEmails(c: PoolClient, outbox: Outbox, requesterId: string, id: string, to: string): Promise<void> {
    const path = `/app/requests/${id}`;
    const config = deps.config;
    const requester = async () => userEmail(c, requesterId);
    if (to === "information_required") outbox.event(config, [await requester()], "The team has a question for you", "The team needs a little more information to go ahead with your request.", path);
    else if (to === "approved") outbox.event(config, [await requester()], "Your request was approved", "Your request has been approved and the team is starting to find options.", path);
    else if (to === "rejected" || to === "closed") outbox.event(config, [await requester()], "An update on your request", "There is an update on your request.", path);
    else if (to === "shortlisted") outbox.event(config, [await requester()], "Your options are ready", "The team has chosen some options for you to look at.", path);
    else if (to === "completed") outbox.event(config, [await requester()], "How did it go?", "Your booking is complete. You can now leave a review.", path);
    else if (to === "confirmed") {
      outbox.event(config, [await requester()], "Your booking is confirmed", "Your booking has been confirmed.", path);
      const b = (await c.query<{ vendor_id: string }>("SELECT vendor_id FROM bookings WHERE request_id = $1 AND status = 'confirmed'", [id])).rows[0];
      if (b) outbox.event(config, await vendorTeamEmails(c, b.vendor_id, "inquiries.respond"), "A booking is confirmed", "A booking you quoted for has been confirmed.", "/app/inquiries");
    }
  }
  const requirePermission = makeRequirePermission(deps);
  const requireAny = makeRequireAnyPermission(deps);

  const state = (req: { tenantState?: TenantState }): TenantState => {
    if (!req.tenantState) throw new AppError(400, "tenant_required", "Select a community first.");
    return req.tenantState;
  };

  /** Translates the workflow trigger's refusals into the API's error vocabulary. */
  function mapWorkflowError(err: unknown): never {
    const code = (err as { code?: string }).code;
    if (code === "42501") throw forbidden();
    if (code === "23514") {
      const message = (err as { message?: string }).message ?? "";
      if (/note is required/u.test(message)) throw new AppError(400, "note_required", "Add a note explaining this step.");
      if (/operations team/u.test(message)) throw new AppError(400, "invalid_assignee", "A request can only be assigned to a member of the operations team.");
    }
    throw err;
  }

  /* ----------------------------------------------------------------- types */

  app.get("/request-types", { preHandler: requirePermission("requests.create_own") }, async (req) => {
    const s = state(req);
    const rows = await withContext(pool, dbContext(s), async (c) =>
      (await c.query<{ id: string; key: string; name: string; description: string; form_schema: FormSchema; schema_version: number }>(
        "SELECT id, key, name, description, form_schema, schema_version FROM request_types WHERE is_active ORDER BY sort_order",
      )).rows,
    );
    return { data: rows.map((r) => ({ id: r.id, key: r.key, name: r.name, description: r.description, fields: r.form_schema.fields, schemaVersion: r.schema_version })) };
  });

  /* ---------------------------------------------------------------- create */

  app.post("/requests", { preHandler: requirePermission("requests.create_own") }, async (req, reply) => {
    const s = state(req);
    if (s.platformScope) throw new AppError(403, "community_required", "Requests are made from inside a community.");
    const body = createSchema.parse(req.body);
    const outbox = new Outbox(deps, req.log);
    const id = await withContext(pool, dbContext(s), async (c) => {
      const type = (await c.query<{ id: string; form_schema: FormSchema; schema_version: number }>("SELECT id, form_schema, schema_version FROM request_types WHERE id = $1 AND is_active", [body.requestTypeId])).rows[0];
      if (!type) throw new AppError(400, "validation_failed", "Choose what you need from the list.", [{ field: "requestTypeId", message: "Choose an available option." }]);
      const answers = validateAnswers(type.form_schema, body.answers);
      if (body.categoryId) {
        const cat = await c.query("SELECT 1 FROM categories WHERE id = $1 AND is_active AND parent_id IS NOT NULL", [body.categoryId]);
        if (!cat.rowCount) throw new AppError(400, "validation_failed", "Choose a category from the list.", [{ field: "categoryId", message: "Choose an available category." }]);
      }
      if (body.offeringId) {
        // Visible only if the catalog would show it to this person (their community approved the vendor, and so on).
        const offering = await c.query("SELECT 1 FROM offerings WHERE id = $1 AND status = 'published'", [body.offeringId]);
        if (!offering.rowCount) throw new AppError(400, "validation_failed", "That offering is not available to your community.", [{ field: "offeringId", message: "Choose an offering from the catalog." }]);
      }
      if (body.preferredDate) {
        const ok = await c.query<{ ok: boolean }>("SELECT $1::date >= current_date AS ok", [body.preferredDate]);
        if (!ok.rows[0]?.ok) throw new AppError(400, "validation_failed", "The preferred date has already passed.", [{ field: "preferredDate", message: "Choose today or a later date." }]);
      }
      const open = await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM requests r JOIN workflow_statuses ws ON ws.key = r.status WHERE r.requester_id = $1 AND r.tenant_id = $2 AND NOT ws.is_terminal",
        [s.userId, s.tenantId],
      );
      if ((open.rows[0]?.n ?? 0) >= MAX_OPEN_PER_PERSON) {
        throw new AppError(422, "limit_reached", `You already have ${MAX_OPEN_PER_PERSON} open requests. Wait for some to finish or cancel one you no longer need.`);
      }
      let created: { id: string } | undefined;
      try {
        created = (
          await c.query<{ id: string }>(
            `INSERT INTO requests (tenant_id, requester_id, request_type_id, schema_version, title, description, category_id, offering_id, preferred_date, flexible_dates,
                                   participant_count, age_min, age_max, budget_max_minor, venue_text, answers)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
            [
              s.tenantId, s.userId, type.id, type.schema_version, body.title, body.description ?? null, body.categoryId ?? null, body.offeringId ?? null, body.preferredDate ?? null,
              body.flexibleDates ?? false, body.participantCount ?? null, body.ageMin ?? null, body.ageMax ?? null, body.budgetMaxMinor ?? null, body.venueText ?? null, JSON.stringify(answers),
            ],
          )
        ).rows[0];
      } catch (err) {
        // the row policy refuses people who are not active members of an active community
        if ((err as { code?: string }).code === "42501") throw new AppError(403, "not_a_member", "You can make requests once you are an active member of this community.");
        throw err;
      }
      if (!created) throw new Error("request insert returned no row");
      await writeAudit(c, { tenantId: s.tenantId, actorUserId: s.userId, action: "request.created", entityType: "request", entityId: created.id, requestId: req.id });
      outbox.event(deps.config, [deps.config.opsAlertEmail], "A new request", "A family has made a new request.", `/app/requests/${created.id}`);
      return created.id;
    });
    await outbox.flush();
    return reply.code(201).send(await loadDetail(s, id));
  });

  /* ------------------------------------------------------------------ list */

  app.get("/requests", { preHandler: requireAny("requests.read_own", "requests.read_community", "requests.read_all") }, async (req) => {
    const s = state(req);
    const audience = audienceOf(s);
    const q = listQuery.parse(req.query);
    const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
    const rows = await withContext(pool, dbContext(s), async (c) => {
      const params: unknown[] = [q.limit + 1];
      const where: string[] = [];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replace("?", `$${params.length}`));
      };
      if (audience === "own" || q.mine === "true") add("r.requester_id = ?", s.userId);
      if (audience === "community") add("r.tenant_id = ?", s.tenantId);
      if (q.communityId && audience === "all") add("r.tenant_id = ?", q.communityId);
      if (q.status) add("r.status = ?", q.status);
      if (q.open === "true") where.push("NOT ws.is_terminal");
      if (q.open === "false") where.push("ws.is_terminal");
      if (audience === "all") {
        if (q.sla === "overdue") where.push("ws.waiting_on = 'operations' AND r.sla_due_at < now()");
        if (q.sla === "due_soon") where.push("ws.waiting_on = 'operations' AND r.sla_due_at >= now() AND r.sla_due_at < now() + interval '4 hours'");
        if (q.assigned === "me") add("r.assigned_to = ?", s.userId);
        if (q.assigned === "unassigned") where.push("r.assigned_to IS NULL AND NOT ws.is_terminal");
      }
      if (q.q) {
        params.push(likePattern(q.q));
        where.push(`(r.title ILIKE $${params.length} ESCAPE '\\' OR r.request_number::text = ltrim(replace($${params.length}, '%', ''), '#'))`);
      }
      if (cursor) {
        params.push(cursor.t, cursor.i);
        where.push(`(r.created_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      }
      const res = await c.query<ListRow>(
        `SELECT ${LIST_COLUMNS}, ${cursorTimestamp("r.created_at")} AS cursor_t ${LIST_FROM}
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY r.created_at DESC, r.id DESC LIMIT $1`,
        params,
      );
      return res.rows;
    });
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const last = page[page.length - 1];
    return { data: page.map((r) => toListItem(r, audience, s.userId)), page: { hasMore, nextCursor: hasMore && last ? encodeCursor(last.cursor_t, last.id) : null } };
  });

  /** Operations at a glance: how much is open, what is overdue, what nobody owns. */
  app.get("/requests/summary", { preHandler: requirePermission("requests.read_all") }, async (req) => {
    const s = state(req);
    if (!s.platformScope) throw new AppError(403, "platform_scope_required", "The request queue is for the operations team.");
    return withContext(pool, dbContext(s), async (c) => {
      const totals = (
        await c.query<{ open: number; overdue: number; due_soon: number; unassigned: number; mine: number; waiting_on_resident: number }>(
          `SELECT count(*) FILTER (WHERE NOT ws.is_terminal)::int AS open,
                  count(*) FILTER (WHERE ws.waiting_on = 'operations' AND r.sla_due_at < now())::int AS overdue,
                  count(*) FILTER (WHERE ws.waiting_on = 'operations' AND r.sla_due_at >= now() AND r.sla_due_at < now() + interval '4 hours')::int AS due_soon,
                  count(*) FILTER (WHERE NOT ws.is_terminal AND r.assigned_to IS NULL)::int AS unassigned,
                  count(*) FILTER (WHERE NOT ws.is_terminal AND r.assigned_to = $1)::int AS mine,
                  count(*) FILTER (WHERE ws.waiting_on = 'resident')::int AS waiting_on_resident
             FROM requests r JOIN workflow_statuses ws ON ws.key = r.status`,
          [s.userId],
        )
      ).rows[0];
      const byStatus = (
        await c.query<{ status: string; label: string; n: number }>(
          `SELECT ws.key AS status, ws.label, count(r.status)::int AS n FROM workflow_statuses ws LEFT JOIN requests r ON r.status = ws.key
            WHERE NOT ws.is_terminal GROUP BY ws.key, ws.label, ws.sort_order HAVING count(r.status) > 0 ORDER BY ws.sort_order`,
        )
      ).rows;
      return {
        open: totals?.open ?? 0,
        overdue: totals?.overdue ?? 0,
        dueSoon: totals?.due_soon ?? 0,
        unassigned: totals?.unassigned ?? 0,
        mine: totals?.mine ?? 0,
        waitingOnResident: totals?.waiting_on_resident ?? 0,
        byStatus: byStatus.map((r) => ({ status: r.status, label: r.label, count: r.n })),
      };
    });
  });

  /* ---------------------------------------------------------------- detail */

  async function loadDetail(s: TenantState, id: string) {
    const audience = audienceOf(s);
    return withContext(pool, dbContext(s), async (c) => {
      const res = await c.query<
        ListRow & {
          description: string | null;
          answers: Record<string, unknown>;
          schema_version: number;
          form_schema: FormSchema;
          type_key: string;
          preferred_date: string | null;
          flexible_dates: boolean;
          participant_count: number | null;
          age_min: number | null;
          age_max: number | null;
          budget_max_minor: string | null;
          venue_text: string | null;
          offering_id: string | null;
          offering_name: string | null;
          offering_vendor: string | null;
        }
      >(
        `SELECT ${LIST_COLUMNS}, r.description, r.answers, r.schema_version, rt.form_schema, rt.key AS type_key, r.preferred_date::text AS preferred_date, r.flexible_dates,
                r.participant_count, r.age_min, r.age_max, r.budget_max_minor::text AS budget_max_minor, r.venue_text,
                r.offering_id, off.name AS offering_name, ov.name AS offering_vendor, ''::text AS cursor_t
           ${LIST_FROM}
           LEFT JOIN offerings off ON off.id = r.offering_id
           LEFT JOIN organizations ov ON ov.id = off.tenant_id
          WHERE r.id = $1`,
        [id],
      );
      const r = res.rows[0];
      if (!r) throw new AppError(404, "not_found", "Request not found.");
      if (audience === "own" && r.requester_id !== s.userId) throw new AppError(404, "not_found", "Request not found.");

      const history = await c.query<{ from_label: string | null; to_status: string; to_label: string; note: string | null; changed_by: string | null; changed_name: string | null; created_at: Date }>(
        `SELECT fs.label AS from_label, h.to_status, ts.label AS to_label, h.note, h.changed_by, u.display_name AS changed_name, h.created_at
           FROM request_status_history h
           LEFT JOIN workflow_statuses fs ON fs.key = h.from_status JOIN workflow_statuses ts ON ts.key = h.to_status LEFT JOIN users u ON u.id = h.changed_by
          WHERE h.request_id = $1 ORDER BY h.created_at, h.id`,
        [id],
      );
      const comments = await c.query<{ id: string; visibility: string; body: string; author_id: string; author_name: string | null; created_at: Date }>(
        `SELECT c.id, c.visibility, c.body, c.author_id, u.display_name AS author_name, c.created_at
           FROM request_comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.request_id = $1 ORDER BY c.created_at, c.id`,
        [id],
      );
      const isRequester = r.requester_id === s.userId;
      const isStaff = audience === "all";
      const options = await c.query<{ to_status: string; to_label: string; actor: string; permission: string; note_required: boolean; label: string }>(
        `SELECT t.to_status, ts.label AS to_label, t.actor, t.permission, t.note_required, t.label
           FROM workflow_transitions t JOIN workflow_statuses ts ON ts.key = t.to_status WHERE t.from_status = $1 ORDER BY ts.sort_order, t.actor`,
        [r.status],
      );
      const transitions = options.rows
        .filter((t) => (t.actor === "staff" ? isStaff && s.permissions.has(t.permission) : isRequester && !isStaff && s.permissions.has(t.permission)))
        // one entry per target even if both the staff and requester forms apply
        .filter((t, i, all) => all.findIndex((x) => x.to_status === t.to_status) === i)
        .map((t) => ({ to: t.to_status, toLabel: t.to_label, label: t.label, noteRequired: t.note_required, noteVisibleToResident: true }));

      // A family sees the options operations offered them, and their booking. Nobody else gets these here.
      const family = isRequester && !isStaff;
      const familyOptions = family ? await loadQuotes(c, "q.request_id = $1", [id]) : [];
      const familyBooking0 = family ? ((await loadBookings(c, "b.request_id = $1", [id], "family")).find((b) => b.status !== "cancelled") ?? null) : null;

      const fields = r.form_schema.fields;
      return {
        ...toListItem(r, audience, s.userId),
        description: r.description,
        typeKey: r.type_key,
        schemaVersion: r.schema_version,
        preferredDate: r.preferred_date,
        flexibleDates: r.flexible_dates,
        participantCount: r.participant_count,
        ageMin: r.age_min,
        ageMax: r.age_max,
        budgetMaxMinor: r.budget_max_minor === null ? null : Number(r.budget_max_minor),
        venueText: r.venue_text,
        offering: r.offering_id && r.offering_name ? { id: r.offering_id, name: r.offering_name, vendor: r.offering_vendor } : null,
        // answers come with their labels, so a screen (or an export) never has to guess what a key meant
        answers: fields
          .filter((f) => r.answers[f.key] !== undefined)
          .map((f) => {
            const value = r.answers[f.key];
            const label = (v: unknown) => f.options?.find((o) => o.value === v)?.label ?? String(v);
            return { key: f.key, label: f.label, value: Array.isArray(value) ? value.map(label).join(", ") : typeof value === "boolean" ? (value ? "Yes" : "No") : f.options ? label(value) : String(value) };
          }),
        history: history.rows.map((h) => ({
          from: h.from_label,
          to: h.to_label,
          toStatus: h.to_status,
          note: h.note,
          byRequester: h.changed_by === r.requester_id,
          // staff names are for the team; the family sees "the team"
          ...(isStaff || audience === "community" ? { by: h.changed_name } : {}),
          at: h.created_at.toISOString(),
        })),
        comments: comments.rows.map((m) => ({
          id: m.id,
          visibility: m.visibility,
          body: m.body,
          byRequester: m.author_id === r.requester_id,
          ...(isStaff || audience === "community" ? { by: m.author_name } : {}),
          at: m.created_at.toISOString(),
        })),
        transitions,
        options: familyOptions,
        booking: familyBooking0,
        review: familyBooking0 ? await loadReview(c, familyBooking0.id) : null,
        can: {
          comment: !r.is_terminal && ((isStaff && s.permissions.has("requests.comment_public")) || (isRequester && !isStaff && s.permissions.has("requests.comment_public"))),
          commentInternal: isStaff && s.permissions.has("requests.comment_internal"),
          assign: isStaff && s.permissions.has("requests.assign"),
        },
      };
    });
  }

  app.get("/requests/:id", { preHandler: requireAny("requests.read_own", "requests.read_community", "requests.read_all") }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return loadDetail(state(req), id);
  });

  /* ----------------------------------------------------------- transitions */

  app.post("/requests/:id/transitions", { preHandler: requireAny("requests.transition", "requests.cancel_own", "requests.comment_public") }, async (req) => {
    const s = state(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = transitionSchema.parse(req.body);
    const outbox = new Outbox(deps, req.log);
    await withContext(pool, dbContext(s), async (c) => {
      const cur = (await c.query<{ status: string; requester_id: string; tenant_id: string }>("SELECT status, requester_id, tenant_id FROM requests WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!cur) throw new AppError(404, "not_found", "Request not found.");
      const steps = (
        await c.query<{ actor: string; permission: string; note_required: boolean }>("SELECT actor, permission, note_required FROM workflow_transitions WHERE from_status = $1 AND to_status = $2", [cur.status, body.to])
      ).rows;
      if (steps.length === 0) throw new AppError(409, "invalid_transition", "That step is not available for this request right now.");
      // Choosing a quote also accepts it and opens the booking, so it has its own endpoint and cannot be taken as a bare status change.
      if (body.to === "booking_pending" && cur.status === "shortlisted") throw new AppError(409, "use_accept", "Choose one of the offered options instead.");
      const isStaff = s.platformScope;
      const allowed = steps.find((t) => (t.actor === "staff" ? isStaff && s.permissions.has(t.permission) : cur.requester_id === s.userId && !isStaff && s.permissions.has(t.permission)));
      if (!allowed) throw forbidden();
      if (allowed.note_required && !body.note?.trim()) throw new AppError(400, "note_required", "Add a note explaining this step. The family will see it.");
      try {
        await c.query("SELECT set_config('app.note', $1, true)", [body.note?.trim() ?? ""]);
        // inquiries, quotes and bookings move with the request (and a step may be refused until its preconditions hold)
        await prepareTransition(c, { requestId: id, from: cur.status, to: body.to, note: body.note?.trim(), isStaff });
        const res = await c.query("UPDATE requests SET status = $2 WHERE id = $1", [id, body.to]);
        if (!res.rowCount) throw new AppError(404, "not_found", "Request not found.");
      } catch (err) {
        return mapWorkflowError(err);
      }
      await writeAudit(c, { tenantId: cur.tenant_id, actorUserId: s.userId, action: "request.status_changed", entityType: "request", entityId: id, metadata: { from: cur.status, to: body.to }, requestId: req.id });
      if (isStaff) await statusEmails(c, outbox, cur.requester_id, id, body.to);
    });
    await outbox.flush();
    return loadDetail(s, id);
  });

  /* -------------------------------------------------------------- comments */

  app.post("/requests/:id/comments", { preHandler: requireAny("requests.comment_public", "requests.comment_internal") }, async (req, reply) => {
    const s = state(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = commentSchema.parse(req.body);
    const outbox = new Outbox(deps, req.log);
    await withContext(pool, dbContext(s), async (c) => {
      const cur = (
        await c.query<{ status: string; requester_id: string; tenant_id: string; is_terminal: boolean }>(
          "SELECT r.status, r.requester_id, r.tenant_id, ws.is_terminal FROM requests r JOIN workflow_statuses ws ON ws.key = r.status WHERE r.id = $1 FOR UPDATE OF r",
          [id],
        )
      ).rows[0];
      if (!cur) throw new AppError(404, "not_found", "Request not found.");
      const staff = s.platformScope;
      const requester = cur.requester_id === s.userId && !staff;
      if (!staff && !requester) throw forbidden(); // a community's readers read; they do not write
      if (body.visibility === "internal") {
        if (!staff || !s.permissions.has("requests.comment_internal")) throw forbidden();
      } else if (!s.permissions.has("requests.comment_public")) {
        throw forbidden();
      }
      if (cur.is_terminal) throw new AppError(409, "request_closed", "This request is finished, so it cannot take new messages.");
      const n = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM request_comments WHERE request_id = $1", [id]);
      if ((n.rows[0]?.n ?? 0) >= MAX_COMMENTS_PER_REQUEST) throw new AppError(422, "limit_reached", "This request has reached its limit of messages.");
      try {
        await c.query("INSERT INTO request_comments (tenant_id, request_id, author_id, visibility, body) VALUES ($1, $2, $3, $4, $5)", [cur.tenant_id, id, s.userId, body.visibility, body.body]);
        // A reply to a question sends the request back to the team's queue in the same step.
        if (body.returnToReview && requester && cur.status === "information_required") {
          await c.query("SELECT set_config('app.note', '', true)");
          await c.query("UPDATE requests SET status = 'under_review' WHERE id = $1", [id]);
          await writeAudit(c, { tenantId: cur.tenant_id, actorUserId: s.userId, action: "request.status_changed", entityType: "request", entityId: id, metadata: { from: cur.status, to: "under_review" }, requestId: req.id });
        }
      } catch (err) {
        return mapWorkflowError(err);
      }
      await writeAudit(c, { tenantId: cur.tenant_id, actorUserId: s.userId, action: "request.commented", entityType: "request", entityId: id, metadata: { visibility: body.visibility }, requestId: req.id });
      if (body.visibility === "resident") {
        if (staff) outbox.event(deps.config, [await userEmail(c, cur.requester_id)], "A new message", "The team has sent you a message about your request.", `/app/requests/${id}`);
        else outbox.event(deps.config, [deps.config.opsAlertEmail], "A family replied", "A family has written on their request.", `/app/requests/${id}`);
      }
    });
    await outbox.flush();
    return reply.code(201).send(await loadDetail(s, id));
  });

  /* ------------------------------------------------------------- ownership */

  app.put("/requests/:id/assignee", { preHandler: requirePermission("requests.assign") }, async (req) => {
    const s = state(req);
    if (!s.platformScope) throw new AppError(403, "platform_scope_required", "Requests are assigned by the operations team.");
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { userId } = assigneeSchema.parse(req.body);
    await withContext(pool, dbContext(s), async (c: PoolClient) => {
      try {
        const res = await c.query<{ tenant_id: string }>("UPDATE requests SET assigned_to = $2 WHERE id = $1 RETURNING tenant_id", [id, userId]);
        if (!res.rows[0]) throw new AppError(404, "not_found", "Request not found.");
        await writeAudit(c, { tenantId: res.rows[0].tenant_id, actorUserId: s.userId, action: "request.assigned", entityType: "request", entityId: id, metadata: { assignedTo: userId }, requestId: req.id });
      } catch (err) {
        return mapWorkflowError(err);
      }
    });
    return loadDetail(s, id);
  });
}
