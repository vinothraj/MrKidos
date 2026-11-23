import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { AppError } from "./errors";
import { SESSION_COOKIE } from "./auth/session";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { catalogRoutes } from "./routes/catalog";
import { concernRoutes } from "./routes/concerns";
import { categoryRoutes } from "./routes/categories";
import { offeringRoutes } from "./routes/offerings";
import { attentionRoutes } from "./routes/attention";
import { paymentsReviewsRoutes } from "./routes/payments-reviews";
import { requestRoutes } from "./routes/requests";
import { sourcingRoutes } from "./routes/sourcing";
import { vendorRoutes } from "./routes/vendors";
import { vendorVettingRoutes } from "./routes/vendor-vetting";
import { bannerRoutes } from "./routes/banners";
import { communityConfigRoutes } from "./routes/community-config";
import { communityRoutes } from "./routes/communities";
import { credentialRoutes } from "./routes/credentials";
import { devLoginRoutes } from "./routes/dev-login";
import { membershipRoutes } from "./routes/membership";
import { familyRoutes } from "./routes/family";
import { meRoutes } from "./routes/me";
import { mfaRoutes } from "./routes/mfa";
import type { Deps } from "./types";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export async function buildApp(deps: Deps, options: { logger?: boolean; devQuickLogin?: boolean } = {}): Promise<FastifyInstance> {
  const { config, pool } = deps;

  const app = Fastify({
    logger: options.logger
      ? { level: "info", redact: ["req.headers.cookie", "req.headers.authorization", "res.headers['set-cookie']"] }
      : false,
    trustProxy: config.trustProxy,
    bodyLimit: 256 * 1024,
    genReqId: (req) => {
      const header = req.headers["x-request-id"];
      return typeof header === "string" && REQUEST_ID.test(header) ? header : randomUUID();
    },
  });

  await app.register(helmet);
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: config.globalRateLimitPerMinute,
    timeWindow: "1 minute",
  });

  // CSRF defense for cookie sessions: SameSite=Lax cookies plus an Origin allow-list on state-changing requests.
  app.addHook("onRequest", async (req) => {
    if (!MUTATING.has(req.method)) return;
    const origin = req.headers.origin;
    const hasSession = typeof req.cookies?.[SESSION_COOKIE] === "string";
    if (origin !== undefined) {
      if (!config.allowedOrigins.includes(origin)) throw new AppError(403, "origin_not_allowed", "Request origin is not allowed.");
    } else if (hasSession) {
      throw new AppError(403, "origin_required", "An Origin header is required for this request.");
    }
  });

  app.addHook("onSend", async (req, reply) => {
    void reply.header("x-request-id", req.id);
    void reply.header("cache-control", "no-store");
  });

  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id;
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "validation_failed",
          message: "One or more fields are invalid.",
          details: err.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
          requestId,
        },
      });
    }
    if (err instanceof AppError) {
      return reply.code(err.status).send({
        error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}), requestId },
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) {
      return reply.code(429).send({ error: { code: "rate_limited", message: "Too many requests. Slow down.", requestId } });
    }
    if (typeof status === "number" && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: "bad_request", message: "The request could not be processed.", requestId } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { code: "internal_error", message: "Something went wrong.", requestId } });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: { code: "not_found", message: "Route not found.", requestId: req.id } }),
  );

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  await app.register(
    async (v1) => {
      await v1.register(authRoutes, deps);
      await v1.register(credentialRoutes, deps);
      await v1.register(mfaRoutes, deps);
      await v1.register(meRoutes, deps);
      await v1.register(adminRoutes, deps);
      await v1.register(communityRoutes, deps);
      await v1.register(communityConfigRoutes, deps);
      await v1.register(membershipRoutes, deps);
      await v1.register(familyRoutes, deps);
      await v1.register(categoryRoutes, deps);
      await v1.register(vendorRoutes, deps);
      await v1.register(vendorVettingRoutes, deps);
      await v1.register(offeringRoutes, deps);
      await v1.register(catalogRoutes, deps);
      await v1.register(requestRoutes, deps);
      await v1.register(sourcingRoutes, deps);
      await v1.register(paymentsReviewsRoutes, deps);
      await v1.register(concernRoutes, deps);
      await v1.register(attentionRoutes, deps);
      await v1.register(bannerRoutes, deps);
      // Passwordless sign-in for seeded accounts: only the local dev stack asks for it (tools/stack.ts), never the real server.
      if (options.devQuickLogin) await v1.register(devLoginRoutes, deps);
    },
    { prefix: "/api/v1" },
  );

  return app;
}
