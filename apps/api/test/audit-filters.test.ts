import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, makeMember, makeStaff, PLATFORM_SCOPE, type TestApp } from "./helpers";

/** Audit log filters: by area and by time. They narrow what the caller may already read; they never widen it. */
let t: TestApp;
let boss: { cookie: string };
const marker = randomUUID();

const read = async (qs: string, who = boss, headers: Record<string, string> = PLATFORM_SCOPE) => {
  const res = await call(t.app, { url: `/api/v1/admin/audit?limit=100&${qs}`, cookie: who.cookie, headers });
  return { status: res.statusCode, rows: res.statusCode === 200 ? (res.json().data as { action: string; entityId: string | null }[]) : [] };
};

beforeAll(async () => {
  t = await createTestApp();
  boss = await makeStaff(t, "boss@auditfilters.test", "platform_admin");
  // Rows carrying a marker id, so each filter can be checked exactly whatever else the suite wrote.
  await t.db.admin.query(
    `INSERT INTO audit_log (action, entity_id, created_at) VALUES
       ('community.updated', $1, now()), ('membership.invite_created', $1, now()), ('auth.login_failed', $1, now()),
       ('vendor.updated', $1, now()), ('request.created', $1, now()), ('community.policy_changed', $1, now() - interval '10 days')`,
    [marker],
  );
});
afterAll(async () => {
  await t.close();
});

const mine = (rows: { action: string; entityId: string | null }[]) => rows.filter((r) => r.entityId === marker).map((r) => r.action).sort();

describe("audit log filters", () => {
  it("filters by area", async () => {
    expect(mine((await read("area=community")).rows)).toEqual(["community.policy_changed", "community.updated"]);
    expect(mine((await read("area=members")).rows)).toEqual(["membership.invite_created"]);
    expect(mine((await read("area=security")).rows)).toEqual(["auth.login_failed"]);
    const all = (await read("area=requests")).rows;
    expect(all.every((r) => /^(request|inquiry|quote|booking|payment|review)\./u.test(r.action))).toBe(true);
  });

  it("filters by time, and combines with area", async () => {
    expect(mine((await read("days=7")).rows)).toEqual(["auth.login_failed", "community.updated", "membership.invite_created", "request.created", "vendor.updated"]);
    expect(mine((await read("area=community&days=7")).rows)).toEqual(["community.updated"]);
    expect(mine((await read("area=community&days=30")).rows)).toEqual(["community.policy_changed", "community.updated"]);
  });

  it("refuses unknown areas, odd time spans and extra parameters", async () => {
    for (const qs of ["area=everything", "days=3", "days=-1", "action=auth.%25", "area=community%27--"]) {
      expect((await read(qs)).status, qs).toBe(400);
    }
  });

  it("still needs audit.read: a community administrator without it is refused, filter or not", async () => {
    const id = randomUUID();
    await t.db.admin.query("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'community', 'Audit Filter Town', 'active')", [id]);
    const admin = await makeMember(t, "adm@auditfilters.test", id, ["community_admin"]);
    expect((await read("area=security", admin, { "x-tenant-id": id })).status).toBe(403);
  });
});
