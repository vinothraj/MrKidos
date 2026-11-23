import type { FastifyInstance } from "fastify";
import { withContext } from "@kidos/db";
import type { PoolClient } from "pg";
import { z } from "zod";
import { writeAudit } from "../audit";
import { AppError } from "../errors";
import { makeAuthenticate } from "../guards";
import type { Deps } from "../types";

/** Version of the privacy notice a guardian agrees to. Bump it when the notice changes materially. */
export const CHILD_DATA_CONSENT_VERSION = "2026-11-v1";
const MAX_CHILDREN = 10;
const MAX_INTERESTS = 10;

const nickname = z
  .string()
  .trim()
  .min(1, "Enter a first name or nickname.")
  .max(40, "Use at most 40 characters.")
  // Data minimization: a nickname is not a place to put contact details or identifiers.
  .refine((v) => !/[@/\\]/u.test(v) && !/\d{5,}/u.test(v.replace(/[\s-]/gu, "")), "Use a first name or nickname only, without contact details.");

const interests = z
  .array(z.string().regex(/^[a-z_]+$/u).max(40))
  .max(MAX_INTERESTS)
  .refine((v) => new Set(v).size === v.length, "Each interest can be listed once.");

function birthYear() {
  const year = new Date().getFullYear();
  return z
    .number()
    .int()
    .min(year - 17, "Profiles are for children under 18.")
    .max(year, "That year is in the future.");
}

const createBody = () => z.object({ nickname, birthYear: birthYear(), interests: interests.default([]), consentAccepted: z.boolean().optional() }).strict();
const patchBody = () =>
  z
    .object({ nickname: nickname.optional(), birthYear: birthYear().optional(), interests: interests.optional() })
    .strict()
    .refine((v) => Object.keys(v).length > 0, "Provide at least one field to change.");
const idParam = z.object({ id: z.uuid() });

interface ChildRow {
  id: string;
  nickname: string;
  birth_year: number;
  interests: string[];
}
const toChild = (r: ChildRow) => ({ id: r.id, nickname: r.nickname, birthYear: r.birth_year, interests: r.interests, ageBand: ageBand(r.birth_year) });

/** Coarse age band shown to services instead of an exact age. */
export function ageBand(year: number, now = new Date()): string {
  const age = now.getFullYear() - year;
  if (age <= 2) return "0-2";
  if (age <= 5) return "3-5";
  if (age <= 8) return "6-8";
  if (age <= 12) return "9-12";
  return "13-17";
}

