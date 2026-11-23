import type { FastifyInstance } from "fastify";
import { withContext } from "@kidos/db";
import { AppError } from "../errors";
import { dbContext, makeAuthenticate, resolveTenantState } from "../guards";
import type { Deps, TenantState } from "../types";

export interface AttentionItem {
  key: string;
  label: string;
  count: number;
  href: string;
}

/**
 * "Needs your attention": what is waiting for THIS person, in the organization they are acting in. Derived from the
 * current state (never stored), so it cannot go stale, and every query runs under row-level security, so a person can
 * only be told about things they could open. It is the in-app companion to the emails.
 */
export async function attentionRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool } = deps;
  const authenticate = makeAuthenticate(deps);

  app.get("/me/attention", { preHandler: authenticate }, async (req) => {
    if (!req.auth) throw new AppError(401, "unauthenticated", "Authentication is required.");
    // Without an organization there is nothing role-specific to report.
    const s: TenantState | undefined = await resolveTenantState(req, deps);
    if (!s) return { items: [] as AttentionItem[] };
    const items: AttentionItem[] = [];
    await withContext(pool, dbContext(s), async (c) => {
      const n = async (sql: string, params: unknown[] = []) => (await c.query<{ n: number }>(sql, params)).rows[0]?.n ?? 0;
      const add = (key: string, label: (n: number) => string, count: number, href: string) => {
        if (count > 0) items.push({ key, label: label(count), count, href });
      };

      if (s.platformScope) {
        if (s.permissions.has("requests.read_all")) {
          add("overdue", (x) => `${x} ${x === 1 ? "request is" : "requests are"} past ${x === 1 ? "its" : "their"} target`, await n("SELECT count(*)::int AS n FROM requests r JOIN workflow_statuses ws ON ws.key = r.status WHERE ws.waiting_on = 'operations' AND r.sla_due_at < now()"), "/app/requests");
          add("unassigned", (x) => `${x} open ${x === 1 ? "request has" : "requests have"} no owner`, await n("SELECT count(*)::int AS n FROM requests r JOIN workflow_statuses ws ON ws.key = r.status WHERE NOT ws.is_terminal AND r.assigned_to IS NULL"), "/app/requests");
        }
        if (s.permissions.has("bookings.confirm")) {
          add("bookings_ready", (x) => `${x} ${x === 1 ? "booking is" : "bookings are"} ready for you to confirm`, await n("SELECT count(*)::int AS n FROM bookings WHERE status = 'pending_vendor' AND vendor_confirmed_at IS NOT NULL"), "/app/requests");
        }
        if (s.permissions.has("payments.record")) {
          add("unpaid", (x) => `${x} ${x === 1 ? "booking has" : "bookings have"} no full payment recorded`, await n("SELECT count(*)::int AS n FROM bookings b WHERE b.status IN ('confirmed', 'completed') AND COALESCE((SELECT sum(p.amount_minor) FROM booking_payments p WHERE p.booking_id = b.id AND p.kind = 'family_to_vendor'), 0) < b.agreed_total_minor"), "/app/requests");
        }
        if (s.permissions.has("reviews.moderate")) {
          add("reviews", (x) => `${x} ${x === 1 ? "review needs" : "reviews need"} checking`, await n("SELECT count(*)::int AS n FROM reviews WHERE status = 'pending'"), "/app/reviews");
        }
        if (s.permissions.has("concerns.manage")) {
          add("safety_concerns", (x) => `${x} child-safety ${x === 1 ? "report needs" : "reports need"} a decision`, await n("SELECT count(*)::int AS n FROM concerns WHERE category = 'child_safety' AND status IN ('open', 'reviewing')"), "/app/concerns");
          add("concerns", (x) => `${x} other ${x === 1 ? "report needs" : "reports need"} a decision`, await n("SELECT count(*)::int AS n FROM concerns WHERE category <> 'child_safety' AND status IN ('open', 'reviewing')"), "/app/concerns");
        }
        if (s.permissions.has("vendors.read")) {
          add("vetting", (x) => `${x} active ${x === 1 ? "vendor has" : "vendors have"} lapsed documents`, await n("SELECT count(*)::int AS n FROM organizations o LEFT JOIN vendor_vetting_summary vs ON vs.tenant_id = o.id WHERE o.type = 'vendor' AND o.status = 'active' AND (vs.tenant_id IS NULL OR NOT vs.complete OR (vs.valid_until IS NOT NULL AND vs.valid_until < current_date))"), "/app/vendors");
        }
        return;
      }

      if (s.permissions.has("inquiries.respond")) {
        add("inquiries", (x) => `${x} ${x === 1 ? "request needs" : "requests need"} your quote`, await n("SELECT count(*)::int AS n FROM inquiries i LEFT JOIN request_stage_flags f ON f.request_id = i.request_id WHERE i.status = 'sent' AND NOT COALESCE(f.closed, false)"), "/app/inquiries");
        add("confirm_date", (x) => `${x} ${x === 1 ? "booking needs" : "bookings need"} you to confirm a date`, await n("SELECT count(*)::int AS n FROM bookings WHERE status = 'pending_vendor' AND scheduled_start IS NOT NULL AND vendor_confirmed_at IS NULL"), "/app/inquiries");
        if (s.permissions.has("reviews.reply")) {
          add("reply_review", (x) => `${x} ${x === 1 ? "review is" : "reviews are"} waiting for your reply`, await n("SELECT count(*)::int AS n FROM reviews WHERE vendor_id = $1 AND status = 'published' AND vendor_reply IS NULL", [s.tenantId]), "/app/reviews");
        }
      }

      if (s.permissions.has("requests.read_own")) {
        const waiting = await c.query<{ id: string; title: string; label: string }>(
          "SELECT r.id, r.title, ws.label FROM requests r JOIN workflow_statuses ws ON ws.key = r.status WHERE r.requester_id = $1 AND ws.waiting_on = 'resident' AND NOT ws.is_terminal ORDER BY r.status_changed_at DESC LIMIT 5",
          [s.userId],
        );
        for (const r of waiting.rows) items.push({ key: `reply:${r.id}`, label: `${r.title}: ${r.label}`, count: 1, href: `/app/requests/${r.id}` });
        const toReview = await c.query<{ id: string; title: string }>(
          "SELECT r.id, r.title FROM bookings b JOIN requests r ON r.id = b.request_id LEFT JOIN reviews rv ON rv.booking_id = b.id WHERE b.status = 'completed' AND rv.id IS NULL AND r.requester_id = $1 ORDER BY b.completed_at DESC LIMIT 5",
          [s.userId],
        );
        for (const r of toReview.rows) items.push({ key: `review:${r.id}`, label: `Tell us how it went: ${r.title}`, count: 1, href: `/app/requests/${r.id}` });
      }
    });
    return { items };
  });
}
