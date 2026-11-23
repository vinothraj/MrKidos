import type { FastifyInstance } from "fastify";
import { withContext } from "@kidos/db";
import { z } from "zod";
import { writeAudit } from "../audit";
import { AppError } from "../errors";
import { dbContext, makeRequireCommunityPermission } from "../guards";
import type { Deps, TenantState } from "../types";

const FACILITY_KINDS = ["clubhouse", "hall", "ground", "court", "pool", "garden", "amphitheatre", "other"] as const;
const MAX_FACILITIES = 100;

const facilityBody = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(FACILITY_KINDS),
  capacity: z.number().int().min(0).max(100_000).nullable(),
  description: z.string().trim().max(1000).nullable(),
  bookable: z.boolean(),
});
const facilityCreate = facilityBody.partial({ capacity: true, description: true, bookable: true }).strict();
const facilityPatch = facilityBody.partial().strict().refine((v) => Object.keys(v).length > 0, "Provide at least one field to change.");
const idParams = z.object({ id: z.uuid() });
const facilityParams = z.object({ id: z.uuid(), facilityId: z.uuid() });
const policyParams = z.object({ id: z.uuid(), key: z.string().regex(/^[a-z_]+$/u).max(60) });
const policyBody = z.object({ value: z.unknown() }).strict();
const brandingBody = z.object({ palette: z.enum(["classic", "ocean", "forest"]) }).strict();

interface FacilityRow {
  id: string;
  name: string;
  kind: string;
  capacity: number | null;
  description: string | null;
  bookable: boolean;
}
const toFacility = (r: FacilityRow) => ({ id: r.id, name: r.name, kind: r.kind, capacity: r.capacity, description: r.description, bookable: r.bookable });

