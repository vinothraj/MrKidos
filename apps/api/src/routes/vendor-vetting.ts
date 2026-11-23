import type { FastifyInstance } from "fastify";
import { withContext } from "@kidos/db";
import { z } from "zod";
import { writeAudit } from "../audit";
import { AppError } from "../errors";
import { dbContext, makeRequireCommunityPermission, makeRequireVendorPermission } from "../guards";
import type { Deps, TenantState } from "../types";

/** Keeps one vendor from filling the table with records (and the reviewer's queue with noise). */
const MAX_DOCUMENTS = 100;
const isoDate = z.iso.date();
const documentBody = z
  .object({
    requirementKey: z.string().regex(/^[a-z_]+$/u).max(40),
    title: z.string().trim().min(1).max(120),
    reference: z.string().trim().max(300).nullable().optional(),
    issuedOn: isoDate.nullable().optional(),
    expiresOn: isoDate.nullable().optional(),
  })
  .strict()
  .refine((v) => !v.issuedOn || !v.expiresOn || v.expiresOn >= v.issuedOn, { message: "The expiry date cannot be before the issue date.", path: ["expiresOn"] });
const documentPatch = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    reference: z.string().trim().max(300).nullable().optional(),
    issuedOn: isoDate.nullable().optional(),
    expiresOn: isoDate.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to change.");
const reviewBody = z.object({ decision: z.enum(["verify", "reject"]), note: z.string().trim().max(500).optional() }).strict();
const approvalBody = z.object({ status: z.enum(["approved", "rejected", "revoked"]), note: z.string().trim().max(500).optional() }).strict();

interface DocRow {
  id: string;
  requirement_key: string;
  title: string;
  reference: string | null;
  issued_on: string | null;
  expires_on: string | null;
  status: string;
  reviewed_at: Date | null;
  review_note: string | null;
  created_at: Date;
  expired: boolean;
}
const toDoc = (r: DocRow) => ({
  id: r.id,
  requirementKey: r.requirement_key,
  title: r.title,
  reference: r.reference,
  issuedOn: r.issued_on,
  expiresOn: r.expires_on,
  status: r.status,
  expired: r.expired,
  reviewedAt: r.reviewed_at?.toISOString() ?? null,
  reviewNote: r.review_note,
  createdAt: r.created_at.toISOString(),
});
const DOC_SELECT = `SELECT id, requirement_key, title, reference, issued_on::text AS issued_on, expires_on::text AS expires_on, status, reviewed_at, review_note, created_at,
                           (expires_on IS NOT NULL AND expires_on < current_date) AS expired
                      FROM vendor_documents`;

