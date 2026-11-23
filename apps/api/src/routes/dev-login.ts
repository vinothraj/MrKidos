import type { FastifyInstance } from "fastify";
import { withContext } from "@kidos/db";
import { z } from "zod";
import { writeAudit } from "../audit";
import { createSession, newSessionToken } from "../auth/session";
import { DEV_ACCOUNTS, DEV_PASSWORD, isDevEmail } from "../dev-accounts";
import { AppError } from "../errors";
import type { Deps } from "../types";
import { makeSessionCookieSetter } from "./auth";

const bodySchema = z.object({ email: z.string().trim().toLowerCase() }).strict();

/**
 * Quick sign-in for the seeded development accounts. NEVER register this in production: it signs anyone in without a password.
 * Only tools/stack.ts (dev mode) registers it, and it refuses to run unless NODE_ENV is "development".
 */
export async function devLoginRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool, config } = deps;
  if (config.env !== "development") throw new Error("devLoginRoutes may only be registered when NODE_ENV is development");
  const setSessionCookie = makeSessionCookieSetter(deps);

  app.get("/dev/accounts", async () => ({ password: DEV_PASSWORD, accounts: DEV_ACCOUNTS }));

  app.post("/dev/login", async (req, reply) => {
    const { email } = bodySchema.parse(req.body);
    if (!isDevEmail(email)) throw new AppError(404, "not_found", "Not a development account.");
    const token = newSessionToken();
    const done = await withContext(pool, { loginEmail: email }, async (c) => {
      const { rows } = await c.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1 AND deleted_at IS NULL", [email]);
      return rows[0]?.id ?? null;
    });
    if (!done) throw new AppError(404, "not_found", "Development accounts are not seeded yet. Restart dev:stack.");
    await withContext(pool, { userId: done }, async (c) => {
      const sessionId = await createSession(c, { userId: done, token, ip: req.ip, userAgent: req.headers["user-agent"] }, config);
      // The seed enrolls no second factor, so mark it verified here: platform and community staff roles would otherwise be blocked.
      await c.query("UPDATE sessions SET mfa_verified_at = now() WHERE id = $1", [sessionId]);
      // Start inside the person's own community or business (platform staff pick "Platform" themselves), so the demo opens on a useful page.
      await c.query(
        `UPDATE sessions SET active_tenant_id = (
           SELECT m.tenant_id FROM memberships m JOIN organizations o ON o.id = m.tenant_id
            WHERE m.user_id = $2 AND m.status = 'active' AND o.type <> 'platform' ORDER BY m.created_at LIMIT 1)
          WHERE id = $1`,
        [sessionId, done],
      );
      await writeAudit(c, { actorUserId: done, action: "auth.dev_quick_login", entityType: "user", entityId: done, requestId: req.id });
    });
    setSessionCookie(reply, token);
    return reply.send({ ok: true });
  });
}
