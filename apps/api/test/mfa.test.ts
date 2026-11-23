import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totpAt } from "../src/auth/totp";
import {
  call,
  clearReplayGuard,
  createTestApp,
  enrollMfa,
  login,
  markEmailVerified,
  nextCode,
  register,
  STRONG_PASSWORD,
  type TestApp,
} from "./helpers";

const PLATFORM_ORG = "00000000-0000-4000-8000-000000000001";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

let n = 0;
const email = (p: string) => `${p}${++n}@example.test`;
const post = (url: string, cookie: string | undefined, body?: unknown) =>
  call(t.app, { method: "POST", url, ...(cookie ? { cookie } : {}), ...(body !== undefined ? { body } : {}) });

async function newVerifiedUser(prefix: string) {
  const e = email(prefix);
  const u = await register(t.app, e);
  await markEmailVerified(t.db, u.userId);
  return { ...u, email: e };
}

describe("MFA enrollment", () => {
  it("returns a secret and otpauth URI, stores the secret encrypted, and stays inactive until confirmed", async () => {
    const u = await newVerifiedUser("enr");
    const res = await post("/api/v1/auth/mfa/enroll/start", u.cookie);
    expect(res.statusCode).toBe(200);
    const { secret, otpauthUri } = res.json();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/u);
    expect(otpauthUri).toContain("otpauth://totp/Kidos");
    expect(otpauthUri).toContain(`secret=${secret}`);

    const row = await t.db.admin.query("SELECT secret_encrypted, confirmed_at FROM mfa_credentials WHERE user_id = $1", [u.userId]);
    expect(row.rows[0].secret_encrypted).not.toContain(secret);
    expect(row.rows[0].secret_encrypted.startsWith("v1.")).toBe(true);
    expect(row.rows[0].confirmed_at).toBeNull();

    // Not enforced yet: a new login is a normal, complete session.
    const l = await call(t.app, { method: "POST", url: "/api/v1/auth/login", body: { email: u.email, password: STRONG_PASSWORD } });
    expect(l.json().mfaRequired).toBe(false);
  });

  it("rejects a wrong confirmation code and counts the failure", async () => {
    const u = await newVerifiedUser("wrong");
    await post("/api/v1/auth/mfa/enroll/start", u.cookie);
    const res = await post("/api/v1/auth/mfa/enroll/confirm", u.cookie, { code: "000000" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_code");
    const row = await t.db.admin.query("SELECT failed_attempts, confirmed_at FROM mfa_credentials WHERE user_id = $1", [u.userId]);
    expect(row.rows[0].failed_attempts).toBe(1);
    expect(row.rows[0].confirmed_at).toBeNull();
  });

  it("requires enrollment to be started first, and validates the code format", async () => {
    const u = await newVerifiedUser("order");
    expect((await post("/api/v1/auth/mfa/enroll/confirm", u.cookie, { code: "123456" })).statusCode).toBe(409);
    expect((await post("/api/v1/auth/mfa/enroll/confirm", u.cookie, { code: "12ab56" })).statusCode).toBe(400);
    expect((await post("/api/v1/auth/mfa/enroll/confirm", u.cookie, { code: "123456", extra: 1 })).statusCode).toBe(400);
  });

  it("activates MFA on a correct code, issues 10 hashed recovery codes, and ends other sessions", async () => {
    const u = await newVerifiedUser("act");
    const other = await login(t.app, u.email); // a second, pre-MFA session
    const { recoveryCodes } = await enrollMfa(t.app, u.cookie);

    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const c of recoveryCodes) expect(c).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/u);

    const stored = await t.db.admin.query("SELECT code_hash FROM mfa_recovery_codes WHERE user_id = $1", [u.userId]);
    expect(stored.rows).toHaveLength(10);
    const dump = JSON.stringify(stored.rows);
    for (const c of recoveryCodes) expect(dump).not.toContain(c.replace(/-/gu, ""));

    expect((await call(t.app, { url: "/api/v1/me", cookie: other })).statusCode).toBe(401); // old session revoked
    const me = await call(t.app, { url: "/api/v1/me", cookie: u.cookie });
    expect(me.statusCode).toBe(200);
    expect(me.json().mfaEnabled).toBe(true);
  });

  it("refuses to start enrollment again once enabled", async () => {
    const u = await newVerifiedUser("again");
    await enrollMfa(t.app, u.cookie);
    const res = await post("/api/v1/auth/mfa/enroll/start", u.cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("mfa_already_enabled");
  });

  it("requires a session for every MFA endpoint", async () => {
    for (const path of ["enroll/start", "enroll/confirm", "verify", "disable"]) {
      expect((await post(`/api/v1/auth/mfa/${path}`, undefined, { code: "123456" })).statusCode).toBe(401);
    }
  });
});

