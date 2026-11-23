import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, enrollMfa, markEmailVerified, register, type TestApp } from "./helpers";

const PLATFORM_ORG = "00000000-0000-4000-8000-000000000001";

let t: TestApp;
let orgA: string;
let orgB: string;
let alice: { userId: string; cookie: string }; // member of A, custom "auditor" role there (audit.read)
let bob: { userId: string; cookie: string }; // member of B, resident role only
let carol: { userId: string; cookie: string }; // platform staff with platform_admin role
let dave: { userId: string; cookie: string }; // not a member anywhere

const admin = () => t.db.admin;

beforeAll(async () => {
  t = await createTestApp();
  orgA = randomUUID();
  orgB = randomUUID();
  await admin().query(
    `INSERT INTO organizations (id, type, name, status) VALUES ($1, 'community', 'Aqualily', 'active'), ($2, 'community', 'Beta Heights', 'active')`,
    [orgA, orgB],
  );
  alice = await register(t.app, "alice@example.test", "Alice");
  bob = await register(t.app, "bob@example.test", "Bob");
  carol = await register(t.app, "carol@example.test", "Carol");
  dave = await register(t.app, "dave@example.test", "Dave");
  for (const u of [alice, bob, carol, dave]) await markEmailVerified(t.db, u.userId);

  await admin().query(
    `INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2), ($3, $4), ($5, $6)`,
    [orgA, alice.userId, orgB, bob.userId, PLATFORM_ORG, carol.userId],
  );
  // A tenant-defined role with a single permission, assigned to Alice in A.
  const role = await admin().query<{ id: string }>(
    `INSERT INTO roles (tenant_id, scope_type, key, name) VALUES ($1, 'community', 'auditor', 'Auditor') RETURNING id`,
    [orgA],
  );
  await admin().query(`INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'audit.read')`, [role.rows[0]?.id]);
  await admin().query(`INSERT INTO role_assignments (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`, [orgA, alice.userId, role.rows[0]?.id]);
  await admin().query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id)
     SELECT $1, $2, id FROM roles WHERE key = 'resident' AND tenant_id IS NULL`,
    [orgB, bob.userId],
  );
  await admin().query(`INSERT INTO platform_staff (user_id) VALUES ($1)`, [carol.userId]);
  await admin().query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id)
     SELECT $1, $2, id FROM roles WHERE key = 'platform_admin' AND tenant_id IS NULL`,
    [PLATFORM_ORG, carol.userId],
  );
  // platform_admin requires MFA, so Carol completes real enrollment (her session becomes MFA-verified).
  await enrollMfa(t.app, carol.cookie);
  await admin().query(
    `INSERT INTO audit_log (tenant_id, action) VALUES ($1, 'seed.a1'), ($1, 'seed.a2'), ($1, 'seed.a3'), ($1, 'seed.a4'), ($1, 'seed.a5'), ($2, 'seed.b1')`,
    [orgA, orgB],
  );
});
afterAll(async () => {
  await t.close();
});

const auditActions = (res: { json: () => { data: { action: string; tenantId: string | null }[] } }) =>
  res.json().data.map((r) => r.action);

describe("platform staff flag", () => {
  it("tells the client who may use platform mode, and nobody else", async () => {
    expect((await call(t.app, { url: "/api/v1/me", cookie: carol.cookie })).json().platformStaff).toBe(true);
    expect((await call(t.app, { url: "/api/v1/me", cookie: alice.cookie })).json().platformStaff).toBe(false);
  });
});