export async function vendorVettingRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool } = deps;
  const requireVendor = makeRequireVendorPermission(deps);
  const requireCommunity = makeRequireCommunityPermission(deps);

  const state = (req: { tenantState?: TenantState }): TenantState => {
    if (!req.tenantState) throw new AppError(400, "tenant_required", "Select an organization first.");
    return req.tenantState;
  };

  /* ------------------------------------------------------------------ vetting */

  /** For each requirement: what the vendor has provided and where it stands. This is what approval depends on. */
  app.get("/vendors/:id/vetting", { preHandler: requireVendor("vendor_documents.manage") }, async (req) => {
    const s = state(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return withContext(pool, dbContext(s), async (c) => {
      const reqs = await c.query<{ key: string; label: string; description: string; is_required: boolean }>("SELECT key, label, description, is_required FROM vetting_requirements ORDER BY sort_order");
      const docs = await c.query<DocRow>(`${DOC_SELECT} WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC`, [id]);
      const requirements = reqs.rows.map((r) => {
        const mine = docs.rows.filter((d) => d.requirement_key === r.key);
        const verified = mine.find((d) => d.status === "verified" && !d.expired);
        const state = verified
          ? "verified"
          : mine.some((d) => d.status === "verified" && d.expired)
            ? "expired"
            : mine.some((d) => d.status === "submitted")
              ? "submitted"
              : mine.some((d) => d.status === "rejected")
                ? "rejected"
                : "missing";
        return { key: r.key, label: r.label, description: r.description, required: r.is_required, state, documents: mine.map(toDoc) };
      });
      return { requirements, readyForApproval: requirements.filter((r) => r.required).every((r) => r.state === "verified") };
    });
  });

  app.post("/vendors/:id/documents", { preHandler: requireVendor("vendor_documents.manage") }, async (req, reply) => {
    const s = state(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = documentBody.parse(req.body);
    const doc = await withContext(pool, dbContext(s), async (c) => {
      const req_ = await c.query("SELECT 1 FROM vetting_requirements WHERE key = $1", [body.requirementKey]);
      if (!req_.rowCount) throw new AppError(400, "validation_failed", "Unknown document type.", [{ field: "requirementKey", message: "Choose a document type from the list." }]);
      const org = await c.query("SELECT 1 FROM organizations WHERE id = $1 AND type = 'vendor'", [id]);
      if (!org.rowCount) throw new AppError(404, "not_found", "Vendor not found.");
      const held = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM vendor_documents WHERE tenant_id = $1", [id]);
      if ((held.rows[0]?.n ?? 0) >= MAX_DOCUMENTS) throw new AppError(422, "limit_reached", `A vendor can hold at most ${MAX_DOCUMENTS} documents.`);
      const res = await c.query<DocRow>(
        `INSERT INTO vendor_documents (tenant_id, requirement_key, title, reference, issued_on, expires_on, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, requirement_key, title, reference, issued_on::text AS issued_on, expires_on::text AS expires_on, status, reviewed_at, review_note, created_at,
                   (expires_on IS NOT NULL AND expires_on < current_date) AS expired`,
        [id, body.requirementKey, body.title, body.reference ?? null, body.issuedOn ?? null, body.expiresOn ?? null, s.userId],
      );
      const row = res.rows[0];
      if (!row) throw new Error("document insert returned no row");
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "vendor.document_submitted", entityType: "document", entityId: row.id, metadata: { requirement: body.requirementKey }, requestId: req.id });
      return row;
    });
    return reply.code(201).send(toDoc(doc));
  });

  /** Only a submission that has not been reviewed can be edited or withdrawn; a decision locks it. */
  app.patch("/vendors/:id/documents/:docId", { preHandler: requireVendor("vendor_documents.manage") }, async (req) => {
    const s = state(req);
    const { id, docId } = z.object({ id: z.uuid(), docId: z.uuid() }).parse(req.params);
    const body = documentPatch.parse(req.body) as Record<string, unknown>;
    const map: Record<string, string> = { title: "title", reference: "reference", issuedOn: "issued_on", expiresOn: "expires_on" };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(map)) {
      if (key in body) {
        values.push(body[key]);
        sets.push(`${column} = $${values.length + 2}`);
      }
    }
    const row = await withContext(pool, dbContext(s), async (c) => {
      const res = await c.query<DocRow>(
        `UPDATE vendor_documents SET ${sets.join(", ")} WHERE id = $1 AND tenant_id = $2 AND status = 'submitted'
         RETURNING id, requirement_key, title, reference, issued_on::text AS issued_on, expires_on::text AS expires_on, status, reviewed_at, review_note, created_at,
                   (expires_on IS NOT NULL AND expires_on < current_date) AS expired`,
        [docId, id, ...values],
      );
      if (!res.rows[0]) throw new AppError(404, "not_found", "Document not found, or it has already been reviewed and can no longer be changed.");
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "vendor.document_updated", entityType: "document", entityId: docId, requestId: req.id });
      return res.rows[0];
    });
    return toDoc(row);
  });

  app.delete("/vendors/:id/documents/:docId", { preHandler: requireVendor("vendor_documents.manage") }, async (req, reply) => {
    const s = state(req);
    const { id, docId } = z.object({ id: z.uuid(), docId: z.uuid() }).parse(req.params);
    await withContext(pool, dbContext(s), async (c) => {
      const res = await c.query("DELETE FROM vendor_documents WHERE id = $1 AND tenant_id = $2 AND status = 'submitted'", [docId, id]);
      if (!res.rowCount) throw new AppError(404, "not_found", "Document not found, or it has already been reviewed and can no longer be withdrawn.");
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: "vendor.document_withdrawn", entityType: "document", entityId: docId, requestId: req.id });
    });
    return reply.code(204).send();
  });

  /** The platform team's decision. Vendors can never review their own documents. */
  app.post("/vendors/:id/documents/:docId/review", { preHandler: requireVendor("vendors.vet") }, async (req) => {
    const s = state(req);
    if (!s.platformScope) throw new AppError(403, "platform_scope_required", "Documents are reviewed by the platform team.");
    const { id, docId } = z.object({ id: z.uuid(), docId: z.uuid() }).parse(req.params);
    const body = reviewBody.parse(req.body);
    if (body.decision === "reject" && !body.note?.trim()) throw new AppError(400, "note_required", "Say why the document was not accepted.");
    const row = await withContext(pool, dbContext(s), async (c) => {
      const cur = await c.query<{ status: string; expired: boolean }>(
        "SELECT status, (expires_on IS NOT NULL AND expires_on < current_date) AS expired FROM vendor_documents WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
        [docId, id],
      );
      const d = cur.rows[0];
      if (!d) throw new AppError(404, "not_found", "Document not found.");
      if (d.status !== "submitted") throw new AppError(409, "already_reviewed", "This document has already been reviewed.");
      if (body.decision === "verify" && d.expired) throw new AppError(422, "document_expired", "This document has already expired, so it cannot be verified.");
      const res = await c.query<DocRow>(
        `UPDATE vendor_documents SET status = $3, reviewed_by = $4, reviewed_at = now(), review_note = $5 WHERE id = $1 AND tenant_id = $2
         RETURNING id, requirement_key, title, reference, issued_on::text AS issued_on, expires_on::text AS expires_on, status, reviewed_at, review_note, created_at,
                   (expires_on IS NOT NULL AND expires_on < current_date) AS expired`,
        [docId, id, body.decision === "verify" ? "verified" : "rejected", s.userId, body.note?.trim() ?? null],
      );
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: `vendor.document_${body.decision === "verify" ? "verified" : "rejected"}`, entityType: "document", entityId: docId, requestId: req.id });
      return res.rows[0] as DocRow;
    });
    return toDoc(row);
  });

  /* -------------------------------------------- a community's decisions about vendors */

  /** Active vendors that say they serve this community, and what the community has decided about each. */
  app.get("/communities/:id/vendors", { preHandler: requireCommunity("community.approve_vendor") }, async (req) => {
    const s = state(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const rows = await withContext(pool, dbContext(s), async (c) =>
      (
        await c.query<{ id: string; name: string; tagline: string | null; city: string | null; locality: string | null; categories: string[]; status: string | null; note: string | null; decided_at: Date | null }>(
          `SELECT v.id, v.name, vp.tagline, vp.city, vp.locality,
                  COALESCE((SELECT array_agg(cat.name ORDER BY cat.name) FROM vendor_categories vc JOIN categories cat ON cat.id = vc.category_id WHERE vc.tenant_id = v.id), '{}') AS categories,
                  a.status, a.note, a.decided_at
             FROM vendor_service_areas sa
             JOIN organizations v ON v.id = sa.tenant_id AND v.type = 'vendor' AND v.status = 'active'
             LEFT JOIN vendor_profiles vp ON vp.tenant_id = v.id
             LEFT JOIN community_vendor_approvals a ON a.tenant_id = sa.community_id AND a.vendor_id = v.id
            WHERE sa.community_id = $1 ORDER BY v.name`,
          [id],
        )
      ).rows,
    );
    return {
      data: rows.map((r) => ({
        vendorId: r.id,
        name: r.name,
        tagline: r.tagline,
        city: r.city,
        locality: r.locality,
        categories: r.categories,
        decision: r.status ?? "undecided",
        note: r.note,
        decidedAt: r.decided_at?.toISOString() ?? null,
      })),
    };
  });

  app.put("/communities/:id/vendors/:vendorId", { preHandler: requireCommunity("community.approve_vendor") }, async (req) => {
    const s = state(req);
    const { id, vendorId } = z.object({ id: z.uuid(), vendorId: z.uuid() }).parse(req.params);
    const body = approvalBody.parse(req.body);
    if (body.status !== "approved" && !body.note?.trim()) throw new AppError(400, "note_required", "Say why, so the vendor and the team understand the decision.");
    await withContext(pool, dbContext(s), async (c) => {
      // The vendor must be one the community is allowed to see: active and serving this community.
      const visible = await c.query("SELECT 1 FROM vendor_service_areas sa JOIN organizations v ON v.id = sa.tenant_id AND v.type = 'vendor' AND v.status = 'active' WHERE sa.community_id = $1 AND sa.tenant_id = $2", [id, vendorId]);
      if (!visible.rowCount) throw new AppError(404, "not_found", "Vendor not found.");
      await c.query(
        `INSERT INTO community_vendor_approvals (tenant_id, vendor_id, status, note, decided_by, decided_at) VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (tenant_id, vendor_id) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, decided_by = EXCLUDED.decided_by, decided_at = now()`,
        [id, vendorId, body.status, body.note?.trim() ?? null, s.userId],
      );
      await writeAudit(c, { tenantId: id, actorUserId: s.userId, action: `community.vendor_${body.status}`, entityType: "organization", entityId: vendorId, requestId: req.id });
    });
    return { vendorId, decision: body.status };
  });
}