export async function familyRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool } = deps;
  const authenticate = makeAuthenticate(deps);

  /** Guardians are real, verified people: a verified email is required before any child data is stored. */
  function guardian(req: { auth?: { userId: string; emailVerified: boolean } }): string {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "unauthenticated", "Authentication is required.");
    if (!auth.emailVerified) throw new AppError(403, "email_verification_required", "Verify your email address to continue.");
    return auth.userId;
  }

  async function liveConsent(c: PoolClient, userId: string) {
    const res = await c.query<{ version: string; granted_at: Date }>(
      "SELECT version, granted_at FROM consents WHERE user_id = $1 AND kind = 'guardian_child_data' AND withdrawn_at IS NULL",
      [userId],
    );
    return res.rows[0];
  }

  async function validInterests(c: PoolClient, list: string[]): Promise<void> {
    if (list.length === 0) return;
    const res = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM interest_options WHERE key = ANY($1)", [list]);
    if ((res.rows[0]?.n ?? 0) !== list.length) {
      throw new AppError(400, "validation_failed", "One or more interests are not recognised.", [{ field: "interests", message: "Choose interests from the list." }]);
    }
  }

  app.get("/interests", { preHandler: authenticate }, async (req) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "unauthenticated", "Authentication is required.");
    const rows = await withContext(pool, { userId: auth.userId }, async (c) => (await c.query<{ key: string; label: string }>("SELECT key, label FROM interest_options ORDER BY sort_order, key")).rows);
    return { data: rows };
  });

  app.get("/me/family", { preHandler: authenticate }, async (req) => {
    const userId = guardian(req);
    return withContext(pool, { userId }, async (c) => {
      const kids = await c.query<ChildRow>(
        `SELECT c.id, c.nickname, c.birth_year, c.interests FROM children c JOIN families f ON f.id = c.family_id
          WHERE f.owner_user_id = $1 ORDER BY c.created_at, c.id`,
        [userId],
      );
      const consent = await liveConsent(c, userId);
      return {
        children: kids.rows.map(toChild),
        consent: consent ? { version: consent.version, grantedAt: consent.granted_at.toISOString() } : null,
        currentConsentVersion: CHILD_DATA_CONSENT_VERSION,
        limit: MAX_CHILDREN,
      };
    });
  });

  app.post("/me/family/children", { preHandler: authenticate }, async (req, reply) => {
    const userId = guardian(req);
    const body = createBody().parse(req.body);
    const child = await withContext(pool, { userId }, async (c) => {
      if (!(await liveConsent(c, userId))) {
        if (body.consentAccepted !== true) {
          throw new AppError(422, "consent_required", "As a parent or guardian you must agree to how we handle your child's information first.", [
            { field: "consentAccepted", message: "Please confirm you are the parent or guardian and agree." },
          ]);
        }
        await c.query("INSERT INTO consents (user_id, kind, version) VALUES ($1, 'guardian_child_data', $2)", [userId, CHILD_DATA_CONSENT_VERSION]);
      }
      await validInterests(c, body.interests);
      // The application role may insert but not update families, so: create if missing, then read.
      await c.query("INSERT INTO families (owner_user_id) VALUES ($1) ON CONFLICT (owner_user_id) DO NOTHING", [userId]);
      const fam = await c.query<{ id: string }>("SELECT id FROM families WHERE owner_user_id = $1", [userId]);
      const familyId = fam.rows[0]?.id;
      if (!familyId) throw new Error("family upsert returned no row");
      const count = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM children WHERE family_id = $1", [familyId]);
      if ((count.rows[0]?.n ?? 0) >= MAX_CHILDREN) throw new AppError(422, "limit_reached", `You can add up to ${MAX_CHILDREN} children.`);
      const res = await c.query<ChildRow>(
        "INSERT INTO children (family_id, nickname, birth_year, interests) VALUES ($1, $2, $3, $4) RETURNING id, nickname, birth_year, interests",
        [familyId, body.nickname, body.birthYear, body.interests],
      );
      const row = res.rows[0];
      if (!row) throw new Error("child insert returned no row");
      // Audit records that something happened, never the child's details.
      await writeAudit(c, { actorUserId: userId, action: "family.child_added", entityType: "child", entityId: row.id, requestId: req.id });
      return row;
    });
    return reply.code(201).send(toChild(child));
  });

  app.patch("/me/family/children/:id", { preHandler: authenticate }, async (req) => {
    const userId = guardian(req);
    const { id } = idParam.parse(req.params);
    const body = patchBody().parse(req.body);
    const row = await withContext(pool, { userId }, async (c) => {
      if (body.interests) await validInterests(c, body.interests);
      const sets: string[] = [];
      const values: unknown[] = [];
      const set = (column: string, value: unknown) => {
        values.push(value);
        sets.push(`${column} = $${values.length + 1}`); // $1 is the child id
      };
      if (body.nickname !== undefined) set("nickname", body.nickname);
      if (body.birthYear !== undefined) set("birth_year", body.birthYear);
      if (body.interests !== undefined) set("interests", body.interests);
      const res = await c.query<ChildRow>(`UPDATE children SET ${sets.join(", ")} WHERE id = $1 RETURNING id, nickname, birth_year, interests`, [id, ...values]);
      if (!res.rows[0]) throw new AppError(404, "not_found", "Child not found.");
      await writeAudit(c, { actorUserId: userId, action: "family.child_updated", entityType: "child", entityId: id, requestId: req.id });
      return res.rows[0];
    });
    return toChild(row);
  });

  app.delete("/me/family/children/:id", { preHandler: authenticate }, async (req, reply) => {
    const userId = guardian(req);
    const { id } = idParam.parse(req.params);
    await withContext(pool, { userId }, async (c) => {
      const res = await c.query("DELETE FROM children WHERE id = $1", [id]); // erasure is a hard delete
      if (!res.rowCount) throw new AppError(404, "not_found", "Child not found.");
      await writeAudit(c, { actorUserId: userId, action: "family.child_deleted", entityType: "child", entityId: id, requestId: req.id });
    });
    return reply.code(204).send();
  });

  /** Everything we hold about the guardian's family, as a downloadable file (right of access). */
  app.get("/me/family/export", { preHandler: authenticate }, async (req, reply) => {
    const userId = guardian(req);
    const data = await withContext(pool, { userId }, async (c) => {
      const kids = await c.query<ChildRow & { created_at: Date }>(
        `SELECT c.id, c.nickname, c.birth_year, c.interests, c.created_at FROM children c JOIN families f ON f.id = c.family_id
          WHERE f.owner_user_id = $1 ORDER BY c.created_at, c.id`,
        [userId],
      );
      const consents = await c.query<{ kind: string; version: string; granted_at: Date; withdrawn_at: Date | null }>(
        "SELECT kind, version, granted_at, withdrawn_at FROM consents WHERE user_id = $1 ORDER BY granted_at",
        [userId],
      );
      await writeAudit(c, { actorUserId: userId, action: "family.exported", requestId: req.id });
      return {
        exportedAt: new Date().toISOString(),
        children: kids.rows.map((r) => ({ id: r.id, nickname: r.nickname, birthYear: r.birth_year, interests: r.interests, addedAt: r.created_at.toISOString() })),
        consents: consents.rows.map((r) => ({ kind: r.kind, version: r.version, grantedAt: r.granted_at.toISOString(), withdrawnAt: r.withdrawn_at?.toISOString() ?? null })),
      };
    });
    void reply.header("content-disposition", 'attachment; filename="family-data.json"');
    return data;
  });

  /** Withdraws consent and permanently erases every child profile. */
  app.delete("/me/family", { preHandler: authenticate }, async (req, reply) => {
    const userId = guardian(req);
    await withContext(pool, { userId }, async (c) => {
      const removed = await c.query("DELETE FROM children WHERE family_id IN (SELECT id FROM families WHERE owner_user_id = $1)", [userId]);
      await c.query("UPDATE consents SET withdrawn_at = now() WHERE user_id = $1 AND kind = 'guardian_child_data' AND withdrawn_at IS NULL", [userId]);
      await writeAudit(c, { actorUserId: userId, action: "family.erased", metadata: { childrenErased: removed.rowCount ?? 0 }, requestId: req.id });
    });
    return reply.code(204).send();
  });
}
