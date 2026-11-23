import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, makeMember, makeStaff, PLATFORM_SCOPE, type TestApp } from "./helpers";

/** Community banners (migration 0020): administrators announce, members see only what is showing now. */
let t: TestApp;
let seq = 0;
const email = (p: string) => `${p}${++seq}@banners.test`;

async function activeCommunity(name: string): Promise<string> {
  const id = randomUUID();
  await t.db.admin.query("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'community', $2, 'active')", [id, name]);
  await t.db.admin.query("INSERT INTO community_profiles (tenant_id) VALUES ($1)", [id]);
  return id;
}
const ctx = (who: { cookie: string }, id: string) => ({ cookie: who.cookie, headers: { "x-tenant-id": id } });
const isoDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

let a: string;
let b: string;
let admin: { cookie: string; userId: string };
let resident: { cookie: string; userId: string };
const create = (who: { cookie: string }, id: string, body: Record<string, unknown>) =>
  call(t.app, { method: "POST", url: `/api/v1/communities/${id}/banners`, body, ...ctx(who, id) });
const showing = async (who: { cookie: string }, id: string) =>
  ((await call(t.app, { url: "/api/v1/me/banners", ...ctx(who, id) })).json().data as { title: string }[]).map((x) => x.title).sort();

beforeAll(async () => {
  t = await createTestApp();
  a = await activeCommunity("Banner Bay");
  b = await activeCommunity("Other Bay");
  admin = await makeMember(t, email("adm"), a, ["community_admin"]);
  resident = await makeMember(t, email("res"), a, ["resident"]);
});
afterAll(async () => {
  await t.close();
});

describe("community banners", () => {
  it("an administrator creates banners; members see only those switched on and inside their dates", async () => {
    const now = await create(admin, a, { title: "Diwali party on Saturday", message: "Clubhouse, 6 pm.", picture: "bannerCandles", linkPath: "/app/catalog", linkLabel: "See activities" });
    expect(now.statusCode, now.body).toBe(201);
    expect(now.json()).toMatchObject({ title: "Diwali party on Saturday", picture: "bannerCandles", active: true, linkPath: "/app/catalog" });
    expect((await create(admin, a, { title: "Draft notice", active: false })).statusCode).toBe(201);
    expect((await create(admin, a, { title: "Next month", startsOn: isoDay(30) })).statusCode).toBe(201);
    expect((await create(admin, a, { title: "Last week", startsOn: isoDay(-10), endsOn: isoDay(-3) })).statusCode).toBe(201);

    expect(await showing(resident, a)).toEqual(["Diwali party on Saturday"]);
    expect(await showing(admin, a)).toEqual(["Diwali party on Saturday"]); // Home shows what residents see
    const all = (await call(t.app, { url: `/api/v1/communities/${a}/banners`, ...ctx(admin, a) })).json().data as unknown[];
    expect(all).toHaveLength(4); // the management list shows everything

    const audit = await t.db.admin.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'community.banner_created'", [a]);
    expect(audit.rows[0].n).toBe(4);
  });

  it("switching a banner off hides it at once; deleting removes it; both are audited", async () => {
    const created = (await create(admin, a, { title: "Pool closed" })).json() as { id: string };
    expect(await showing(resident, a)).toContain("Pool closed");
    const off = await call(t.app, { method: "PATCH", url: `/api/v1/communities/${a}/banners/${created.id}`, body: { active: false }, ...ctx(admin, a) });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ title: "Pool closed", active: false }); // a patch keeps the other fields
    expect(await showing(resident, a)).not.toContain("Pool closed");
    expect((await call(t.app, { method: "DELETE", url: `/api/v1/communities/${a}/banners/${created.id}`, ...ctx(admin, a) })).statusCode).toBe(204);
    const actions = await t.db.admin.query("SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY created_at", [created.id]);
    expect(actions.rows.map((r) => r.action)).toEqual(["community.banner_created", "community.banner_changed", "community.banner_deleted"]);
  });

  it("refuses links outside the app, unknown pictures, half a link, and dates in the wrong order", async () => {
    for (const body of [
      { title: "x", linkPath: "https://evil.example/login", linkLabel: "Sign in" },
      { title: "x", linkPath: "//evil.example", linkLabel: "Go" },
      { title: "x", linkPath: "/app/../../etc", linkLabel: "Go" },
      { title: "x", picture: "https://evil.example/a.jpg" },
      { title: "x", linkPath: "/app/catalog" },
      { title: "x", startsOn: isoDay(5), endsOn: isoDay(1) },
      { title: "" },
      { title: "x", tenantId: b },
    ]) {
      expect((await create(admin, a, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it("a resident cannot manage banners; another community's administrator gets 404; members elsewhere see nothing", async () => {
    expect((await create(resident, a, { title: "Sneaky" })).statusCode).toBe(403);
    expect((await call(t.app, { url: `/api/v1/communities/${a}/banners`, ...ctx(resident, a) })).statusCode).toBe(403);
    const adminB = await makeMember(t, email("admB"), b, ["community_admin"]);
    // acting in their own community B, addressing community A
    expect((await call(t.app, { method: "POST", url: `/api/v1/communities/${a}/banners`, body: { title: "Cross" }, ...ctx(adminB, b) })).statusCode).toBe(404);
    expect((await call(t.app, { url: `/api/v1/communities/${a}/banners`, ...ctx(adminB, b) })).statusCode).toBe(404);
    expect((await call(t.app, { url: `/api/v1/communities/${a}/banners`, ...ctx(adminB, a) })).statusCode).toBe(403); // not a member of A at all
    const bannerId = ((await call(t.app, { url: `/api/v1/communities/${a}/banners`, ...ctx(admin, a) })).json().data as { id: string }[])[0]?.id;
    expect((await call(t.app, { method: "DELETE", url: `/api/v1/communities/${a}/banners/${bannerId}`, ...ctx(adminB, b) })).statusCode).toBe(404);
    const residentB = await makeMember(t, email("resB"), b, ["resident"]);
    expect(await showing(residentB, b)).toEqual([]);
  });

  it("platform staff in platform scope can manage any community's banners, but see none on their own Home", async () => {
    const ops = await makeStaff(t, email("ops"), "business_operations");
    const res = await call(t.app, { method: "POST", url: `/api/v1/communities/${b}/banners`, body: { title: "Welcome to Other Bay" }, cookie: ops.cookie, headers: PLATFORM_SCOPE });
    expect(res.statusCode, res.body).toBe(201);
    expect((await call(t.app, { url: "/api/v1/me/banners", cookie: ops.cookie, headers: PLATFORM_SCOPE })).json().data).toEqual([]);
  });
});
