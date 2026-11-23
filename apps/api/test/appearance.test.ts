import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, makeMember, makeStaff, markEmailVerified, PLATFORM_SCOPE, register, type TestApp } from "./helpers";

/** Appearance (migration 0018): a person's theme, and a community's palette set by its administrators. */
let t: TestApp;
let a: string;
let b: string;
let seq = 0;
const email = (p: string) => `${p}${++seq}@appearance.test`;

async function community(name: string): Promise<string> {
  const id = randomUUID();
  await t.db.admin.query("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'community', $2, 'active')", [id, name]);
  await t.db.admin.query("INSERT INTO community_profiles (tenant_id) VALUES ($1)", [id]);
  return id;
}

beforeAll(async () => {
  t = await createTestApp();
  a = await community("Palette A");
  b = await community("Palette B");
});
afterAll(async () => {
  await t.close();
});

describe("PUT /me/appearance", () => {
  it("saves a person's choice and returns it from /me; a second save updates it", async () => {
    const u = await register(t.app, email("me"));
    const me0 = await call(t.app, { url: "/api/v1/me", cookie: u.cookie });
    expect(me0.json().appearance).toEqual({ themeMode: "system", palette: null, communityPalette: null });

    expect((await call(t.app, { method: "PUT", url: "/api/v1/me/appearance", cookie: u.cookie, body: { themeMode: "dark", palette: "ocean" } })).statusCode).toBe(200);
    expect((await call(t.app, { method: "PUT", url: "/api/v1/me/appearance", cookie: u.cookie, body: { themeMode: "light", palette: null } })).statusCode).toBe(200);
    const me = await call(t.app, { url: "/api/v1/me", cookie: u.cookie });
    expect(me.json().appearance).toMatchObject({ themeMode: "light", palette: null });
  });

  it("rejects unknown palettes, modes and extra fields, and anonymous callers", async () => {
    const u = await register(t.app, email("bad"));
    for (const body of [{ themeMode: "dark", palette: "neon" }, { themeMode: "sepia", palette: null }, { themeMode: "dark", palette: null, userId: randomUUID() }]) {
      expect((await call(t.app, { method: "PUT", url: "/api/v1/me/appearance", cookie: u.cookie, body })).statusCode).toBe(400);
    }
    expect((await call(t.app, { method: "PUT", url: "/api/v1/me/appearance", body: { themeMode: "dark", palette: null } })).statusCode).toBe(401);
  });
});

describe("community branding", () => {
  it("an administrator sets the palette; members of that community receive it through /me; the change is audited", async () => {
    const admin = await makeMember(t, email("adm"), a, ["community_admin"]);
    const resident = await makeMember(t, email("res"), a, ["resident"]);
    const ctx = { cookie: admin.cookie, headers: { "x-tenant-id": a } };

    const before = await call(t.app, { url: `/api/v1/communities/${a}/branding`, ...ctx });
    expect(before.json()).toMatchObject({ palette: "classic", isDefault: true });

    const res = await call(t.app, { method: "PUT", url: `/api/v1/communities/${a}/branding`, ...ctx, body: { palette: "forest" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ palette: "forest", isDefault: false, updatedBy: "Member community_admin" });

    const me = await call(t.app, { url: "/api/v1/me", cookie: resident.cookie, headers: { "x-tenant-id": a } });
    expect(me.json().appearance.communityPalette).toBe("forest");

    const audit = await t.db.admin.query("SELECT metadata FROM audit_log WHERE tenant_id = $1 AND action = 'community.branding_changed'", [a]);
    expect(audit.rows).toEqual([{ metadata: { palette: "forest" } }]);
  });

  it("a resident (no communities.update) cannot change it", async () => {
    const resident = await makeMember(t, email("res2"), a, ["resident"]);
    const res = await call(t.app, { method: "PUT", url: `/api/v1/communities/${a}/branding`, cookie: resident.cookie, headers: { "x-tenant-id": a }, body: { palette: "ocean" } });
    expect(res.statusCode).toBe(403);
  });

  it("an administrator of one community cannot read or change another's (404, not a hint that it exists)", async () => {
    const adminB = await makeMember(t, email("admB"), b, ["community_admin"]);
    const ctx = { cookie: adminB.cookie, headers: { "x-tenant-id": b } };
    expect((await call(t.app, { url: `/api/v1/communities/${a}/branding`, ...ctx })).statusCode).toBe(404);
    expect((await call(t.app, { method: "PUT", url: `/api/v1/communities/${a}/branding`, ...ctx, body: { palette: "ocean" } })).statusCode).toBe(404);
    const stored = await t.db.admin.query("SELECT palette FROM community_branding WHERE tenant_id = $1", [a]);
    expect(stored.rows[0].palette).toBe("forest");
  });

  it("a member of another community does not receive this community's palette", async () => {
    const outsider = await makeMember(t, email("out"), b, ["resident"]);
    const me = await call(t.app, { url: "/api/v1/me", cookie: outsider.cookie, headers: { "x-tenant-id": b } });
    expect(me.json().appearance.communityPalette).toBeNull();
  });

  it("platform staff in platform scope can set any community's palette; unknown palettes are refused", async () => {
    const ops = await makeStaff(t, email("ops"), "business_operations");
    const ctx = { cookie: ops.cookie, headers: PLATFORM_SCOPE };
    expect((await call(t.app, { method: "PUT", url: `/api/v1/communities/${b}/branding`, ...ctx, body: { palette: "ocean" } })).statusCode).toBe(200);
    expect((await call(t.app, { method: "PUT", url: `/api/v1/communities/${b}/branding`, ...ctx, body: { palette: "#ff0000" } })).statusCode).toBe(400);
  });

  it("an unverified, plain account cannot reach the route", async () => {
    const u = await register(t.app, email("plain"));
    await markEmailVerified(t.db, u.userId);
    expect((await call(t.app, { method: "PUT", url: `/api/v1/communities/${a}/branding`, cookie: u.cookie, headers: { "x-tenant-id": a }, body: { palette: "ocean" } })).statusCode).toBe(403);
  });
});
