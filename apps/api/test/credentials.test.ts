import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Mailer } from "../src/mailer";
import {
  call,
  createTestApp,
  enrollMfa,
  login,
  markEmailVerified,
  nextCode,
  register,
  STRONG_PASSWORD,
  tokenFrom,
  type TestApp,
} from "./helpers";

const NEW_PASSWORD = "an-entirely-new-passphrase-7";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

let n = 0;
const email = (p: string) => `${p}${++n}@example.test`;
const post = (url: string, body?: unknown, cookie?: string) =>
  call(t.app, { method: "POST", url, ...(cookie ? { cookie } : {}), ...(body !== undefined ? { body } : {}) });

describe("email verification", () => {
  it("sends a link on registration, verifies once, and rejects reuse", async () => {
    const e = email("ver");
    const u = await register(t.app, e);
    expect((await call(t.app, { url: "/api/v1/me", cookie: u.cookie })).json().user.emailVerified).toBe(false);

    const mail = t.mailer.lastTo(e);
    expect(mail?.subject).toContain("Kidos");
    expect(mail?.text).toContain("http://localhost:3000/verify-email?token=");
    expect(mail?.text).not.toContain(STRONG_PASSWORD);
    const token = tokenFrom(mail);

    expect((await post("/api/v1/auth/email/verify", { token })).statusCode).toBe(204);
    expect((await call(t.app, { url: "/api/v1/me", cookie: u.cookie })).json().user.emailVerified).toBe(true);

    const reuse = await post("/api/v1/auth/email/verify", { token });
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json().error.code).toBe("invalid_token");
  });

  it("stores only a hash of the token", async () => {
    const e = email("hash");
    await register(t.app, e);
    const token = tokenFrom(t.mailer.lastTo(e));
    const hit = await t.db.admin.query("SELECT count(*)::int AS n FROM one_time_tokens WHERE token_hash = $1", [token]);
    expect(hit.rows[0].n).toBe(0);
  });

  it("rejects unknown, expired, malformed and wrong-purpose tokens identically", async () => {
    const e = email("bad");
    const u = await register(t.app, e);
    const token = tokenFrom(t.mailer.lastTo(e));

    const unknown = await post("/api/v1/auth/email/verify", { token: "x".repeat(43) });
    await t.db.admin.query("UPDATE one_time_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [u.userId]);
    const expired = await post("/api/v1/auth/email/verify", { token });
    for (const r of [unknown, expired]) {
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe("invalid_token");
    }
    expect((await post("/api/v1/auth/email/verify", { token: "short" })).statusCode).toBe(400);
    expect((await post("/api/v1/auth/email/verify", {})).statusCode).toBe(400);

    // A password-reset token must not verify an email.
    await post("/api/v1/auth/password/forgot", { email: e });
    const resetToken = tokenFrom(t.mailer.lastTo(e));
    const wrongPurpose = await post("/api/v1/auth/email/verify", { token: resetToken });
    expect(wrongPurpose.statusCode).toBe(400);
    const still = await t.db.admin.query("SELECT used_at FROM one_time_tokens WHERE purpose = 'password_reset' AND user_id = $1", [u.userId]);
    expect(still.rows[0].used_at).toBeNull(); // not consumed by the wrong-purpose attempt
  });

  it("resend issues a new token and invalidates the old one; it is silent once verified", async () => {
    const e = email("resend");
    const u = await register(t.app, e);
    const first = tokenFrom(t.mailer.lastTo(e));
    expect((await post("/api/v1/auth/email/resend", undefined, u.cookie)).statusCode).toBe(204);
    const second = tokenFrom(t.mailer.lastTo(e));
    expect(second).not.toBe(first);
    expect((await post("/api/v1/auth/email/verify", { token: first })).statusCode).toBe(400);
    expect((await post("/api/v1/auth/email/verify", { token: second })).statusCode).toBe(204);

    const before = t.mailer.sent.length;
    expect((await post("/api/v1/auth/email/resend", undefined, u.cookie)).statusCode).toBe(204);
    expect(t.mailer.sent.length).toBe(before);
    expect((await post("/api/v1/auth/email/resend")).statusCode).toBe(401);
  });

  it("registration still succeeds if the mail provider is down", async () => {
    const failing: Mailer = {
      async send() {
        throw new Error("provider down");
      },
    };
    const app2 = await createTestApp({}, failing);
    try {
      const res = await call(app2.app, {
        method: "POST",
        url: "/api/v1/auth/register",
        body: { email: "down@example.test", password: STRONG_PASSWORD, displayName: "Down" },
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await app2.close();
    }
  });
});

describe("forgotten password", () => {
  it("answers identically for known, unknown and suspended accounts, and only mails real active ones", async () => {
    const known = email("known");
    await register(t.app, known);
    const suspended = email("susp");
    const s = await register(t.app, suspended);
    await t.db.admin.query("UPDATE users SET status = 'suspended' WHERE id = $1", [s.userId]);
    const before = t.mailer.sent.length;

    const a = await post("/api/v1/auth/password/forgot", { email: known });
    const b = await post("/api/v1/auth/password/forgot", { email: "ghost@example.test" });
    const c = await post("/api/v1/auth/password/forgot", { email: suspended });
    for (const r of [a, b, c]) {
      expect(r.statusCode).toBe(202);
      expect(r.json()).toEqual({ ok: true });
    }
    expect(a.body).toBe(b.body);
    const newMails = t.mailer.sent.slice(before);
    expect(newMails.map((m) => m.to)).toEqual([known]);
    expect(newMails[0]?.text).toContain("/reset-password?token=");
  });

  it("validates the email field", async () => {
    expect((await post("/api/v1/auth/password/forgot", { email: "nope" })).statusCode).toBe(400);
    expect((await post("/api/v1/auth/password/forgot", {})).statusCode).toBe(400);
  });

  it("resets the password, signs out every session, and works only once", async () => {
    const e = email("reset");
    const u = await register(t.app, e);
    const other = await login(t.app, e);
    await post("/api/v1/auth/password/forgot", { email: e });
    const token = tokenFrom(t.mailer.lastTo(e));

    const res = await post("/api/v1/auth/password/reset", { token, password: NEW_PASSWORD });
    expect(res.statusCode).toBe(204);

    expect((await call(t.app, { url: "/api/v1/me", cookie: u.cookie })).statusCode).toBe(401);
    expect((await call(t.app, { url: "/api/v1/me", cookie: other })).statusCode).toBe(401);
    expect((await post("/api/v1/auth/login", { email: e, password: STRONG_PASSWORD })).statusCode).toBe(401);
    expect((await post("/api/v1/auth/login", { email: e, password: NEW_PASSWORD })).statusCode).toBe(200);

    const reuse = await post("/api/v1/auth/password/reset", { token, password: "yet-another-passphrase-3" });
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json().error.code).toBe("invalid_token");
  });

  it("rejects a weak new password without consuming the token", async () => {
    const e = email("weak");
    await register(t.app, e);
    await post("/api/v1/auth/password/forgot", { email: e });
    const token = tokenFrom(t.mailer.lastTo(e));
    const weak = await post("/api/v1/auth/password/reset", { token, password: "short" });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error.code).toBe("validation_failed");
    expect((await post("/api/v1/auth/password/reset", { token, password: NEW_PASSWORD })).statusCode).toBe(204);
  });

  it("rejects expired tokens and tokens superseded by a newer request", async () => {
    const e = email("exp");
    const u = await register(t.app, e);
    await post("/api/v1/auth/password/forgot", { email: e });
    const first = tokenFrom(t.mailer.lastTo(e));
    await post("/api/v1/auth/password/forgot", { email: e });
    const second = tokenFrom(t.mailer.lastTo(e));
    expect((await post("/api/v1/auth/password/reset", { token: first, password: NEW_PASSWORD })).statusCode).toBe(400);

    await t.db.admin.query("UPDATE one_time_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1", [u.userId]);
    expect((await post("/api/v1/auth/password/reset", { token: second, password: NEW_PASSWORD })).statusCode).toBe(400);
    expect((await post("/api/v1/auth/login", { email: e, password: STRONG_PASSWORD })).statusCode).toBe(200); // unchanged
  });

  it("clears an account lockout", async () => {
    const e = email("unlock");
    await register(t.app, e);
    for (let i = 0; i < 5; i++) await post("/api/v1/auth/login", { email: e, password: "wrong-password-123" });
    expect((await post("/api/v1/auth/login", { email: e, password: STRONG_PASSWORD })).statusCode).toBe(429);
    await post("/api/v1/auth/password/forgot", { email: e });
    const token = tokenFrom(t.mailer.lastTo(e));
    await post("/api/v1/auth/password/reset", { token, password: NEW_PASSWORD });
    expect((await post("/api/v1/auth/login", { email: e, password: NEW_PASSWORD })).statusCode).toBe(200);
  });

  it("does not bypass MFA: the next login is still pending", async () => {
    const e = email("rmfa");
    const u = await register(t.app, e);
    await markEmailVerified(t.db, u.userId);
    await enrollMfa(t.app, u.cookie);
    await post("/api/v1/auth/password/forgot", { email: e });
    await post("/api/v1/auth/password/reset", { token: tokenFrom(t.mailer.lastTo(e)), password: NEW_PASSWORD });
    const res = await post("/api/v1/auth/login", { email: e, password: NEW_PASSWORD });
    expect(res.json().mfaRequired).toBe(true);
  });

  it("audits the request and the reset without leaking tokens or passwords", async () => {
    const e = email("raud");
    const u = await register(t.app, e);
    await post("/api/v1/auth/password/forgot", { email: e });
    const token = tokenFrom(t.mailer.lastTo(e));
    await post("/api/v1/auth/password/reset", { token, password: NEW_PASSWORD });
    const { rows } = await t.db.admin.query("SELECT action, metadata FROM audit_log WHERE actor_user_id = $1", [u.userId]);
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("auth.password_reset_requested");
    expect(actions).toContain("auth.password_reset");
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(NEW_PASSWORD);
  });
});

