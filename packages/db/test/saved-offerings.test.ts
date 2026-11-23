import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withContext } from "../src/context";
import { createTestDb, type TestDb } from "../src/testing";

/** Saved offerings (Phase 7): a person's private list, attacked the way a hostile client would. */
const PLATFORM_ORG = "00000000-0000-4000-8000-000000000001";
let db: TestDb;
const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);

let community: string;
let otherCommunity: string;
let shown: string; // vendor the community shows
let hidden: string; // vendor the community has not approved
let alice: string;
let bob: string; // same community, different person
let eve: string; // not a member of anything
let fam: string; // a member whose role carries no catalog permission
let ops: string;
let owner: string;
let offering: string; // published, visible
let draft: string; // not published
let hiddenOffering: string; // published, but its vendor is not approved by the community

const RES = ["catalog.read", "requests.create_own"];
const asResident = (userId: string, tenantId = community, permissions = RES) => ({ tenantId, userId, permissions });

async function user(name: string): Promise<string> {
  const id = randomUUID();
  await q("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)", [id, `${name}@saved.test`, name]);
  return id;
}
async function newOffering(vendor: string, name: string, status: string): Promise<string> {
  return (await q(
    "INSERT INTO offerings (tenant_id, category_id, name, pricing_model, price_minor, status) VALUES ($1, (SELECT id FROM categories WHERE key = 'magic_shows'), $2, 'fixed', 1000, $3) RETURNING id",
    [vendor, name, status],
  )).rows[0].id as string;
}
const save = (userId: string, offeringId: string, tenantId = community, ctx = asResident(userId, tenantId)) =>
  withContext(db.app, ctx, (c) => c.query("INSERT INTO saved_offerings (tenant_id, user_id, offering_id) VALUES ($1, $2, $3)", [tenantId, userId, offeringId]));
const mine = (ctx: Parameters<typeof withContext>[1]) => withContext(db.app, ctx, async (c) => (await c.query("SELECT offering_id FROM saved_offerings")).rows.map((r) => r.offering_id as string));