export async function communityConfigRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool } = deps;
  const requireCommunity = makeRequireCommunityPermission(deps);
  const state = (req: { tenantState?: TenantState }): TenantState => {
    if (!req.tenantState) throw new AppError(400, "tenant_required", "Select an organization first.");
    return req.tenantState;
  };

  /* ---------------------------------------------------------- facilities */

  app.get("/communities/:id/facilities", { preHandler: requireCommunity("communities.read") }, async (req) => {
    const s = state(req);
    const { id } = idParams.parse(req.params);
    const rows = await withContext(pool, dbContext(s), async (c) =>
      (await c.query<FacilityRow>("SELECT id, name, kind, capacity, description, bookable FROM community_facilities WHERE tenant_id = $1 ORDER BY name, id", [id])).rows,
    );
    return { data: rows.map(toFacility) };
  });

  app.post("/communities/:id/facilities", { preHandler: requireCommunity("facilities.manage") }, async (req, reply) => {
    const s = state(req);
    const { id } = idParams.parse(req.params);
    const body = facilityCreate.parse(req.body);
    const created = await withContext(pool, dbContext(s), async (c) => {
      const count = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM community_facilities WHERE tenant_id = $1", [id]);
      if ((count.rows[0]?.n ?? 0) >= MAX_FACILITIES) throw new AppError(422, "limit_reached", `A community can list up to ${MAX_FACILITIES} facilities.`);
      const res = await c.query<FacilityRow>(
        `INSERT INTO community_facilities (tenant_id, name, kind, capacity, description, bookable)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, kind, capacity, description, bookable`,
        [id, body.name, body.kind, body.capacity ?? null, body.description ?? null, body.bookable ?? true],
      );
      const row = res.rows[0];
      if (!row) throw new Error("facility insert returned no row");
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "community.facility_created", entityType: "facility", entityId: row.id, requestId: req.id });
      return row;
    });
    return reply.code(201).send(toFacility(created));
  });

  app.patch("/communities/:id/facilities/:facilityId", { preHandler: requireCommunity("facilities.manage") }, async (req) => {
    const s = state(req);
    const { id, facilityId } = facilityParams.parse(req.params);
    const body = facilityPatch.parse(req.body) as Record<string, unknown>;
    const columns: Record<string, string> = { name: "name", kind: "kind", capacity: "capacity", description: "description", bookable: "bookable" };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (key in body) {
        values.push(body[key]);
        sets.push(`${column} = $${values.length + 2}`);
      }
    }
    const row = await withContext(pool, dbContext(s), async (c) => {
      const res = await c.query<FacilityRow>(
        `UPDATE community_facilities SET ${sets.join(", ")} WHERE id = $1 AND tenant_id = $2 RETURNING id, name, kind, capacity, description, bookable`,
        [facilityId, id, ...values],
      );
      if (!res.rows[0]) throw new AppError(404, "not_found", "Facility not found.");
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "community.facility_updated", entityType: "facility", entityId: facilityId, requestId: req.id });
      return res.rows[0];
    });
    return toFacility(row);
  });

  app.delete("/communities/:id/facilities/:facilityId", { preHandler: requireCommunity("facilities.manage") }, async (req, reply) => {
    const s = state(req);
    const { id, facilityId } = facilityParams.parse(req.params);
    await withContext(pool, dbContext(s), async (c) => {
      const res = await c.query("DELETE FROM community_facilities WHERE id = $1 AND tenant_id = $2", [facilityId, id]);
      if (!res.rowCount) throw new AppError(404, "not_found", "Facility not found.");
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "community.facility_deleted", entityType: "facility", entityId: facilityId, requestId: req.id });
    });
    return reply.code(204).send();
  });

  /* ------------------------------------------------------------ policies */

  interface Definition {
    key: string;
    label: string;
    description: string;
    value_type: "boolean" | "text" | "enum";
    category: "general" | "security";
    updated_at: Date | null;
    updated_by_name: string | null;
    allowed: unknown[] | null;
    default_value: unknown;
    value: unknown;
    has_value: boolean;
  }

  async function loadPolicies(s: TenantState, id: string) {
    const rows = await withContext(pool, dbContext(s), async (c) =>
      (
        await c.query<Definition>(
          `SELECT d.key, d.label, d.description, d.value_type, d.category, d.allowed, d.default_value, p.value, (p.key IS NOT NULL) AS has_value,
                  p.updated_at, u.display_name AS updated_by_name
             FROM policy_definitions d
             LEFT JOIN community_policies p ON p.key = d.key AND p.tenant_id = $1
             LEFT JOIN users u ON u.id = p.updated_by
            ORDER BY d.sort_order, d.key`,
          [id],
        )
      ).rows,
    );
    return rows.map((d) => ({
      key: d.key,
      label: d.label,
      description: d.description,
      valueType: d.value_type,
      category: d.category,
      allowed: d.allowed,
      value: d.has_value ? d.value : d.default_value,
      isDefault: !d.has_value,
      // "Last changed by / when", for the settings screens. The name is only visible to people who may see that user.
      updatedAt: d.updated_at ? d.updated_at.toISOString() : null,
      updatedBy: d.updated_by_name,
    }));
  }

  app.get("/communities/:id/policies", { preHandler: requireCommunity("communities.read") }, async (req) => {
    const { id } = idParams.parse(req.params);
    return { data: await loadPolicies(state(req), id) };
  });

  /** Sets one policy. The value is validated against the policy's definition (type and allowed values), which is data. */
  app.put("/communities/:id/policies/:key", { preHandler: requireCommunity("policies.manage") }, async (req) => {
    const s = state(req);
    const { id, key } = policyParams.parse(req.params);
    const { value } = policyBody.parse(req.body);
    await withContext(pool, dbContext(s), async (c) => {
      const def = await c.query<{ value_type: string; allowed: unknown[] | null }>("SELECT value_type, allowed FROM policy_definitions WHERE key = $1", [key]);
      const d = def.rows[0];
      if (!d) throw new AppError(404, "not_found", "Unknown policy.");
      const schema =
        d.value_type === "boolean" ? z.boolean() : d.value_type === "enum" ? z.enum((d.allowed ?? []) as [string, ...string[]]) : z.string().trim().max(500);
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new AppError(400, "validation_failed", "That value is not allowed for this policy.", [{ field: "value", message: "Choose a permitted value." }]);
      await c.query(
        `INSERT INTO community_policies (tenant_id, key, value, updated_by) VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [id, key, JSON.stringify(parsed.data), s.userId],
      );
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "community.policy_changed", entityType: "policy", entityId: key, metadata: { value: parsed.data }, requestId: req.id });
    });
    return { data: await loadPolicies(s, id) };
  });

  /* ------------------------------------------------------------ branding */

  async function loadBranding(s: TenantState, id: string) {
    return withContext(pool, dbContext(s), async (c) => {
      const { rows } = await c.query<{ palette: string; updated_at: Date; updated_by_name: string | null }>(
        `SELECT b.palette, b.updated_at, u.display_name AS updated_by_name
           FROM community_branding b LEFT JOIN users u ON u.id = b.updated_by
          WHERE b.tenant_id = $1`,
        [id],
      );
      const r = rows[0];
      return r
        ? { palette: r.palette, isDefault: false, updatedAt: r.updated_at.toISOString(), updatedBy: r.updated_by_name }
        : { palette: "classic", isDefault: true, updatedAt: null, updatedBy: null };
    });
  }

  app.get("/communities/:id/branding", { preHandler: requireCommunity("communities.read") }, async (req) => {
    const { id } = idParams.parse(req.params);
    return loadBranding(state(req), id);
  });

  /** Sets the palette members of this community see by default. Only names of contrast-tested palettes are accepted. */
  app.put("/communities/:id/branding", { preHandler: requireCommunity("communities.update") }, async (req) => {
    const s = state(req);
    const { id } = idParams.parse(req.params);
    const { palette } = brandingBody.parse(req.body);
    await withContext(pool, dbContext(s), async (c) => {
      const exists = await c.query("SELECT 1 FROM organizations WHERE id = $1 AND type = 'community'", [id]);
      if (!exists.rowCount) throw new AppError(404, "not_found", "Community not found.");
      const updated = await c.query("UPDATE community_branding SET palette = $2, updated_by = $3, updated_at = now() WHERE tenant_id = $1", [id, palette, s.userId]);
      if (!updated.rowCount) await c.query("INSERT INTO community_branding (tenant_id, palette, updated_by) VALUES ($1, $2, $3)", [id, palette, s.userId]);
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "community.branding_changed", entityType: "organization", entityId: id, metadata: { palette }, requestId: req.id });
    });
    return loadBranding(s, id);
  });
}