describe("email flooding protection", () => {
  it("sends at most one reset or verification email per account per cooldown, with an unchanged response", async () => {
    const guarded = await createTestApp({ emailCooldownSeconds: 60 });
    try {
      const e = "flood@example.test";
      const reg = await call(guarded.app, {
        method: "POST",
        url: "/api/v1/auth/register",
        body: { email: e, password: STRONG_PASSWORD, displayName: "Flood" },
      });
      const cookie = reg.cookies.find((c) => c.name === "kidos_sid")?.value ?? "";
      expect(guarded.mailer.sent).toHaveLength(1); // the registration verification email

      // Resend straight after registration is throttled: same 204, no new email.
      const resend = await call(guarded.app, { method: "POST", url: "/api/v1/auth/email/resend", cookie });
      expect(resend.statusCode).toBe(204);
      expect(guarded.mailer.sent).toHaveLength(1);

      const first = await call(guarded.app, { method: "POST", url: "/api/v1/auth/password/forgot", body: { email: e } });
      const second = await call(guarded.app, { method: "POST", url: "/api/v1/auth/password/forgot", body: { email: e } });
      const third = await call(guarded.app, { method: "POST", url: "/api/v1/auth/password/forgot", body: { email: e } });
      expect([first, second, third].map((r) => r.statusCode)).toEqual([202, 202, 202]);
      expect(second.body).toBe(first.body);
      expect(guarded.mailer.sent).toHaveLength(2); // verification + exactly one reset email

      // Once the cooldown has passed, a new request goes through again.
      await guarded.db.admin.query("UPDATE one_time_tokens SET created_at = now() - interval '2 minutes'");
      await call(guarded.app, { method: "POST", url: "/api/v1/auth/password/forgot", body: { email: e } });
      expect(guarded.mailer.sent).toHaveLength(3);
      const throttled = await guarded.db.admin.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.password_reset_throttled'");
      expect(throttled.rows[0].n).toBe(2);
    } finally {
      await guarded.close();
    }
  });
});