describe("MFA at login", () => {
  it("leaves a password-only session pending: nothing works except verifying or logging out", async () => {
    const u = await newVerifiedUser("pend");
    const { secret } = await enrollMfa(t.app, u.cookie);

    const l = await call(t.app, { method: "POST", url: "/api/v1/auth/login", body: { email: u.email, password: STRONG_PASSWORD } });
    expect(l.statusCode).toBe(200);
    expect(l.json().mfaRequired).toBe(true);
    const pending = l.cookies.find((c) => c.name === "kidos_sid")?.value ?? "";

    for (const url of ["/api/v1/me", "/api/v1/me/sessions", "/api/v1/admin/audit"]) {
      const r = await call(t.app, { url, cookie: pending });
      expect(r.statusCode, url).toBe(401);
      expect(r.json().error.code, url).toBe("mfa_required");
    }
    expect((await post("/api/v1/me/tenants/switch", pending, { tenantId: null })).statusCode).toBe(401);
    expect((await post("/api/v1/auth/mfa/enroll/start", pending)).statusCode).toBe(401);

    const bad = await post("/api/v1/auth/mfa/verify", pending, { code: "000000" });
    expect(bad.statusCode).toBe(400);
    expect((await call(t.app, { url: "/api/v1/me", cookie: pending })).statusCode).toBe(401);

    const ok = await post("/api/v1/auth/mfa/verify", pending, { code: nextCode(secret) });
    expect(ok.statusCode).toBe(200);
    expect((await call(t.app, { url: "/api/v1/me", cookie: pending })).statusCode).toBe(200);
  });

  it("allows a pending session to log out", async () => {
    const u = await newVerifiedUser("pendout");
    await enrollMfa(t.app, u.cookie);
    const pending = await login(t.app, u.email);
    expect((await post("/api/v1/auth/logout", pending)).statusCode).toBe(204);
    expect((await post("/api/v1/auth/mfa/verify", pending, { code: "123456" })).statusCode).toBe(401);
  });

  it("does not accept a code twice (replay protection)", async () => {
    const u = await newVerifiedUser("replay");
    const { secret } = await enrollMfa(t.app, u.cookie);
    const s1 = await login(t.app, u.email);
    const s2 = await login(t.app, u.email);
    const code = nextCode(secret);
    expect((await post("/api/v1/auth/mfa/verify", s1, { code })).statusCode).toBe(200);
    const again = await post("/api/v1/auth/mfa/verify", s2, { code });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe("invalid_code");
  });

  it("rejects a code from the enrollment step itself (already consumed)", async () => {
    const u = await newVerifiedUser("enrstep");
    const { secret } = await enrollMfa(t.app, u.cookie);
    const pending = await login(t.app, u.email);
    const res = await post("/api/v1/auth/mfa/verify", pending, { code: totpAt(secret, Date.now()) });
    expect(res.statusCode).toBe(400);
  });

  it("accepts a recovery code once, in any case or dash style, and reports how many remain", async () => {
    const u = await newVerifiedUser("rec");
    const { recoveryCodes } = await enrollMfa(t.app, u.cookie);
    const s1 = await login(t.app, u.email);
    const first = recoveryCodes[0] ?? "";
    const ok = await post("/api/v1/auth/mfa/verify", s1, { recoveryCode: first.toLowerCase().replace(/-/gu, " ") });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().recoveryCodesRemaining).toBe(9);

    const s2 = await login(t.app, u.email);
    const reuse = await post("/api/v1/auth/mfa/verify", s2, { recoveryCode: first });
    expect(reuse.statusCode).toBe(400);
    const another = await post("/api/v1/auth/mfa/verify", s2, { recoveryCode: recoveryCodes[1] });
    expect(another.statusCode).toBe(200);
    expect(another.json().recoveryCodesRemaining).toBe(8);
  });

  it("locks verification after repeated wrong codes, even for the right one", async () => {
    const u = await newVerifiedUser("mlock");
    const { secret } = await enrollMfa(t.app, u.cookie);
    const pending = await login(t.app, u.email);
    for (let i = 0; i < 5; i++) {
      expect((await post("/api/v1/auth/mfa/verify", pending, { code: "000000" })).statusCode).toBe(400);
    }
    const blocked = await post("/api/v1/auth/mfa/verify", pending, { code: nextCode(secret) });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("too_many_attempts");
    expect((await call(t.app, { url: "/api/v1/me", cookie: pending })).statusCode).toBe(401);

    await clearReplayGuard(t.db, u.userId);
    expect((await post("/api/v1/auth/mfa/verify", pending, { code: nextCode(secret) })).statusCode).toBe(200);
  });

  it("rejects verify bodies that are ambiguous or malformed", async () => {
    const u = await newVerifiedUser("body");
    await enrollMfa(t.app, u.cookie);
    const pending = await login(t.app, u.email);
    for (const body of [{}, { code: "123456", recoveryCode: "AAAA-BBBB-CCCC" }, { code: 123456 }, { recoveryCode: "x" }]) {
      expect((await post("/api/v1/auth/mfa/verify", pending, body)).statusCode).toBe(400);
    }
  });

  it("says MFA is not enabled when the user never enrolled", async () => {
    const u = await newVerifiedUser("none");
    const res = await post("/api/v1/auth/mfa/verify", u.cookie, { code: "123456" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("mfa_not_enabled");
  });

  it("audits enrollment, verification and failures without secrets", async () => {
    const u = await newVerifiedUser("maud");
    const { secret, recoveryCodes } = await enrollMfa(t.app, u.cookie);
    const pending = await login(t.app, u.email);
    await post("/api/v1/auth/mfa/verify", pending, { code: "000000" });
    await post("/api/v1/auth/mfa/verify", pending, { code: nextCode(secret) });
    const { rows } = await t.db.admin.query("SELECT action, metadata FROM audit_log WHERE actor_user_id = $1", [u.userId]);
    const actions = rows.map((r) => r.action);
    for (const a of ["auth.mfa_enrollment_started", "auth.mfa_enrolled", "auth.login_password_ok", "auth.mfa_failed", "auth.mfa_verified"]) {
      expect(actions).toContain(a);
    }
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(secret.toString("hex"));
    for (const c of recoveryCodes) expect(dump).not.toContain(c);
  });
});

describe("MFA disable", () => {
  it("needs the password and a current code, then removes MFA and ends other sessions", async () => {
    const u = await newVerifiedUser("dis");
    const { secret } = await enrollMfa(t.app, u.cookie);
    const other = await login(t.app, u.email);
    await post("/api/v1/auth/mfa/verify", other, { code: nextCode(secret) });

    const wrongPw = await post("/api/v1/auth/mfa/disable", u.cookie, { password: "not-the-password-1", code: nextCode(secret, -1) });
    expect(wrongPw.statusCode).toBe(400);
    expect(wrongPw.json().error.code).toBe("incorrect_password");

    const wrongCode = await post("/api/v1/auth/mfa/disable", u.cookie, { password: STRONG_PASSWORD, code: "000000" });
    expect(wrongCode.statusCode).toBe(400);

    await clearReplayGuard(t.db, u.userId);
    const ok = await post("/api/v1/auth/mfa/disable", u.cookie, { password: STRONG_PASSWORD, code: nextCode(secret) });
    expect(ok.statusCode).toBe(204);
    expect((await call(t.app, { url: "/api/v1/me", cookie: other })).statusCode).toBe(401);
    expect((await call(t.app, { url: "/api/v1/me", cookie: u.cookie })).json().mfaEnabled).toBe(false);
    const l = await call(t.app, { method: "POST", url: "/api/v1/auth/login", body: { email: u.email, password: STRONG_PASSWORD } });
    expect(l.json().mfaRequired).toBe(false);
    const left = await t.db.admin.query("SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1", [u.userId]);
    expect(left.rows[0].n).toBe(0);
  });

  it("is refused when a role of the user requires MFA", async () => {
    const u = await newVerifiedUser("req");
    const { secret } = await enrollMfa(t.app, u.cookie);
    await t.db.admin.query(`INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [PLATFORM_ORG, u.userId]);
    await t.db.admin.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'business_operations' AND tenant_id IS NULL`,
      [PLATFORM_ORG, u.userId],
    );
    const res = await post("/api/v1/auth/mfa/disable", u.cookie, { password: STRONG_PASSWORD, code: nextCode(secret) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("mfa_required_by_role");
    expect((await call(t.app, { url: "/api/v1/me", cookie: u.cookie })).json().mfaEnabled).toBe(true);
  });
});

describe("role-driven requirements on guarded routes", () => {
  async function staffMember(prefix: string, opts: { verified: boolean }) {
    const e = email(prefix);
    const u = await register(t.app, e);
    if (opts.verified) await markEmailVerified(t.db, u.userId);
    await t.db.admin.query(`INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)`, [PLATFORM_ORG, u.userId]);
    await t.db.admin.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'platform_admin' AND tenant_id IS NULL`,
      [PLATFORM_ORG, u.userId],
    );
    return { ...u, email: e };
  }
  const guarded = (cookie: string) => call(t.app, { url: "/api/v1/admin/audit", cookie, headers: { "x-tenant-id": PLATFORM_ORG } });

  it("blocks an MFA-requiring role until the user enrolls, then allows access", async () => {
    const u = await staffMember("staff1", { verified: true });
    const blocked = await guarded(u.cookie);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("mfa_enrollment_required");

    const me = await call(t.app, { url: "/api/v1/me", cookie: u.cookie, headers: { "x-tenant-id": PLATFORM_ORG } });
    expect(me.json().mfaEnrollmentRequired).toBe(true); // the UI can route them to enrollment

    await enrollMfa(t.app, u.cookie);
    expect((await guarded(u.cookie)).statusCode).toBe(200);
  });

  it("requires a verified email before any permission-guarded action", async () => {
    const u = await staffMember("staff2", { verified: false });
    await enrollMfa(t.app, u.cookie);
    const res = await guarded(u.cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("email_verification_required");
    await markEmailVerified(t.db, u.userId);
    expect((await guarded(u.cookie)).statusCode).toBe(200);
  });

  it("keeps a staff member without MFA out even after a fresh password login", async () => {
    const u = await staffMember("staff3", { verified: true });
    const cookie = await login(t.app, u.email);
    expect((await guarded(cookie)).json().error.code).toBe("mfa_enrollment_required");
  });

  it("does not demand MFA from roles that do not require it", async () => {
    const e = email("plain");
    const u = await register(t.app, e);
    await markEmailVerified(t.db, u.userId);
    const orgId = randomUUID();
    await t.db.admin.query(`INSERT INTO organizations (id, type, name, status) VALUES ($1, 'community', 'Plain Org', 'active')`, [orgId]);
    await t.db.admin.query(`INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)`, [orgId, u.userId]);
    const role = await t.db.admin.query<{ id: string }>(
      `INSERT INTO roles (tenant_id, scope_type, key, name) VALUES ($1, 'community', 'viewer_x', 'Viewer') RETURNING id`,
      [orgId],
    );
    await t.db.admin.query(`INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'audit.read')`, [role.rows[0]?.id]);
    await t.db.admin.query(`INSERT INTO role_assignments (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`, [orgId, u.userId, role.rows[0]?.id]);
    const res = await call(t.app, { url: "/api/v1/admin/audit", cookie: u.cookie, headers: { "x-tenant-id": orgId } });
    expect(res.statusCode).toBe(200);
  });
});
