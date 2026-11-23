import type { FastifyInstance } from "fastify";
import { withContext } from "@kidos/db";
import { z } from "zod";
import { writeAudit } from "../audit";
import { AppError } from "../errors";
import { dbContext, makeAuthenticate, makeRequirePermission } from "../guards";
import type { Deps } from "../types";

interface CategoryRow {
  id: string;
  parent_id: string | null;
  key: string;
  name: string;
  description: string | null;
  sort_order: number;
  is_active: boolean;
}
const toCategory = (r: CategoryRow) => ({ id: r.id, parentId: r.parent_id, key: r.key, name: r.name, description: r.description, sortOrder: r.sort_order, isActive: r.is_active });

const createBody = z
  .object({
    parentId: z.uuid().nullable().optional(),
    key: z.string().regex(/^[a-z_]+$/u, "Use lower-case letters and underscores.").min(2).max(40),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).nullable().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();
const patchBody = z
  .object({
    parentId: z.uuid().nullable().optional(),
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to change.");

export async function categoryRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool } = deps;
  const authenticate = makeAuthenticate(deps);
  const requirePermission = makeRequirePermission(deps);

  /** The whole (small) category tree, flat, for filters and forms. Any signed-in user may read it. */
  app.get("/categories", { preHandler: authenticate }, async (req) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "unauthenticated", "Authentication is required.");
    const rows = await withContext(pool, { userId: auth.userId }, async (c) =>
      (await c.query<CategoryRow>("SELECT id, parent_id, key, name, description, sort_order, is_active FROM categories ORDER BY sort_order, name")).rows,
    );
    return { data: rows.map(toCategory) };
  });

  app.post("/categories", { preHandler: requirePermission("categories.manage") }, async (req, reply) => {
    const s = req.tenantState;
    if (!s?.platformScope) throw new AppError(403, "platform_scope_required", "Categories are managed by the platform team.");
    const body = createBody.parse(req.body);
    const row = await withContext(pool, dbContext(s), async (c) => {
      try {
        const res = await c.query<CategoryRow>(
          `INSERT INTO categories (parent_id, key, name, description, sort_order) VALUES ($1, $2, $3, $4, $5)
           RETURNING id, parent_id, key, name, description, sort_order, is_active`,
          [body.parentId ?? null, body.key, body.name, body.description ?? null, body.sortOrder ?? 0],
        );
        const created = res.rows[0];
        if (!created) throw new Error("category insert returned no row");
        await writeAudit(c, { actorUserId: s.userId, action: "category.created", entityType: "category", entityId: created.id, requestId: req.id });
        return created;
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new AppError(409, "category_exists", "A category with that key already exists.");
        if ((err as { code?: string }).code === "23503") throw new AppError(400, "validation_failed", "The parent category does not exist.", [{ field: "parentId", message: "Choose an existing category." }]);
        throw err;
      }
    });
    return reply.code(201).send(toCategory(row));
  });

  app.patch("/categories/:id", { preHandler: requirePermission("categories.manage") }, async (req) => {
    const s = req.tenantState;
    if (!s?.platformScope) throw new AppError(403, "platform_scope_required", "Categories are managed by the platform team.");
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = patchBody.parse(req.body);
    if (body.parentId === id) throw new AppError(400, "validation_failed", "A category cannot be its own parent.", [{ field: "parentId", message: "Choose a different parent." }]);
    const map: Record<string, string> = { parentId: "parent_id", name: "name", description: "description", sortOrder: "sort_order", isActive: "is_active" };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(map)) {
      if (key in body) {
        values.push((body as Record<string, unknown>)[key]);
        sets.push(`${column} = $${values.length + 1}`);
      }
    }
    const row = await withContext(pool, dbContext(s), async (c) => {
      if (body.parentId) {
        // Moving a category under one of its own descendants would create a loop.
        const loop = await c.query(
          `WITH RECURSIVE ancestors AS (
             SELECT id, parent_id FROM categories WHERE id = $1
             UNION ALL SELECT c.id, c.parent_id FROM categories c JOIN ancestors a ON c.id = a.parent_id)
           SELECT 1 FROM ancestors WHERE id = $2`,
          [body.parentId, id],
        );
        if (loop.rowCount) throw new AppError(400, "validation_failed", "A category cannot be moved under its own sub-category.", [{ field: "parentId", message: "Choose a different parent." }]);
      }
      const res = await c.query<CategoryRow>(`UPDATE categories SET ${sets.join(", ")} WHERE id = $1 RETURNING id, parent_id, key, name, description, sort_order, is_active`, [id, ...values]);
      if (!res.rows[0]) throw new AppError(404, "not_found", "Category not found.");
      await writeAudit(c, { actorUserId: s.userId, action: "category.updated", entityType: "category", entityId: id, requestId: req.id });
      return res.rows[0];
    });
    return toCategory(row);
  });
}