describe("changing the password while signed in", () => {
  it("requires the current password, keeps this session, and ends the others", async () => {
    const e = email("chg");
    const u = await register(t.app, e);
    const other = await login(t.app, e);

    const wrong = await post("/api/v1/auth/password/change", { currentPassword: "not-my-password-1", newPassword: NEW_PASSWORD }, u.cookie);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe("incorrect_password");
    expect((await post("/api/v1/auth/login", { email: e, password: NEW_PASSWORD })).statusCode).toBe(401);

    const ok = await post("/api/v1/auth/password/change", { currentPassword: STRONG_PASSWORD, newPassword: NEW_PASSWORD }, u.cookie);
    expect(ok.statusCode).toBe(204);
    expect((await call(t.app, { url: "/api/v1/me", cookie: u.cookie })).statusCode).toBe(200);
    expect((await call(t.app, { url: "/api/v1/me", cookie: other })).statusCode).toBe(401);
    expect((await post("/api/v1/auth/login", { email: e, password: NEW_PASSWORD })).statusCode).toBe(200);
    expect((await post("/api/v1/auth/login", { email: e, password: STRONG_PASSWORD })).statusCode).toBe(401);
  });

  it("locks out repeated wrong current passwords (a hijacked session cannot brute-force it)", async () => {
    const e = email("chglock");
    const u = await register(t.app, e);
    for (let i = 0; i < 5; i++) {
      await post("/api/v1/auth/password/change", { currentPassword: "wrong-password-123", newPassword: NEW_PASSWORD }, u.cookie);
    }
    const blocked = await post("/api/v1/auth/password/change", { currentPassword: STRONG_PASSWORD, newPassword: NEW_PASSWORD }, u.cookie);
    expect(blocked.statusCode).toBe(429);
  });

  it("validates input, requires a session, and rejects a pending MFA session", async () => {
    const e = email("chgval");
    const u = await register(t.app, e);
    expect((await post("/api/v1/auth/password/change", { currentPassword: STRONG_PASSWORD, newPassword: "short" }, u.cookie)).statusCode).toBe(400);
    expect((await post("/api/v1/auth/password/change", { currentPassword: STRONG_PASSWORD, newPassword: NEW_PASSWORD })).statusCode).toBe(401);

    await markEmailVerified(t.db, u.userId);
    const { secret } = await enrollMfa(t.app, u.cookie);
    const pending = await login(t.app, e);
    const res = await post("/api/v1/auth/password/change", { currentPassword: STRONG_PASSWORD, newPassword: NEW_PASSWORD }, pending);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("mfa_required");
    expect((await post("/api/v1/auth/mfa/verify", { code: nextCode(secret) }, pending)).statusCode).toBe(200);
  });
});
