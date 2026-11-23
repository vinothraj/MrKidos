import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withContext } from "../src/context";
import { createTestDb, type TestDb } from "../src/testing";

/** Safety and conduct concerns: private to the reporter and the platform team, attacked the way a hostile client would. */
const PLATFORM_ORG = "00000000-0000-4000-8000-000000000001";
let db: TestDb;
const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);

let community: string;
let shown: string; // a vendor the community shows
let hidden: string; // a vendor the community has not approved
let alice: string; // resident, the reporter
let bob: string; // resident, same community
let carol: string; // community administrator
let owner: string; // owner of the shown vendor
let ops: string; // platform operations (may manage concerns)
let pat: string; // platform staff WITHOUT concerns.manage
let eve: string; // a member with no role

const REPORTER = ["concerns.create", "catalog.read"];
const MANAGE = ["concerns.manage", "vendors.read"];
const asReporter = (userId: string, tenantId = community, permissions = REPORTER) => ({ tenantId, userId, permissions });
const asOps = (permissions = MANAGE) => ({ tenantId: community, userId: ops, platformScope: true, permissions });

async function user(name: string): Promise<string> {
  const id = randomUUID();
  await q("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)", [id, `${name}@concern.test`, name]);
  return id;
}
async function member(org: string, userId: string, role: string): Promise<void> {
  await q("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [org, userId]);
  await q("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = $3 AND tenant_id IS NULL", [org, userId, role]);
}

const report = (userId: string, over: { category?: string; vendor?: string | null; status?: string; resolution?: string | null; tenant?: string; as?: string; ctx?: Parameters<typeof withContext>[1] } = {}) =>
  withContext(db.app, over.ctx ?? asReporter(userId), async (c) => {
    // No RETURNING on purpose: RETURNING also has to pass the SELECT policy, which would stop a forged row by itself and hide
    // a missing INSERT rule. The id is chosen here so the test can still name the row.
    const id = randomUUID();
    await c.query(
      "INSERT INTO concerns (id, tenant_id, reporter_id, category, vendor_id, subject, details, status, resolution) VALUES ($1, $2, $3, $4, $5, 'Subject', 'Details', $6, $7)",
      [id, over.tenant ?? community, over.as ?? userId, over.category ?? "child_safety", over.vendor ?? null, over.status ?? "open", over.resolution ?? null],
    );
    return id;
  });
const visible = (ctx: Parameters<typeof withContext>[1]) => withContext(db.app, ctx, async (c) => (await c.query("SELECT id FROM concerns ORDER BY created_at, id")).rows.map((r) => r.id as string));
const decide = (ctx: Parameters<typeof withContext>[1], id: string, status: string, resolution: string | null = null) =>
  withContext(db.app, ctx, (c) => c.query("UPDATE concerns SET status = $2, resolution = $3 WHERE id = $1", [id, status, resolution]));

beforeAll(async () => {
  db = await createTestDb();
  [community, shown, hidden] = [randomUUID(), randomUUID(), randomUUID()];
  await q("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'community', 'Concern Heights', 'active')", [community]);
  await q("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'vendor', 'Shown Vendor', 'active'), ($2, 'vendor', 'Hidden Vendor', 'active')", [shown, hidden]);
  [alice, bob, carol, owner, ops, pat, eve] = (await Promise.all(["alice", "bob", "carol", "owner", "ops", "pat", "eve"].map(user))) as [string, string, string, string, string, string, string];
  await member(community, alice, "resident");
  await member(community, bob, "resident");
  await member(community, carol, "community_admin");
  await q("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [community, eve]); // a member with no role, so no permissions
  await member(shown, owner, "vendor_owner");
  await q("INSERT INTO platform_staff (user_id) VALUES ($1), ($2)", [ops, pat]);
  await member(PLATFORM_ORG, ops, "business_operations");
  await member(PLATFORM_ORG, pat, "marketing");
  for (const v of [shown, hidden]) {
    await q("INSERT INTO vendor_profiles (tenant_id) VALUES ($1)", [v]);
    await q("INSERT INTO vendor_service_areas (tenant_id, community_id) VALUES ($1, $2)", [v, community]);
    await q("INSERT INTO vendor_vetting_summary (tenant_id, complete) VALUES ($1, true)", [v]);
  }
  await q("INSERT INTO community_vendor_approvals (tenant_id, vendor_id, status) VALUES ($1, $2, 'approved')", [community, shown]);
});
afterAll(async () => {
  await db.close();
});

describe("who can read a report", () => {
  it("only the reporter and the platform team: not a neighbour, the community, the vendor it names, or staff without the permission", async () => {
    const id = await report(alice, { vendor: shown });
    expect(await visible(asReporter(alice))).toEqual([id]);
    expect(await visible(asOps())).toEqual([id]);
    expect(await visible(asReporter(bob))).toEqual([]); // same community
    expect(await visible(asReporter(carol, community, ["concerns.create", "communities.read", "community.approve_vendor", "requests.read_community"]))).toEqual([]); // the community's own administrator
    expect(await visible({ tenantId: shown, userId: owner, permissions: ["vendors.read", "offerings.manage", "concerns.create", "inquiries.respond"] })).toEqual([]); // the vendor it is about
    expect(await visible({ tenantId: community, userId: pat, platformScope: true, permissions: ["vendors.read", "audit.read"] })).toEqual([]); // platform scope without concerns.manage
    expect(await visible({ tenantId: community, userId: ops, permissions: MANAGE })).toEqual([]); // the permission without platform scope
    expect(await visible({})).toEqual([]);
  });
});

describe("reporting", () => {
  it("accepts a report from a member who may report, starting open, with or without a vendor the person can see", async () => {
    await report(alice);
    await report(alice, { category: "payment", vendor: shown });
    await report(owner, { tenant: shown, ctx: asReporter(owner, shown) }); // a vendor's own person can report too
  });

  it("refuses to write a report for someone else, for another organization, already decided, or with an outcome", async () => {
    await expect(report(alice, { as: bob })).rejects.toMatchObject({ code: "42501" });
    await expect(report(alice, { tenant: shown })).rejects.toMatchObject({ code: "42501" });
    await expect(report(alice, { status: "resolved", resolution: "Sorted" })).rejects.toMatchObject({ code: "42501" });
    await expect(report(alice, { resolution: "Sorted" })).rejects.toMatchObject({ code: "42501" });
    await expect(report(alice, { category: "gossip" })).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses a report from a member whose role carries no reporting permission, whatever the request claims", async () => {
    await expect(report(eve)).rejects.toMatchObject({ code: "42501" });
    await expect(report(alice, { ctx: asReporter(alice, community, ["concerns.create"]), tenant: randomUUID() })).rejects.toMatchObject({ code: "42501" });
  });

  it("never lets platform staff report as the platform, even holding the permission", async () => {
    await q("INSERT INTO role_permissions (role_id, permission_code) SELECT id, 'concerns.create' FROM roles WHERE key = 'marketing' AND tenant_id IS NULL");
    await expect(report(pat, { tenant: PLATFORM_ORG, ctx: { tenantId: PLATFORM_ORG, userId: pat, platformScope: true, permissions: ["concerns.create"] } })).rejects.toMatchObject({ code: "42501" });
    await q("DELETE FROM role_permissions WHERE permission_code = 'concerns.create' AND role_id = (SELECT id FROM roles WHERE key = 'marketing' AND tenant_id IS NULL)");
  });

  it("refuses to name a vendor the reporter cannot see, so a vendor id cannot be probed", async () => {
    await expect(report(alice, { vendor: hidden })).rejects.toMatchObject({ code: "42501" });
    await expect(report(alice, { vendor: randomUUID() })).rejects.toMatchObject({ code: "42501" });
  });

  it("allows at most 10 undecided reports per person", async () => {
    const reporter = await user("flood");
    await member(community, reporter, "resident");
    await q(`INSERT INTO concerns (tenant_id, reporter_id, category, subject, details) SELECT $1, $2, 'other', 's', 'd' FROM generate_series(1, 10)`, [community, reporter]);
    await expect(report(reporter)).rejects.toMatchObject({ code: "23514" });
    // another person is unaffected, and a decided report stops counting
    await report(bob);
    const first = (await q("SELECT id FROM concerns WHERE reporter_id = $1 LIMIT 1", [reporter])).rows[0].id as string;
    await decide(asOps(), first, "dismissed", "Not something we can act on.");
    await report(reporter); // one place is free again
    await expect(report(reporter)).rejects.toMatchObject({ code: "23514" }); // and no more than that
  });
});

describe("deciding", () => {
  it("is for the platform team only: the reporter, the community, the vendor and staff without the permission change nothing", async () => {
    const id = await report(alice, { vendor: shown });
    const attempts: [string, Parameters<typeof withContext>[1]][] = [
      ["the reporter", asReporter(alice)],
      ["a neighbour", asReporter(bob)],
      ["the community administrator", asReporter(carol, community, ["concerns.create", "communities.read"])],
      ["the vendor named", { tenantId: shown, userId: owner, permissions: ["concerns.create", "vendors.read"] }],
      ["staff without the permission", { tenantId: community, userId: pat, platformScope: true, permissions: ["vendors.read"] }],
      ["the permission without platform scope", { tenantId: community, userId: ops, permissions: MANAGE }],
    ];
    for (const [who, ctx] of attempts) {
      const res = await decide(ctx, id, "resolved", "I decide").catch((e) => ({ rowCount: 0, error: e }));
      expect(res.rowCount, who).toBe(0);
    }
    expect((await q("SELECT status FROM concerns WHERE id = $1", [id])).rows[0].status).toBe("open");
  });

  it("moves forward only, and a decision always carries the words the reporter will read", async () => {
    const id = await report(alice);
    await expect(decide(asOps(), id, "resolved")).rejects.toMatchObject({ code: "23514" }); // no outcome
    await expect(decide(asOps(), id, "dismissed", "   ")).rejects.toMatchObject({ code: "23514" });
    await decide(asOps(), id, "reviewing");
    await expect(decide(asOps(), id, "open")).rejects.toMatchObject({ code: "42501" }); // never back to open
    const row = (await q("SELECT status, handled_by, resolution FROM concerns WHERE id = $1", [id])).rows[0];
    expect(row).toMatchObject({ status: "reviewing", handled_by: ops, resolution: null });
    await expect(decide(asOps(), id, "reviewing")).resolves.toBeDefined(); // no change is not a decision
    await decide(asOps(), id, "resolved", "The vendor has been removed from the platform.");
    expect(await withContext(db.app, asReporter(alice), async (c) => (await c.query("SELECT status, resolution FROM concerns WHERE id = $1", [id])).rows[0])).toEqual({ status: "resolved", resolution: "The vendor has been removed from the platform." });
    await expect(decide(asOps(), id, "reviewing")).rejects.toMatchObject({ code: "42501" }); // a decided report stays decided
    await expect(decide(asOps(), id, "dismissed", "Changed my mind")).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot take an outcome without a decision, give one before deciding, or rewrite what the report said", async () => {
    const id = await report(alice);
    await expect(withContext(db.app, asOps(), (c) => c.query("UPDATE concerns SET resolution = 'early' WHERE id = $1", [id]))).rejects.toMatchObject({ code: "42501" });
    await expect(withContext(db.app, asOps(), (c) => c.query("UPDATE concerns SET handled_by = $2 WHERE id = $1", [id, bob]))).rejects.toMatchObject({ code: "42501" });
    await expect(withContext(db.app, asOps(), (c) => c.query("UPDATE concerns SET details = 'rewritten' WHERE id = $1", [id]))).rejects.toMatchObject({ code: "42501" }); // no column grant
    // Nor with column grants out of the way: the owner connection acting as operations (who may decide) still cannot rewrite
    // a report, so only the trigger's immutability rule can be what stops it.
    for (const [column, value] of [["details", "rewritten"], ["subject", "rewritten"], ["category", "other"], ["reporter_id", bob], ["tenant_id", shown], ["vendor_id", shown]] as const) {
      await expect(withContext(db.admin, asOps(), (c) => c.query(`UPDATE concerns SET ${column} = $2 WHERE id = $1`, [id, value])), column).rejects.toMatchObject({ code: "42501" });
    }
    expect((await q("SELECT details, reporter_id FROM concerns WHERE id = $1", [id])).rows[0]).toEqual({ details: "Details", reporter_id: alice });
  });
});