beforeAll(async () => {
  db = await createTestDb();
  [community, otherCommunity, shown, hidden] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await q("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'community', 'Saved Heights', 'active'), ($2, 'community', 'Elsewhere', 'active')", [community, otherCommunity]);
  await q("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'vendor', 'Shown Vendor', 'active'), ($2, 'vendor', 'Hidden Vendor', 'active')", [shown, hidden]);
  [alice, bob, eve, ops, owner, fam] = (await Promise.all(["alice", "bob", "eve", "ops", "owner", "fam"].map(user))) as [string, string, string, string, string, string];
  await q("INSERT INTO platform_staff (user_id) VALUES ($1)", [ops]);
  await q("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [PLATFORM_ORG, ops]);
  await q("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'business_operations' AND tenant_id IS NULL", [PLATFORM_ORG, ops]);
  for (const id of [alice, bob]) {
    await q("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [community, id]);
    await q("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'resident' AND tenant_id IS NULL", [community, id]);
  }
  await q("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [shown, owner]);
  await q("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'vendor_owner' AND tenant_id IS NULL", [shown, owner]);
  for (const v of [shown, hidden]) {
    await q("INSERT INTO vendor_profiles (tenant_id) VALUES ($1)", [v]);
    await q("INSERT INTO vendor_service_areas (tenant_id, community_id) VALUES ($1, $2)", [v, community]);
    await q("INSERT INTO vendor_vetting_summary (tenant_id, complete) VALUES ($1, true)", [v]);
  }
  await q("INSERT INTO community_vendor_approvals (tenant_id, vendor_id, status) VALUES ($1, $2, 'approved')", [community, shown]);
  offering = await newOffering(shown, "Visible", "published");
  draft = await newOffering(shown, "Draft", "draft");
  hiddenOffering = await newOffering(hidden, "Not approved", "published");
});
afterAll(async () => {
  await db.close();
});

describe("saving", () => {
  it("lets a resident save an offering their community shows, once", async () => {
    await save(alice, offering);
    expect(await mine(asResident(alice))).toEqual([offering]);
    await expect(save(alice, offering)).rejects.toMatchObject({ code: "23505" }); // already saved
  });

  it("refuses offerings the person cannot see: a draft, or a vendor the community has not approved", async () => {
    await expect(save(alice, draft)).rejects.toMatchObject({ code: "42501" });
    await expect(save(alice, hiddenOffering)).rejects.toMatchObject({ code: "42501" });
    await expect(save(alice, randomUUID())).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses saving in someone else's name, in another community, in platform scope, or without the catalog permission", async () => {
    // for another person
    await expect(withContext(db.app, asResident(alice), (c) => c.query("INSERT INTO saved_offerings (tenant_id, user_id, offering_id) VALUES ($1, $2, $3)", [community, bob, offering]))).rejects.toMatchObject({ code: "42501" });
    // a person who is no member of the community has no catalog permission there
    await expect(save(eve, offering)).rejects.toMatchObject({ code: "42501" });
    // a member whose role does not carry the catalog permission cannot save, whatever the request claims
    await q("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [community, fam]);
    await q("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'family_member' AND tenant_id IS NULL", [community, fam]);
    await expect(save(fam, offering)).rejects.toMatchObject({ code: "42501" });
    // acting in one community while writing the row for another
    await expect(withContext(db.app, asResident(alice), (c) => c.query("INSERT INTO saved_offerings (tenant_id, user_id, offering_id) VALUES ($1, $2, $3)", [otherCommunity, alice, offering]))).rejects.toMatchObject({ code: "42501" });
    // platform staff never keep a saved list: even acting as themselves in the platform organization, where they hold
    // the catalog permission and can see every offering, only the "not platform" rule stops the row
    await expect(withContext(db.app, { tenantId: PLATFORM_ORG, userId: ops, platformScope: true, permissions: ["catalog.read"] }, (c) => c.query("INSERT INTO saved_offerings (tenant_id, user_id, offering_id) VALUES ($1, $2, $3)", [PLATFORM_ORG, ops, offering]))).rejects.toMatchObject({ code: "42501" });
  });
});

describe("privacy of the list", () => {
  it("is invisible to everyone but its owner: neighbour, community, operations and the vendor", async () => {
    expect(await mine(asResident(bob))).toEqual([]);
    expect(await mine({ tenantId: community, userId: ops, platformScope: true, permissions: ["catalog.read", "payments.read", "requests.read_all"] })).toEqual([]);
    expect(await mine({ tenantId: shown, userId: owner, permissions: ["offerings.manage", "vendors.read"] })).toEqual([]);
    expect(await mine({ tenantId: otherCommunity, userId: alice })).toEqual([]); // not even Alice, in a community she did not save in
  });

  it("cannot be edited, only added to and removed from, and only by its owner", async () => {
    await expect(withContext(db.app, asResident(alice), (c) => c.query("UPDATE saved_offerings SET user_id = $1", [bob]))).rejects.toMatchObject({ code: "42501" });
    await withContext(db.app, asResident(bob), (c) => c.query("DELETE FROM saved_offerings")); // Bob removes "all" of his own: nothing of Alice's
    expect(await mine(asResident(alice))).toEqual([offering]);
    await withContext(db.app, asResident(alice), (c) => c.query("DELETE FROM saved_offerings WHERE offering_id = $1", [offering]));
    expect(await mine(asResident(alice))).toEqual([]);
  });
});

describe("what a saved row reveals", () => {
  it("stops listing an offering once it is unpublished or its vendor is withdrawn, without exposing it", async () => {
    await save(alice, offering);
    const listed = () =>
      withContext(db.app, asResident(alice), async (c) =>
        (await c.query("SELECT o.name FROM saved_offerings s JOIN offerings o ON o.id = s.offering_id")).rows.map((r) => r.name as string),
      );
    expect(await listed()).toEqual(["Visible"]);
    await q("UPDATE offerings SET status = 'draft' WHERE id = $1", [offering]);
    expect(await listed()).toEqual([]);
    await q("UPDATE offerings SET status = 'published' WHERE id = $1", [offering]);
    expect(await listed()).toEqual(["Visible"]);
    await q("UPDATE community_vendor_approvals SET status = 'revoked' WHERE tenant_id = $1 AND vendor_id = $2", [community, shown]);
    expect(await listed()).toEqual([]);
    await q("UPDATE community_vendor_approvals SET status = 'approved' WHERE tenant_id = $1 AND vendor_id = $2", [community, shown]);
    expect(await listed()).toEqual(["Visible"]);
  });
});

describe("the limit", () => {
  it("allows at most 200 saved offerings per person per community", async () => {
    await q("DELETE FROM saved_offerings WHERE user_id = $1", [bob]);
    await q(
      `INSERT INTO offerings (tenant_id, category_id, name, pricing_model, price_minor, status)
         SELECT $1, (SELECT id FROM categories WHERE key = 'magic_shows'), 'Bulk ' || n, 'fixed', 100, 'published' FROM generate_series(1, 200) n`,
      [shown],
    );
    await q(
      `INSERT INTO saved_offerings (tenant_id, user_id, offering_id)
         SELECT $1, $2, id FROM offerings WHERE name LIKE 'Bulk %' LIMIT 200`,
      [community, bob],
    );
    await expect(save(bob, offering)).rejects.toMatchObject({ code: "23514" });
    // another person is unaffected
    await q("DELETE FROM saved_offerings WHERE user_id = $1 AND offering_id = $2", [alice, offering]);
    await save(alice, offering);
  });
});