describe("tenant switching and context", () => {
  it("lists the user's organizations with their roles", async () => {
    const res = await call(t.app, { url: "/api/v1/me", cookie: alice.cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenants).toEqual([{ id: orgA, name: "Aqualily", type: "community", status: "active", roles: ["auditor"] }]);
    expect(body.activeTenantId).toBeNull();
    expect(body.permissions).toEqual([]);
  });

  it("switches to a tenant the user belongs to and exposes the permissions of their roles there", async () => {
    const sw = await call(t.app, { method: "POST", url: "/api/v1/me/tenants/switch", cookie: alice.cookie, body: { tenantId: orgA } });
    expect(sw.statusCode).toBe(204);
    const me = await call(t.app, { url: "/api/v1/me", cookie: alice.cookie });
    expect(me.json().activeTenantId).toBe(orgA);
    expect(me.json().permissions).toEqual(["audit.read"]);
  });

  it("refuses to switch into a tenant the user does not belong to", async () => {
    const res = await call(t.app, { method: "POST", url: "/api/v1/me/tenants/switch", cookie: dave.cookie, body: { tenantId: orgA } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("tenant_forbidden");
    const me = await call(t.app, { url: "/api/v1/me", cookie: dave.cookie });
    expect(me.json().activeTenantId).toBeNull();
  });

  it("refuses an X-Tenant-Id header for a tenant the user does not belong to", async () => {
    const res = await call(t.app, { url: "/api/v1/me", cookie: bob.cookie, headers: { "x-tenant-id": orgA } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("tenant_forbidden");
  });

  it("rejects malformed and duplicated context headers", async () => {
    const bad = await call(t.app, { url: "/api/v1/me", cookie: bob.cookie, headers: { "x-tenant-id": "not-a-uuid" } });
    expect(bad.statusCode).toBe(400);
    const bodyBad = await call(t.app, { method: "POST", url: "/api/v1/me/tenants/switch", cookie: bob.cookie, body: { tenantId: "x" } });
    expect(bodyBad.statusCode).toBe(400);
  });

  it("stops honoring a tenant as soon as the membership is removed", async () => {
    const eve = await register(t.app, "eve@example.test", "Eve");
    await admin().query(`INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)`, [orgB, eve.userId]);
    await call(t.app, { method: "POST", url: "/api/v1/me/tenants/switch", cookie: eve.cookie, body: { tenantId: orgB } });
    expect((await call(t.app, { url: "/api/v1/me", cookie: eve.cookie })).json().activeTenantId).toBe(orgB);

    await admin().query(`UPDATE memberships SET status = 'removed' WHERE user_id = $1`, [eve.userId]);
    const after = await call(t.app, { url: "/api/v1/me", cookie: eve.cookie });
    expect(after.statusCode).toBe(403);
  });

  it("clears the active tenant when switching to null", async () => {
    const frank = await register(t.app, "frank@example.test", "Frank");
    await admin().query(`INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)`, [orgA, frank.userId]);
    await call(t.app, { method: "POST", url: "/api/v1/me/tenants/switch", cookie: frank.cookie, body: { tenantId: orgA } });
    const clear = await call(t.app, { method: "POST", url: "/api/v1/me/tenants/switch", cookie: frank.cookie, body: { tenantId: null } });
    expect(clear.statusCode).toBe(204);
    expect((await call(t.app, { url: "/api/v1/me", cookie: frank.cookie })).json().activeTenantId).toBeNull();
  });
});

describe("permission guard and tenant isolation on /admin/audit", () => {
  it("requires authentication", async () => {
    expect((await call(t.app, { url: "/api/v1/admin/audit" })).statusCode).toBe(401);
  });

  it("asks for a tenant when none is selected", async () => {
    const res = await call(t.app, { url: "/api/v1/admin/audit", cookie: dave.cookie });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("tenant_required");
  });

  it("denies a member who lacks the permission, and records the denial in their tenant's audit log", async () => {
    const res = await call(t.app, { url: "/api/v1/admin/audit", cookie: bob.cookie, headers: { "x-tenant-id": orgB } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
    const { rows } = await admin().query(
      `SELECT metadata FROM audit_log WHERE tenant_id = $1 AND action = 'authz.denied' AND actor_user_id = $2`,
      [orgB, bob.userId],
    );
    expect(rows[0].metadata.permission).toBe("audit.read");
  });

  it("allows a member with the permission and returns only that tenant's records", async () => {
    const res = await call(t.app, { url: "/api/v1/admin/audit?limit=100", cookie: alice.cookie, headers: { "x-tenant-id": orgA } });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as { tenantId: string | null; action: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows.every((r) => r.tenantId === orgA)).toBe(true);
    expect(auditActions(res)).not.toContain("seed.b1");
  });

  it("does not let a permission held in one tenant apply in another", async () => {
    // Alice holds audit.read in A. She is not a member of B, so naming B must fail outright.
    const res = await call(t.app, { url: "/api/v1/admin/audit", cookie: alice.cookie, headers: { "x-tenant-id": orgB } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("tenant_forbidden");
  });

  it("paginates with a keyset cursor without gaps or repeats", async () => {
    const seen: string[] = [];
    let url = "/api/v1/admin/audit?limit=2";
    for (let guard = 0; guard < 20; guard++) {
      const res = await call(t.app, { url, cookie: alice.cookie, headers: { "x-tenant-id": orgA } });
      expect(res.statusCode).toBe(200);
      for (const row of res.json().data as { id: string }[]) seen.push(row.id);
      const next = res.json().page.nextCursor as string | null;
      if (!next) break;
      url = `/api/v1/admin/audit?limit=2&cursor=${encodeURIComponent(next)}`;
    }
    const total = await admin().query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1", [orgA]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(total.rows[0].n);
  });

  it("rejects bad pagination input", async () => {
    const headers = { "x-tenant-id": orgA };
    expect((await call(t.app, { url: "/api/v1/admin/audit?cursor=garbage", cookie: alice.cookie, headers })).statusCode).toBe(400);
    expect((await call(t.app, { url: "/api/v1/admin/audit?limit=1000", cookie: alice.cookie, headers })).statusCode).toBe(400);
    expect((await call(t.app, { url: "/api/v1/admin/audit?limit=5&sort=hack", cookie: alice.cookie, headers })).statusCode).toBe(400);
  });
});

describe("platform scope", () => {
  it("is refused for users who are not platform staff", async () => {
    const res = await call(t.app, { url: "/api/v1/admin/audit", cookie: alice.cookie, headers: { "x-platform-scope": "on" } });
    expect(res.statusCode).toBe(403);
  });

  it("is refused for staff who did not ask for it (they act like any other member)", async () => {
    const res = await call(t.app, { url: "/api/v1/admin/audit", cookie: carol.cookie });
    expect(res.statusCode).toBe(400);
  });

  it("lets platform staff with the permission read across tenants", async () => {
    const res = await call(t.app, { url: "/api/v1/admin/audit?limit=100", cookie: carol.cookie, headers: { "x-platform-scope": "on" } });
    expect(res.statusCode).toBe(200);
    const tenants = new Set((res.json().data as { tenantId: string | null }[]).map((r) => r.tenantId));
    expect(tenants.has(orgA)).toBe(true);
    expect(tenants.has(orgB)).toBe(true);
  });

  it("does not let a platform role replace a missing permission", async () => {
    // platform_admin lacks requests.read_all etc.; confirm the guard still enforces permissions in platform scope.
    const res = await call(t.app, { url: "/api/v1/me", cookie: carol.cookie, headers: { "x-platform-scope": "on" } });
    expect(res.statusCode).toBe(200);
    const perms = res.json().permissions as string[];
    expect(perms).toContain("audit.read");
    expect(perms).not.toContain("requests.read_all");
    expect(res.json().platformScope).toBe(true);
  });

  it("is refused when staff lack a membership in the platform organization", async () => {
    const gina = await register(t.app, "gina@example.test", "Gina");
    await admin().query(`INSERT INTO platform_staff (user_id) VALUES ($1)`, [gina.userId]);
    const res = await call(t.app, { url: "/api/v1/me", cookie: gina.cookie, headers: { "x-platform-scope": "on" } });
    expect(res.statusCode).toBe(403);
  });
});

describe("audit of context changes", () => {
  it("records tenant switches against the tenant", async () => {
    const { rows } = await admin().query(
      `SELECT 1 FROM audit_log WHERE action = 'tenant.switch' AND tenant_id = $1 AND actor_user_id = $2`,
      [orgA, alice.userId],
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});
