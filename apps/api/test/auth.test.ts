import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, login, register, STRONG_PASSWORD, type TestApp } from "./helpers";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

let counter = 0;
const uniqueEmail = (prefix: string) => `${prefix}${++counter}@example.test`;

describe("health", () => {
  it("reports liveness and readiness", async () => {
    expect((await call(t.app, { url: "/health/live" })).statusCode).toBe(200);
    expect((await call(t.app, { url: "/health/ready" })).statusCode).toBe(200);
  });

  it("returns a JSON 404 with a request id for unknown routes", async () => {
    const res = await call(t.app, { url: "/api/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    expect(res.json().error.requestId).toBeTruthy();
  });

  it("echoes a valid X-Request-Id and replaces an invalid one", async () => {
    const ok = await call(t.app, { url: "/health/live", headers: { "x-request-id": "trace-12345678" } });
    expect(ok.headers["x-request-id"]).toBe("trace-12345678");
    const bad = await call(t.app, { url: "/health/live", headers: { "x-request-id": "bad id with spaces!" } });
    expect(bad.headers["x-request-id"]).not.toBe("bad id with spaces!");
  });
});

describe("registration", () => {
  it("creates an account, sets a hardened session cookie, and never returns secrets", async () => {
    const email = uniqueEmail("reg");
    const res = await call(t.app, {
      method: "POST",
      url: "/api/v1/auth/register",
      body: { email: email.toUpperCase(), password: STRONG_PASSWORD, displayName: "Priya" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.email).toBe(email); // normalized to lower case
    expect(res.body).not.toContain(STRONG_PASSWORD);
    expect(res.body).not.toContain("argon2");

    const cookie = res.cookies.find((c) => c.name === "kidos_sid");
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(String(cookie?.sameSite).toLowerCase()).toBe("lax");
    expect(cookie?.path).toBe("/");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("stores an Argon2id hash, never the password, and only a hash of the session token", async () => {
    const email = uniqueEmail("store");
    const { userId, cookie } = await register(t.app, email);
    const cred = await t.db.admin.query("SELECT password_hash FROM user_credentials WHERE user_id = $1", [userId]);
    expect(cred.rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(cred.rows[0].password_hash).not.toContain(STRONG_PASSWORD);
    const raw = await t.db.admin.query("SELECT count(*)::int AS n FROM sessions WHERE token_hash = $1", [cookie]);
    expect(raw.rows[0].n).toBe(0);
  });

  it("rejects duplicate emails regardless of case", async () => {
    const email = uniqueEmail("dup");
    await register(t.app, email);
    const res = await call(t.app, {
      method: "POST",
      url: "/api/v1/auth/register",
      body: { email: email.toUpperCase(), password: STRONG_PASSWORD, displayName: "Again" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("email_taken");
  });

  it("validates input and reports field-level errors with a request id", async () => {
    const res = await call(t.app, {
      method: "POST",
      url: "/api/v1/auth/register",
      body: { email: "not-an-email", password: "short", displayName: "" },
    });
    expect(res.statusCode).toBe(400);
    const err = res.json().error;
    expect(err.code).toBe("validation_failed");
    expect(err.requestId).toBeTruthy();
    expect(err.details.map((d: { field: string }) => d.field).sort()).toEqual(["displayName", "email", "password"]);
  });

  it("rejects common passwords and unknown properties (no mass assignment)", async () => {
    const common = await call(t.app, {
      method: "POST",
      url: "/api/v1/auth/register",
      body: { email: uniqueEmail("weak"), password: "password12345", displayName: "X" },
    });
    expect(common.statusCode).toBe(400);
    const extra = await call(t.app, {
      method: "POST",
      url: "/api/v1/auth/register",
      body: { email: uniqueEmail("extra"), password: STRONG_PASSWORD, displayName: "X", status: "suspended", isAdmin: true },
    });
    expect(extra.statusCode).toBe(400);
  });

  it("records an audit entry without secrets", async () => {
    const { userId } = await register(t.app, uniqueEmail("aud"));
    const { rows } = await t.db.admin.query("SELECT action, metadata FROM audit_log WHERE actor_user_id = $1", [userId]);
    expect(rows.map((r) => r.action)).toContain("auth.register");
    expect(JSON.stringify(rows)).not.toContain(STRONG_PASSWORD);
  });
});

describe("login", () => {
  it("authenticates with the right password and issues a new session", async () => {
    const email = uniqueEmail("login");
    await register(t.app, email);
    const cookie = await login(t.app, email);
    const me = await call(t.app, { url: "/api/v1/me", cookie });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe(email);
  });

  it("gives the same response for a wrong password and an unknown account", async () => {
    const email = uniqueEmail("same");
    await register(t.app, email);
    const wrong = await call(t.app, { method: "POST", url: "/api/v1/auth/login", body: { email, password: "wrong-password-123" } });
    const unknown = await call(t.app, {
      method: "POST",
      url: "/api/v1/auth/login",
      body: { email: "nobody@example.test", password: "wrong-password-123" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe("invalid_credentials");
    expect(unknown.json().error.code).toBe("invalid_credentials");
    expect(wrong.json().error.message).toBe(unknown.json().error.message);
    expect(wrong.cookies).toHaveLength(0);
  });

  it("locks the account after repeated failures, even for the right password, then recovers", async () => {
    const email = uniqueEmail("lock");
    const { userId } = await register(t.app, email);
    for (let i = 0; i < 5; i++) {
      const r = await call(t.app, { method: "POST", url: "/api/v1/auth/login", body: { email, password: "wrong-password-123" } });
      expect(r.statusCode).toBe(401);
    }
    const blocked = await call(t.app, { method: "POST", url: "/api/v1/auth/login", body: { email, password: STRONG_PASSWORD } });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("too_many_attempts");
    expect(blocked.cookies).toHaveLength(0);

    await t.db.admin.query("UPDATE user_credentials SET locked_until = now() - interval '1 second' WHERE user_id = $1", [userId]);
    const ok = await call(t.app, { method: "POST", url: "/api/v1/auth/login", body: { email, password: STRONG_PASSWORD } });
    expect(ok.statusCode).toBe(200);
    const row = await t.db.admin.query("SELECT failed_attempts, locked_until FROM user_credentials WHERE user_id = $1", [userId]);
    expect(row.rows[0]).toEqual({ failed_attempts: 0, locked_until: null });
  });

  it("refuses suspended accounts", async () => {
    const email = uniqueEmail("susp");
    const { userId, cookie } = await register(t.app, email);
    await t.db.admin.query("UPDATE users SET status = 'suspended' WHERE id = $1", [userId]);
    const res = await call(t.app, { method: "POST", url: "/api/v1/auth/login", body: { email, password: STRONG_PASSWORD } });
    expect(res.statusCode).toBe(401);
    // an already-open session stops working too
    expect((await call(t.app, { url: "/api/v1/me", cookie })).statusCode).toBe(401);
  });

  it("audits failures without storing the email address or password", async () => {
    const email = uniqueEmail("auditfail");
    await call(t.app, { method: "POST", url: "/api/v1/auth/login", body: { email, password: "wrong-password-123" } });
    const { rows } = await t.db.admin.query("SELECT metadata FROM audit_log WHERE action = 'auth.login_failed'");
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(email);
    expect(dump).not.toContain("wrong-password-123");
  });
});

describe("sessions", () => {
  it("requires authentication", async () => {
    expect((await call(t.app, { url: "/api/v1/me" })).statusCode).toBe(401);
    expect((await call(t.app, { url: "/api/v1/me", cookie: "garbage" })).statusCode).toBe(401);
  });

  it("logout revokes the session server-side", async () => {
    const { cookie } = await register(t.app, uniqueEmail("out"));
    const out = await call(t.app, { method: "POST", url: "/api/v1/auth/logout", cookie });
    expect(out.statusCode).toBe(204);
    expect((await call(t.app, { url: "/api/v1/me", cookie })).statusCode).toBe(401); // replaying the old cookie fails
  });

  it("expires absolute and idle sessions", async () => {
    const a = await register(t.app, uniqueEmail("abs"));
    await t.db.admin.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1", [a.userId]);
    expect((await call(t.app, { url: "/api/v1/me", cookie: a.cookie })).statusCode).toBe(401);

    const b = await register(t.app, uniqueEmail("idle"));
    await t.db.admin.query("UPDATE sessions SET last_seen_at = now() - interval '2 hours' WHERE user_id = $1", [b.userId]);
    expect((await call(t.app, { url: "/api/v1/me", cookie: b.cookie })).statusCode).toBe(401);
  });

  it("lists sessions and revokes another one, but only your own", async () => {
    const email = uniqueEmail("multi");
    const first = await register(t.app, email);
    const second = await login(t.app, email);
    const other = await register(t.app, uniqueEmail("other"));

    const list = await call(t.app, { url: "/api/v1/me/sessions", cookie: first.cookie });
    expect(list.json().data).toHaveLength(2);
    expect(list.json().data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);

    const otherList = await call(t.app, { url: "/api/v1/me/sessions", cookie: other.cookie });
    const foreignId = otherList.json().data[0].id as string;
    const hijack = await call(t.app, { method: "DELETE", url: `/api/v1/me/sessions/${foreignId}`, cookie: first.cookie });
    expect(hijack.statusCode).toBe(404);
    expect((await call(t.app, { url: "/api/v1/me", cookie: other.cookie })).statusCode).toBe(200);

    const secondId = (list.json().data as { id: string; current: boolean }[]).find((s) => !s.current)?.id;
    const revoke = await call(t.app, { method: "DELETE", url: `/api/v1/me/sessions/${secondId}`, cookie: first.cookie });
    expect(revoke.statusCode).toBe(204);
    expect((await call(t.app, { url: "/api/v1/me", cookie: second })).statusCode).toBe(401);
    expect((await call(t.app, { url: "/api/v1/me", cookie: first.cookie })).statusCode).toBe(200);
  });
});

describe("CSRF origin checks", () => {
  it("rejects state-changing requests with a session but no Origin", async () => {
    const { cookie } = await register(t.app, uniqueEmail("csrf1"));
    const res = await call(t.app, { method: "POST", url: "/api/v1/auth/logout", cookie, origin: null });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("origin_required");
    expect((await call(t.app, { url: "/api/v1/me", cookie })).statusCode).toBe(200); // session untouched
  });

  it("rejects state-changing requests from a foreign Origin", async () => {
    const { cookie } = await register(t.app, uniqueEmail("csrf2"));
    const res = await call(t.app, { method: "POST", url: "/api/v1/auth/logout", cookie, origin: "https://evil.example" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("origin_not_allowed");
    const login = await call(t.app, {
      method: "POST",
      url: "/api/v1/auth/login",
      origin: "https://evil.example",
      body: { email: "x@example.test", password: "whatever-123456" },
    });
    expect(login.statusCode).toBe(403);
  });

  it("allows safe methods without an Origin", async () => {
    const { cookie } = await register(t.app, uniqueEmail("csrf3"));
    expect((await call(t.app, { url: "/api/v1/me", cookie, origin: null })).statusCode).toBe(200);
  });
});

describe("rate limiting", () => {
  it("throttles repeated authentication attempts", async () => {
    const limited = await createTestApp({ authRateLimitPerMinute: 3 });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await call(limited.app, {
          method: "POST",
          url: "/api/v1/auth/login",
          body: { email: "nobody@example.test", password: "wrong-password-123" },
        });
        statuses.push(r.statusCode);
        if (r.statusCode === 429) expect(r.json().error.code).toBe("rate_limited");
      }
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
      expect(statuses.slice(3)).toEqual([429, 429]);
    } finally {
      await limited.close();
    }
  });
});
