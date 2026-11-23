import type { FastifyInstance } from "fastify";
import { withContext } from "@kidos/db";
import { z } from "zod";
import { AppError } from "../errors";
import { dbContext, makeRequirePermission } from "../guards";
import { cursorTimestamp, decodeCursor, encodeCursor, pageParams } from "../pagination";
import type { Deps } from "../types";

/** Areas of the audit trail, by the first word of the action ("community.updated" belongs to "community"). */
export const AUDIT_AREAS = {
  security: ["auth", "authz"],
  community: ["community", "category"],
  members: ["membership", "family", "tenant"],
  vendors: ["vendor", "offering"],
  requests: ["request", "inquiry", "quote", "booking", "payment", "review"],
  concerns: ["concern"],
} as const;
type AuditArea = keyof typeof AUDIT_AREAS;
const querySchema = z
  .object({
    ...pageParams,
    area: z.enum(Object.keys(AUDIT_AREAS) as [AuditArea, ...AuditArea[]]).optional(),
    days: z.coerce
      .number()
      .int()
      .refine((d) => [1, 7, 30, 90].includes(d), "Choose 1, 7, 30 or 90 days.")
      .optional(),
  })
  .strict();

export async function adminRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const requirePermission = makeRequirePermission(deps);

  /** Audit trail for the active tenant (or every tenant in platform scope). Newest first, keyset-paginated. */
  app.get("/admin/audit", { preHandler: requirePermission("audit.read") }, async (req) => {
    const q = querySchema.parse(req.query);
    const state = req.tenantState;
    if (!state) throw new AppError(400, "tenant_required", "Select an organization first.");
    const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;

    const rows = await withContext(
      deps.pool,
      dbContext(state),
      async (c) => {
        const params: unknown[] = [q.limit + 1];
        const conditions: string[] = [];
        if (cursor) {
          params.push(cursor.t, cursor.i);
          conditions.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
        }
        // Filters narrow what row-level security already allows; they never widen it.
        if (q.area) {
          params.push([...AUDIT_AREAS[q.area]]);
          conditions.push(`split_part(action, '.', 1) = ANY($${params.length}::text[])`);
        }
        if (q.days) {
          params.push(q.days);
          conditions.push(`created_at > now() - ($${params.length}::int * interval '1 day')`);
        }
        const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
        const res = await c.query<{
          id: string;
          tenant_id: string | null;
          actor_user_id: string | null;
          action: string;
          entity_type: string | null;
          entity_id: string | null;
          created_at: Date;
          cursor_t: string;
        }>(
          `SELECT id, tenant_id, actor_user_id, action, entity_type, entity_id, created_at,
                  ${cursorTimestamp("created_at")} AS cursor_t
             FROM audit_log ${where}
            ORDER BY created_at DESC, id DESC
            LIMIT $1`,
          params,
        );
        return res.rows;
      },
    );

    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const last = page[page.length - 1];
    return {
      data: page.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        actorUserId: r.actor_user_id,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        createdAt: r.created_at.toISOString(),
      })),
      page: { hasMore, nextCursor: hasMore && last ? encodeCursor(last.cursor_t, last.id) : null },
    };
  });
}
