import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, makeMember, makeStaff, PLATFORM_SCOPE, register, type TestApp } from "./helpers";

let t: TestApp;
let ops: { cookie: string; userId: string }; // business_operations: create, vet, approve vendors
let boss: { cookie: string; userId: string }; // platform_admin: approves communities, manages categories
let categories: { id: string; key: string; parentId: string | null }[];
let seq = 0;
const email = (p: string) => `${p}-${++seq}@example.test`; // the dash keeps "a2"+"6" and "a"+"26" apart
const api = "/api/v1";

const asOps = (url: string, extra: Partial<Parameters<typeof call>[1]> = {}) => call(t.app, { url, cookie: ops.cookie, headers: PLATFORM_SCOPE, ...extra });
const asBoss = (url: string, extra: Partial<Parameters<typeof call>[1]> = {}) => call(t.app, { url, cookie: boss.cookie, headers: PLATFORM_SCOPE, ...extra });
const as = (who: { cookie: string }, tenantId: string, url: string, extra: Partial<Parameters<typeof call>[1]> = {}) =>
  call(t.app, { url, cookie: who.cookie, headers: { "x-tenant-id": tenantId }, ...extra });
const post = (who: typeof asOps, url: string, body: unknown) => who(url, { method: "POST", body });

const COMMUNITY = {
  communityType: "gated_community",
  country: "India",
  state: "Karnataka",
  city: "Bengaluru",
  locality: "Whitefield",
  address: "12 Lake Road",
  contactName: "Ramesh Kumar",
  contactEmail: "ramesh@example.test",
  contactPhone: "+91 98765 43210",
  latitude: 12.97,
  longitude: 77.75,
  unitCount: 420,
  population: 1500,
};
const VENDOR = {
  businessType: "individual",
  description: "Sports coaching for children.",
  country: "India",
  state: "Karnataka",
  city: "Bengaluru",
  contactName: "Asha Coach",
  contactEmail: "asha@example.test",
  legalName: "Asha Sports LLP",
  registrationNumber: "REG-1234",
  address: "5 Private Lane",
};
const REQUIRED = ["identity_proof", "background_check", "child_safety_training"];

async function activeCommunity(name: string): Promise<{ id: string; admin: { cookie: string } }> {
  const created = await post(asOps, `${api}/communities`, { name, ...COMMUNITY });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().id as string;
  expect((await post(asOps, `${api}/communities/${id}/transitions`, { to: "verification" })).statusCode).toBe(200);
  const adminEmail = email("cadmin");
  await register(t.app, adminEmail);
  expect((await post(asOps, `${api}/communities/${id}/admins`, { email: adminEmail })).statusCode).toBe(201);
  expect((await post(asBoss, `${api}/communities/${id}/transitions`, { to: "active", note: "Verified." })).statusCode).toBe(200);
  const admin = await makeMember(t, email("cadmin2"), id, ["community_admin"]);
  return { id, admin };
}

async function newVendor(name: string, over: Record<string, unknown> = {}): Promise<string> {
  const res = await post(asOps, `${api}/vendors`, { name, ...VENDOR, ...over });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function verifiedDocs(vendorId: string): Promise<void> {
  for (const requirementKey of REQUIRED) {
    const doc = await post(asOps, `${api}/vendors/${vendorId}/documents`, { requirementKey, title: `${requirementKey} doc`, reference: "ref-1" });
    expect(doc.statusCode, doc.body).toBe(201);
    const review = await post(asOps, `${api}/vendors/${vendorId}/documents/${doc.json().id}/review`, { decision: "verify" });
    expect(review.statusCode, review.body).toBe(200);
  }
}

/** Takes a vendor through the real onboarding to `active`, serving the given communities. */
async function activeVendor(name: string, communityIds: string[], over: Record<string, unknown> = {}): Promise<string> {
  const id = await newVendor(name, over);
  const cat = categories.find((c) => c.parentId)?.id as string;
  expect((await asOps(`${api}/vendors/${id}/categories`, { method: "PUT", body: { categoryIds: [cat] } })).statusCode).toBe(200);
  for (const communityId of communityIds) expect((await post(asOps, `${api}/vendors/${id}/service-areas`, { communityId })).statusCode).toBe(201);
  expect((await post(asOps, `${api}/vendors/${id}/transitions`, { to: "verification" })).statusCode).toBe(200);
  await verifiedDocs(id);
  const done = await post(asOps, `${api}/vendors/${id}/transitions`, { to: "active", note: "All documents verified." });
  expect(done.statusCode, done.body).toBe(200);
  return id;
}

const OFFERING = {
  name: "Weekend cricket camp",
  description: "Two hours of coaching for beginners.",
  pricingModel: "per_participant",
  priceMinor: 50_000,
  durationMinutes: 120,
  cancellationPolicy: "Free up to 48 hours before.",
  minParticipants: 4,
  maxParticipants: 12,
  ageMin: 6,
  ageMax: 12,
};

beforeAll(async () => {
  t = await createTestApp();
  ops = await makeStaff(t, "ops@example.test", "business_operations");
  boss = await makeStaff(t, "boss@example.test", "platform_admin");
  const res = await asBoss(`${api}/categories`);
  categories = res.json().data;
});
afterAll(async () => {
  await t.close();
});

describe("categories", () => {
  it("are readable by any signed-in user, seeded as a two-level tree, and managed only by the platform", async () => {
    expect(categories.length).toBeGreaterThan(5);
    expect(categories.some((c) => c.parentId === null)).toBe(true);
    expect(categories.some((c) => c.parentId !== null)).toBe(true);
    const nobody = await register(t.app, email("cat"));
    expect((await call(t.app, { url: `${api}/categories`, cookie: nobody.cookie })).statusCode).toBe(200);
    expect((await call(t.app, { url: `${api}/categories` })).statusCode).toBe(401);

    const parent = categories.find((c) => c.parentId === null)?.id as string;
    expect((await post(asBoss, `${api}/categories`, { key: "chess_club", name: "Chess club", parentId: parent })).statusCode).toBe(201);
    expect((await post(asBoss, `${api}/categories`, { key: "chess_club", name: "Chess again", parentId: parent })).statusCode).toBe(409);
    expect((await call(t.app, { method: "POST", url: `${api}/categories`, cookie: nobody.cookie, body: { key: "nope", name: "Nope" } })).statusCode).toBeGreaterThanOrEqual(400);
    // platform operations hold categories.manage too, but only in platform scope
    expect((await post(asOps, `${api}/categories`, { key: "ops_try", name: "Ops try" })).statusCode).toBe(201);
    expect((await call(t.app, { method: "POST", url: `${api}/categories`, cookie: ops.cookie, body: { key: "no_scope", name: "No scope" } })).statusCode).toBe(400);
  });

  it("refuse loops in the tree", async () => {
    const root = (await post(asBoss, `${api}/categories`, { key: "loop_root", name: "Loop root" })).json().id as string;
    const child = (await post(asBoss, `${api}/categories`, { key: "loop_child", name: "Loop child", parentId: root })).json().id as string;
    expect((await asBoss(`${api}/categories/${root}`, { method: "PATCH", body: { parentId: child } })).statusCode).toBe(400);
    expect((await asBoss(`${api}/categories/${root}`, { method: "PATCH", body: { parentId: root } })).statusCode).toBe(400);
  });
});

describe("vendor onboarding workflow", () => {
  it("blocks each step until the record is ready, says exactly what is missing, and ends with vetted documents", async () => {
    const community = await activeCommunity("Workflow Heights");
    const bare = (await post(asOps, `${api}/vendors`, { name: "Bare Vendor" })).json().id as string;
    const blocked = await post(asOps, `${api}/vendors/${bare}/transitions`, { to: "verification" });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe("transition_blocked");
    expect(blocked.json().error.details).toEqual(
      expect.arrayContaining(["Add a description of what the vendor offers.", "Choose at least one category.", "Add at least one place the vendor serves (a community or a city)."]),
    );

    const id = await newVendor("Asha Sports");
    const cat = categories.find((c) => c.parentId)?.id as string;
    expect((await asOps(`${api}/vendors/${id}/categories`, { method: "PUT", body: { categoryIds: [cat] } })).statusCode).toBe(200);
    expect((await post(asOps, `${api}/vendors/${id}/service-areas`, { communityId: community.id })).statusCode).toBe(201);
    expect((await post(asOps, `${api}/vendors/${id}/service-areas`, { communityId: community.id })).statusCode).toBe(409);
    expect((await post(asOps, `${api}/vendors/${id}/service-areas`, { city: "Mysuru" })).statusCode).toBe(201);
    expect((await post(asOps, `${api}/vendors/${id}/service-areas`, { city: "Mysuru", communityId: community.id })).statusCode).toBe(400); // one or the other
    expect((await post(asOps, `${api}/vendors/${id}/service-areas`, { communityId: randomUUID() })).statusCode).toBe(404);
    expect((await post(asOps, `${api}/vendors/${id}/transitions`, { to: "verification" })).json().status).toBe("verification");

    // activation: every required document must be verified and current
    const early = await post(asOps, `${api}/vendors/${id}/transitions`, { to: "active", note: "ok" });
    expect(early.statusCode).toBe(422);
    expect(early.json().error.details).toHaveLength(REQUIRED.length);
    const vetting = (await asOps(`${api}/vendors/${id}/vetting`)).json();
    expect(vetting.readyForApproval).toBe(false);
    expect(vetting.requirements.filter((r: { required: boolean }) => r.required).map((r: { state: string }) => r.state)).toEqual(["missing", "missing", "missing"]);

    await verifiedDocs(id);
    expect((await asOps(`${api}/vendors/${id}/vetting`)).json().readyForApproval).toBe(true);
    expect((await post(asOps, `${api}/vendors/${id}/transitions`, { to: "active" })).json().error.code).toBe("note_required");
    expect((await post(asBoss, `${api}/vendors/${id}/transitions`, { to: "active", note: "ok" })).statusCode).toBe(403); // platform_admin cannot approve vendors
    const done = await post(asOps, `${api}/vendors/${id}/transitions`, { to: "active", note: "Documents checked." });
    expect(done.json().status).toBe("active");

    const history = (await asOps(`${api}/vendors/${id}/history`)).json().data;
    expect(history.map((h: { to: string }) => h.to)).toEqual(["active", "verification", "draft"]);
    expect((await post(asOps, `${api}/vendors/${id}/transitions`, { to: "draft" })).statusCode).toBe(409);
  });

  it("will not activate a vendor on documents that are submitted or rejected: only a platform review counts", async () => {
    const id = await newVendor("Unreviewed Docs");
    const cat = categories.find((c) => c.parentId)?.id as string;
    await asOps(`${api}/vendors/${id}/categories`, { method: "PUT", body: { categoryIds: [cat] } });
    await post(asOps, `${api}/vendors/${id}/service-areas`, { city: "Bengaluru" });
    await post(asOps, `${api}/vendors/${id}/transitions`, { to: "verification" });
    const ids: string[] = [];
    for (const requirementKey of REQUIRED) {
      const doc = await post(asOps, `${api}/vendors/${id}/documents`, { requirementKey, title: `${requirementKey} doc` });
      ids.push(doc.json().id as string);
    }
    const attempt = () => post(asOps, `${api}/vendors/${id}/transitions`, { to: "active", note: "try" });

    // all three are only "submitted"
    const submitted = await attempt();
    expect(submitted.statusCode).toBe(422);
    expect(submitted.json().error.details).toHaveLength(REQUIRED.length);
    expect((await asOps(`${api}/vendors/${id}/vetting`)).json().readyForApproval).toBe(false);

    // two verified, one rejected: still blocked, and it names the one that is missing
    await post(asOps, `${api}/vendors/${id}/documents/${ids[0]}/review`, { decision: "verify" });
    await post(asOps, `${api}/vendors/${id}/documents/${ids[1]}/review`, { decision: "verify" });
    await post(asOps, `${api}/vendors/${id}/documents/${ids[2]}/review`, { decision: "reject", note: "Blurry." });
    const partly = await attempt();
    expect(partly.statusCode).toBe(422);
    expect(partly.json().error.details).toEqual(["Verify a current document for: Child safety briefing."]);

    // a fresh submission is still not enough until it is reviewed
    await post(asOps, `${api}/vendors/${id}/documents`, { requirementKey: "child_safety_training", title: "Second try" });
    expect((await attempt()).statusCode).toBe(422);
  });

  it("will not activate a vendor whose required document has expired", async () => {
    const id = await newVendor("Expired Docs");
    const cat = categories.find((c) => c.parentId)?.id as string;
    await asOps(`${api}/vendors/${id}/categories`, { method: "PUT", body: { categoryIds: [cat] } });
    await post(asOps, `${api}/vendors/${id}/service-areas`, { city: "Bengaluru" });
    await post(asOps, `${api}/vendors/${id}/transitions`, { to: "verification" });
    await verifiedDocs(id);
    // the identity proof lapses after it was verified
    await t.db.admin.query("UPDATE vendor_documents SET expires_on = current_date - 1 WHERE tenant_id = $1 AND requirement_key = 'identity_proof'", [id]);
    const res = await post(asOps, `${api}/vendors/${id}/transitions`, { to: "active", note: "try" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details).toHaveLength(1);
    const vetting = (await asOps(`${api}/vendors/${id}/vetting`)).json();
    expect(vetting.requirements.find((r: { key: string }) => r.key === "identity_proof").state).toBe("expired");
  });

  it("can suspend and reinstate, and a suspended vendor's people are switched off", async () => {
    const community = await activeCommunity("Suspension Court");
    const id = await activeVendor("Suspendable", [community.id]);
    const owner = await makeMember(t, email("sowner"), id, ["vendor_owner"], { mfa: true });
    expect((await as(owner, id, `${api}/vendors/${id}`)).statusCode).toBe(200);

    expect((await post(asOps, `${api}/vendors/${id}/transitions`, { to: "suspended" })).json().error.code).toBe("note_required");
    expect((await post(asOps, `${api}/vendors/${id}/transitions`, { to: "suspended", note: "Complaint under review." })).json().status).toBe("suspended");
    const blocked = await as(owner, id, `${api}/vendors/${id}`);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("tenant_suspended");
    expect((await post(asOps, `${api}/vendors/${id}/transitions`, { to: "active", note: "Cleared." })).json().status).toBe("active");
    expect((await as(owner, id, `${api}/vendors/${id}`)).statusCode).toBe(200);
  });

  it("is a platform-team action to register, list and approve vendors", async () => {
    const community = await activeCommunity("Platform Only Place");
    const id = await activeVendor("Platform Only", [community.id]);
    const owner = await makeMember(t, email("powner"), id, ["vendor_owner"], { mfa: true });
    expect((await as(owner, id, `${api}/vendors`, { method: "POST", body: { name: "Self made", ...VENDOR } })).statusCode).toBe(403);
    expect((await as(owner, id, `${api}/vendors`)).statusCode).toBe(403);
    const resident = await makeMember(t, email("pres"), community.id, ["resident"]);
    expect((await as(resident, community.id, `${api}/vendors`)).statusCode).toBe(403);
    expect((await call(t.app, { url: `${api}/vendors`, cookie: ops.cookie })).json().error.code).toBe("tenant_required"); // platform scope switched off
  });

  it("lists with filters and keyset pagination, and validates input", async () => {
    for (const n of ["Pager A", "Pager B", "Pager C"]) await newVendor(n);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const res = await asOps(`${api}/vendors?limit=2&q=Pager${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.statusCode, res.body).toBe(200);
      for (const row of res.json().data) seen.push(row.name);
      cursor = res.json().page.nextCursor;
      if (!cursor) break;
    }
    expect([...seen].sort()).toEqual(["Pager A", "Pager B", "Pager C"]);
    expect((await asOps(`${api}/vendors?limit=500`)).statusCode).toBe(400);
    expect((await asOps(`${api}/vendors?cursor=garbage`)).json().error.code).toBe("invalid_cursor");
    expect((await asOps(`${api}/vendors?status=draft&q=Pager`)).json().data.length).toBeGreaterThanOrEqual(3);
    expect((await post(asOps, `${api}/vendors`, { name: "x" })).statusCode).toBe(400);
    expect((await post(asOps, `${api}/vendors`, { name: "Bad Site", ...VENDOR, website: "javascript:alert(1)" })).statusCode).toBe(400);
    expect((await post(asOps, `${api}/vendors`, { name: "Extra Field", ...VENDOR, status: "active" })).statusCode).toBe(400);
  });
});

describe("vetting documents", () => {
  it("lets the vendor submit and withdraw, but only the platform team decide, and a decision locks the document", async () => {
    const id = await newVendor("Vetting Vendor");
    const owner = await makeMember(t, email("vowner"), id, ["vendor_owner"], { mfa: true });
    const mine = (url: string, extra: Partial<Parameters<typeof call>[1]> = {}) => as(owner, id, url, extra);

    const bad = await mine(`${api}/vendors/${id}/documents`, { method: "POST", body: { requirementKey: "nonsense", title: "x" } });
    expect(bad.statusCode).toBe(400);
    expect((await mine(`${api}/vendors/${id}/documents`, { method: "POST", body: { requirementKey: "insurance", title: "x", issuedOn: "2025-06-01", expiresOn: "2025-01-01" } })).statusCode).toBe(400);

    const doc = await mine(`${api}/vendors/${id}/documents`, { method: "POST", body: { requirementKey: "identity_proof", title: "Aadhaar copy", reference: "drive-link" } });
    expect(doc.statusCode, doc.body).toBe(201);
    expect(doc.json().status).toBe("submitted");
    const docId = doc.json().id as string;
    expect((await mine(`${api}/vendors/${id}/documents/${docId}`, { method: "PATCH", body: { title: "Aadhaar front and back" } })).json().title).toBe("Aadhaar front and back");

    // vendors cannot decide on their own documents, even in their own tenant
    expect((await mine(`${api}/vendors/${id}/documents/${docId}/review`, { method: "POST", body: { decision: "verify" } })).statusCode).toBe(403);
    // directly in the database the row policy refuses too: a vendor cannot insert an already-verified document
    const direct = await t.db.app.connect();
    try {
      await direct.query("BEGIN");
      await direct.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.permissions', 'vendor_documents.manage', true)", [id, owner.userId]);
      await expect(direct.query("INSERT INTO vendor_documents (tenant_id, requirement_key, title, status) VALUES ($1, 'insurance', 'sneaky', 'verified')", [id])).rejects.toThrow();
    } finally {
      await direct.query("ROLLBACK");
      direct.release();
    }

    expect((await post(asOps, `${api}/vendors/${id}/documents/${docId}/review`, { decision: "reject" })).json().error.code).toBe("note_required");
    const rejected = await post(asOps, `${api}/vendors/${id}/documents/${docId}/review`, { decision: "reject", note: "Image is unreadable." });
    expect(rejected.json().status).toBe("rejected");
    expect((await post(asOps, `${api}/vendors/${id}/documents/${docId}/review`, { decision: "verify" })).statusCode).toBe(409);
    expect((await mine(`${api}/vendors/${id}/documents/${docId}`, { method: "PATCH", body: { title: "changed" } })).statusCode).toBe(404);
    expect((await mine(`${api}/vendors/${id}/documents/${docId}`, { method: "DELETE" })).statusCode).toBe(404);
    const state = (await mine(`${api}/vendors/${id}/vetting`)).json().requirements.find((r: { key: string }) => r.key === "identity_proof");
    expect(state.state).toBe("rejected");

    // an unreviewed submission can be withdrawn
    const second = (await mine(`${api}/vendors/${id}/documents`, { method: "POST", body: { requirementKey: "first_aid", title: "Certificate" } })).json().id as string;
    expect((await mine(`${api}/vendors/${id}/documents/${second}`, { method: "DELETE" })).statusCode).toBe(204);

    // an expired document cannot be verified
    const old = (await mine(`${api}/vendors/${id}/documents`, { method: "POST", body: { requirementKey: "insurance", title: "Old policy", expiresOn: "2020-01-01" } })).json().id as string;
    expect((await post(asOps, `${api}/vendors/${id}/documents/${old}/review`, { decision: "verify" })).json().error.code).toBe("document_expired");
  });
});

describe("a vendor's own team", () => {
  it("is built by the platform (owner) and then the owner, with limits on who can grant or remove what", async () => {
    const id = await newVendor("Team Vendor");
    const ownerEmail = email("towner");
    await register(t.app, ownerEmail);
    expect((await post(asOps, `${api}/vendors/${id}/staff`, { email: "ghost@example.test", role: "vendor_owner" })).json().error.code).toBe("user_not_found");
    const added = await post(asOps, `${api}/vendors/${id}/staff`, { email: ownerEmail, role: "vendor_owner" });
    expect(added.statusCode, added.body).toBe(201);
    expect(added.json().data.map((p: { email: string }) => p.email)).toEqual([ownerEmail]);

    // sign in as that owner (the real account created above)
    const ownerRow = await t.db.admin.query("SELECT id FROM users WHERE email = $1", [ownerEmail]);
    const ownerId = ownerRow.rows[0].id as string;
    const { enrollMfa, login, markEmailVerified } = await import("./helpers");
    await markEmailVerified(t.db, ownerId);
    const ownerCookie = await login(t.app, ownerEmail);
    await enrollMfa(t.app, ownerCookie);
    const owner = { cookie: ownerCookie, userId: ownerId };

    const adminEmail = email("tadmin");
    const staffEmail = email("tstaff");
    await register(t.app, adminEmail);
    await register(t.app, staffEmail);
    expect((await as(owner, id, `${api}/vendors/${id}/staff`, { method: "POST", body: { email: adminEmail, role: "vendor_admin" } })).statusCode).toBe(201);
    expect((await as(owner, id, `${api}/vendors/${id}/staff`, { method: "POST", body: { email: staffEmail, role: "vendor_staff" } })).statusCode).toBe(201);
    // an owner cannot create another owner: that is the platform team's decision
    expect((await as(owner, id, `${api}/vendors/${id}/staff`, { method: "POST", body: { email: staffEmail, role: "vendor_owner" } })).json().error.code).toBe("platform_only_role");
    expect((await as(owner, id, `${api}/vendors/${id}/staff`, { method: "POST", body: { email: staffEmail, role: "platform_admin" } })).statusCode).toBe(400);

    // a vendor administrator cannot manage the team; owners cannot remove themselves or other owners
    const adminId = (await t.db.admin.query("SELECT id FROM users WHERE email = $1", [adminEmail])).rows[0].id as string;
    await markEmailVerified(t.db, adminId);
    const admin = { cookie: await login(t.app, adminEmail), userId: adminId };
    expect((await as(admin, id, `${api}/vendors/${id}/staff`, { method: "POST", body: { email: staffEmail, role: "vendor_staff" } })).statusCode).toBe(403);
    expect((await as(owner, id, `${api}/vendors/${id}/staff/${ownerId}`, { method: "DELETE" })).json().error.code).toBe("cannot_act_on_self");
    expect((await as(owner, id, `${api}/vendors/${id}/staff/${adminId}`, { method: "DELETE" })).statusCode).toBe(204);
    expect((await as(admin, id, `${api}/vendors/${id}`)).statusCode).toBe(403); // no longer a member
    expect((await as(owner, id, `${api}/vendors/${id}/staff/${randomUUID()}`, { method: "DELETE" })).statusCode).toBe(404);
  });

  it("keeps the last owner of an active vendor", async () => {
    const community = await activeCommunity("Owner Guard Estate");
    const id = await activeVendor("Owner Guard", [community.id]);
    const only = await makeMember(t, email("lastowner"), id, ["vendor_owner"], { mfa: true });
    const res = await asOps(`${api}/vendors/${id}/staff/${only.userId}`, { method: "DELETE" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("last_owner");
  });
});

describe("isolation between vendors", () => {
  it("never lets one vendor reach another's record, offerings, documents, availability or team, by id", async () => {
    const a = await newVendor("Isolated A");
    const b = await newVendor("Isolated B");
    const ownerA = await makeMember(t, email("isoa"), a, ["vendor_owner"], { mfa: true });
    await makeMember(t, email("isob"), b, ["vendor_owner"], { mfa: true });

    const own = await as(ownerA, a, `${api}/vendors/${a}`);
    expect(own.statusCode).toBe(200);
    for (const path of ["", "/offerings", "/documents", "/vetting", "/availability", "/staff", "/history", "/service-areas"]) {
      const res = await as(ownerA, a, `${api}/vendors/${b}${path}`);
      expect(res.statusCode, path).toBe(404);
    }
    for (const [method, path, body] of [
      ["PATCH", "", { tagline: "hijack" }],
      ["POST", "/offerings", OFFERING],
      ["POST", "/documents", { requirementKey: "insurance", title: "x" }],
      ["PUT", "/categories", { categoryIds: [] }],
      ["POST", "/staff", { email: "x@example.test", role: "vendor_staff" }],
    ] as const) {
      expect((await as(ownerA, a, `${api}/vendors/${b}${path}`, { method, body })).statusCode, `${method} ${path}`).toBe(404);
    }
    // naming vendor B as the acting tenant fails: A's owner is not a member there
    expect((await as(ownerA, b, `${api}/vendors/${b}`)).statusCode).toBe(403);
    expect((await asOps(`${api}/vendors/${b}`)).json().tagline).toBeNull();
  });

  it("keeps platform-only internal notes and private business details away from the vendor's catalog audience", async () => {
    const community = await activeCommunity("Notes Meadow");
    const id = await activeVendor("Noted Vendor", [community.id], { internalNotes: "Owes us a document" });
    expect((await asOps(`${api}/vendors/${id}`)).json().internalNotes).toBe("Owes us a document");
    const owner = await makeMember(t, email("nowner"), id, ["vendor_owner"], { mfa: true });
    const view = (await as(owner, id, `${api}/vendors/${id}`)).json();
    expect(view.internalNotes).toBeNull();
    expect(view.legalName).toBe("Asha Sports LLP"); // the vendor sees its own private details
    expect((await as(owner, id, `${api}/vendors/${id}`, { method: "PATCH", body: { internalNotes: "mine now" } })).json().error.code).toBe("platform_only_field");
  });
});

describe("offerings", () => {
  async function ownerOf(name: string): Promise<{ id: string; owner: { cookie: string; userId: string } }> {
    const id = await newVendor(name);
    const owner = await makeMember(t, email("off"), id, ["vendor_owner"], { mfa: true });
    return { id, owner };
  }
  const cat = () => categories.find((c) => c.parentId)?.id as string;

  it("validates pricing, participants, ages and the category, with the whole record checked on every change", async () => {
    const { id, owner } = await ownerOf("Offering Vendor");
    const create = (body: unknown) => as(owner, id, `${api}/vendors/${id}/offerings`, { method: "POST", body });
    const valid = { ...OFFERING, categoryId: cat(), status: "draft" };

    expect((await create({ ...valid, priceMinor: null })).statusCode).toBe(400); // a price is required...
    expect((await create({ ...valid, priceMinor: null, pricingModel: "custom_quotation" })).statusCode).toBe(201); // ...unless quoted
    expect((await create({ ...valid, priceMinor: -5 })).statusCode).toBe(400);
    expect((await create({ ...valid, maxParticipants: 2 })).json().error.details).toEqual([{ field: "maxParticipants", message: "The maximum cannot be less than the minimum." }]);
    expect((await create({ ...valid, ageMax: 3 })).statusCode).toBe(400);
    expect((await create({ ...valid, pricingModel: "barter" })).statusCode).toBe(400);
    expect((await create({ ...valid, categoryId: randomUUID() })).statusCode).toBe(400);
    expect((await create({ ...valid, categoryId: categories.find((c) => c.parentId === null)?.id })).statusCode).toBe(400); // top-level groups are not categories to sell in
    expect((await create({ ...valid, status: "archived" })).statusCode).toBe(400);
    expect((await create({ ...valid, tenantId: randomUUID() })).statusCode).toBe(400);

    const made = await create(valid);
    expect(made.statusCode, made.body).toBe(201);
    const offeringId = made.json().id as string;
    expect(made.json()).toMatchObject({ priceMinor: 50_000, currency: "INR", status: "draft" });
    const patch = (body: unknown) => as(owner, id, `${api}/vendors/${id}/offerings/${offeringId}`, { method: "PATCH", body });
    expect((await patch({ maxParticipants: 2 })).statusCode).toBe(400); // checked against the stored minimum of 4
    expect((await patch({ minParticipants: 20 })).statusCode).toBe(400); // checked against the stored maximum of 12
    expect((await patch({ pricingModel: "custom_quotation", priceMinor: null })).statusCode).toBe(200);
    expect((await patch({ pricingModel: "fixed" })).statusCode).toBe(400); // fixed pricing needs the price back
    expect((await patch({})).statusCode).toBe(400);
    expect((await patch({ name: "Renamed camp" })).json().name).toBe("Renamed camp");
    expect((await as(owner, id, `${api}/vendors/${id}/offerings/${randomUUID()}`, { method: "PATCH", body: { name: "Nope" } })).statusCode).toBe(404);
  });

  it("will not publish an offering that families would find incomplete", async () => {
    const { id, owner } = await ownerOf("Publish Vendor");
    const incomplete = await as(owner, id, `${api}/vendors/${id}/offerings`, {
      method: "POST",
      body: { categoryId: cat(), name: "Thin offer", pricingModel: "fixed", priceMinor: 100, status: "published" },
    });
    expect(incomplete.statusCode).toBe(422);
    expect(incomplete.json().error.code).toBe("not_ready_to_publish");
    expect(incomplete.json().error.details).toHaveLength(3);
    expect((await as(owner, id, `${api}/vendors/${id}/offerings`)).json().data).toHaveLength(0); // nothing half-saved

    const draft = (await as(owner, id, `${api}/vendors/${id}/offerings`, { method: "POST", body: { ...OFFERING, categoryId: cat(), status: "draft", cancellationPolicy: null } })).json().id as string;
    const tryPublish = await as(owner, id, `${api}/vendors/${id}/offerings/${draft}`, { method: "PATCH", body: { status: "published" } });
    expect(tryPublish.statusCode).toBe(422);
    expect((await as(owner, id, `${api}/vendors/${id}/offerings/${draft}`, { method: "PATCH", body: { status: "published", cancellationPolicy: "Free up to 24 hours." } })).json().status).toBe("published");
    // regression: changing one field must never reset the status (zod defaults once un-published offerings on rename)
    const renamed = await as(owner, id, `${api}/vendors/${id}/offerings/${draft}`, { method: "PATCH", body: { name: "Renamed while live" } });
    expect(renamed.json()).toMatchObject({ name: "Renamed while live", status: "published", offeringType: "service" });
    expect((await as(owner, id, `${api}/vendors/${id}/offerings/${draft}`, { method: "PATCH", body: { status: "archived" } })).json().status).toBe("archived");
  });

  it("is limited to people allowed to manage offerings (vendor staff can only respond, not edit the catalog)", async () => {
    const { id } = await ownerOf("Staff Limits");
    const staff = await makeMember(t, email("lowstaff"), id, ["vendor_staff"], { mfa: true });
    expect((await as(staff, id, `${api}/vendors/${id}/offerings`)).statusCode).toBe(403);
    expect((await as(staff, id, `${api}/vendors/${id}/offerings`, { method: "POST", body: { ...OFFERING, categoryId: cat() } })).statusCode).toBe(403);
    expect((await as(staff, id, `${api}/vendors/${id}/documents`, { method: "POST", body: { requirementKey: "insurance", title: "x" } })).statusCode).toBe(403);
    expect((await as(staff, id, `${api}/vendors/${id}/availability`)).statusCode).toBe(200); // staff do manage availability
  });
});

describe("availability", () => {
  it("replaces weekly hours atomically, rejects bad or overlapping slots, and manages time off", async () => {
    const id = await newVendor("Availability Vendor");
    const owner = await makeMember(t, email("avail"), id, ["vendor_owner"], { mfa: true });
    const mine = (url: string, extra: Partial<Parameters<typeof call>[1]> = {}) => as(owner, id, `${api}/vendors/${id}/availability${url}`, extra);
    const put = (rules: unknown) => mine("/weekly-hours", { method: "PUT", body: { rules } });

    const ok = await put([
      { weekday: 1, startTime: "09:00", endTime: "12:00" },
      { weekday: 1, startTime: "14:00", endTime: "18:00" },
      { weekday: 6, startTime: "08:30", endTime: "10:30" },
    ]);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().weeklyHours).toHaveLength(3);

    expect((await put([{ weekday: 1, startTime: "12:00", endTime: "09:00" }])).statusCode).toBe(400);
    expect((await put([{ weekday: 1, startTime: "09:00", endTime: "12:00" }, { weekday: 1, startTime: "11:00", endTime: "13:00" }])).statusCode).toBe(400);
    expect((await put([{ weekday: 7, startTime: "09:00", endTime: "12:00" }])).statusCode).toBe(400);
    expect((await put([{ weekday: 1, startTime: "9am", endTime: "12:00" }])).statusCode).toBe(400);
    expect((await mine("")).json().weeklyHours).toHaveLength(3); // failed attempts changed nothing
    expect((await put([])).json().weeklyHours).toHaveLength(0);

    const start = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const end = new Date(Date.now() + 6 * 86_400_000).toISOString();
    expect((await mine("/unavailable", { method: "POST", body: { startsAt: end, endsAt: start } })).statusCode).toBe(400);
    const block = await mine("/unavailable", { method: "POST", body: { startsAt: start, endsAt: end, reason: "Family trip" } });
    expect(block.statusCode).toBe(201);
    const blockId = block.json().unavailable[0].id as string;
    expect((await mine(`/unavailable/${blockId}`, { method: "DELETE" })).statusCode).toBe(204);
    expect((await mine(`/unavailable/${blockId}`, { method: "DELETE" })).statusCode).toBe(404);
  });
});

describe("what residents can see: community approval and the catalog", () => {
  it("shows an offering only once the vendor is active, serves the community, the community approved it, and the offering is published", async () => {
    const home = await activeCommunity("Catalog Home");
    const other = await activeCommunity("Catalog Elsewhere");
    const resident = await makeMember(t, email("cres"), home.id, ["resident"]);
    const neighbour = await makeMember(t, email("cnei"), other.id, ["resident"]);
    const browse = (who: { cookie: string }, tenantId: string, query = "") => as(who, tenantId, `${api}/catalog/offerings${query}`);

    const vendorId = await activeVendor("Visible Vendor", [home.id]);
    const owner = await makeMember(t, email("vis"), vendorId, ["vendor_owner"], { mfa: true });
    const draft = (await as(owner, vendorId, `${api}/vendors/${vendorId}/offerings`, { method: "POST", body: { ...OFFERING, categoryId: categories.find((c) => c.parentId)?.id, status: "draft" } })).json().id as string;

    // 1. nothing is visible before the community approves the vendor (the default policy)
    expect((await browse(resident, home.id)).json().data).toEqual([]);
    expect((await as(resident, home.id, `${api}/catalog/vendors/${vendorId}`)).statusCode).toBe(404);

    // 2. the community administrator sees the vendor as undecided and approves it
    const pending = (await as(home.admin, home.id, `${api}/communities/${home.id}/vendors`)).json().data;
    expect(pending).toEqual([expect.objectContaining({ vendorId, name: "Visible Vendor", decision: "undecided" })]);
    expect(JSON.stringify(pending)).not.toContain("Asha Sports LLP"); // no private business details for approvers
    expect((await as(home.admin, home.id, `${api}/communities/${home.id}/vendors/${vendorId}`, { method: "PUT", body: { status: "approved" } })).statusCode).toBe(200);
    // ...but a draft offering is still not visible
    expect((await browse(resident, home.id)).json().data).toEqual([]);

    // 3. published offering appears, with the vendor, and no private fields anywhere
    expect((await as(owner, vendorId, `${api}/vendors/${vendorId}/offerings/${draft}`, { method: "PATCH", body: { status: "published" } })).statusCode).toBe(200);
    const seen = await browse(resident, home.id);
    expect(seen.json().data).toHaveLength(1);
    expect(seen.json().data[0]).toMatchObject({ name: "Weekend cricket camp", vendor: { id: vendorId, name: "Visible Vendor" }, priceMinor: 50_000 });
    expect(seen.body).not.toMatch(/Asha Sports|REG-1234|Private Lane|asha@example/u);
    const page = (await as(resident, home.id, `${api}/catalog/vendors/${vendorId}`)).json();
    expect(page).toMatchObject({ name: "Visible Vendor", city: "Bengaluru" });
    expect(page.offerings).toHaveLength(1);
    expect(JSON.stringify(page)).not.toMatch(/Asha Sports|REG-1234|Private Lane|asha@example|internalNotes|legalName/u);

    // 4. a resident of another community sees nothing, and cannot read the vendor page either
    expect((await browse(neighbour, other.id)).json().data).toEqual([]);
    expect((await as(neighbour, other.id, `${api}/catalog/vendors/${vendorId}`)).statusCode).toBe(404);
    // ...and cannot pretend to act in the home community
    expect((await browse(neighbour, home.id)).statusCode).toBe(403);

    // 5. filters
    expect((await browse(resident, home.id, "?age=8")).json().data).toHaveLength(1);
    expect((await browse(resident, home.id, "?age=15")).json().data).toHaveLength(0);
    expect((await browse(resident, home.id, "?q=cricket")).json().data).toHaveLength(1);
    expect((await browse(resident, home.id, "?q=%25")).json().data).toHaveLength(0); // wildcard characters are escaped
    expect((await browse(resident, home.id, "?maxPriceMinor=100")).json().data).toHaveLength(0);
    expect((await browse(resident, home.id, "?maxPriceMinor=50000&pricingModel=per_participant")).json().data).toHaveLength(1);
    expect((await browse(resident, home.id, "?pricingModel=hourly")).json().data).toHaveLength(0);
    expect((await browse(resident, home.id, `?categoryId=${categories.find((c) => c.parentId)?.parentId}`)).json().data).toHaveLength(1); // parent includes children
    expect((await browse(resident, home.id, "?limit=0")).statusCode).toBe(400);

    // 6. the community can revoke, and the vendor disappears at once
    expect((await as(home.admin, home.id, `${api}/communities/${home.id}/vendors/${vendorId}`, { method: "PUT", body: { status: "revoked" } })).json().error.code).toBe("note_required");
    expect((await as(home.admin, home.id, `${api}/communities/${home.id}/vendors/${vendorId}`, { method: "PUT", body: { status: "revoked", note: "Parent complaint" } })).statusCode).toBe(200);
    expect((await browse(resident, home.id)).json().data).toEqual([]);

    // 7. a community that turns the approval requirement off shows every active vendor that serves it
    expect((await as(home.admin, home.id, `${api}/communities/${home.id}/policies/vendor_approval_required`, { method: "PUT", body: { value: false } })).statusCode).toBe(200);
    expect((await browse(resident, home.id)).json().data).toHaveLength(1);

    // 8. a suspended vendor vanishes from the catalog
    expect((await post(asOps, `${api}/vendors/${vendorId}/transitions`, { to: "suspended", note: "Investigation" })).statusCode).toBe(200);
    expect((await browse(resident, home.id)).json().data).toEqual([]);
    expect((await as(resident, home.id, `${api}/catalog/vendors/${vendorId}`)).statusCode).toBe(404);
  });

  it("keeps vendors that do not serve a community out of its approval list, and approvals to the community's own administrators", async () => {
    const home = await activeCommunity("Approvals Home");
    const away = await activeCommunity("Approvals Away");
    const vendorId = await activeVendor("Away Vendor", [away.id]);
    expect((await as(home.admin, home.id, `${api}/communities/${home.id}/vendors`)).json().data).toEqual([]);
    expect((await as(home.admin, home.id, `${api}/communities/${home.id}/vendors/${vendorId}`, { method: "PUT", body: { status: "approved" } })).statusCode).toBe(404);
    // an administrator cannot decide for a community they do not run
    expect((await as(home.admin, home.id, `${api}/communities/${away.id}/vendors`)).statusCode).toBe(404);
    expect((await as(home.admin, home.id, `${api}/communities/${away.id}/vendors/${vendorId}`, { method: "PUT", body: { status: "approved" } })).statusCode).toBe(404);
    // residents cannot approve; the catalog is not available in platform scope
    const resident = await makeMember(t, email("apres"), home.id, ["resident"]);
    expect((await as(resident, home.id, `${api}/communities/${home.id}/vendors`)).statusCode).toBe(403);
    expect((await asOps(`${api}/catalog/offerings`)).statusCode).toBe(403);
    // an unfinished vendor is not offered to communities for approval
    const draft = await newVendor("Draft Only");
    await post(asOps, `${api}/vendors/${draft}/service-areas`, { communityId: home.id });
    expect((await as(home.admin, home.id, `${api}/communities/${home.id}/vendors`)).json().data).toEqual([]);
    expect((await call(t.app, { url: `${api}/catalog/offerings` })).statusCode).toBe(401);
  });
});

describe("discovery: ratings, filters and saved offerings (Phase 7)", () => {
  /** A completed booking for `vendorId` by `requester`, with a review of the given status (inserted directly: the review flow has its own tests). */
  async function reviewed(communityId: string, vendorId: string, requester: string, rating: number, status: "published" | "pending"): Promise<void> {
    const sql = (text: string, params: unknown[]) => t.db.admin.query(text, params);
    const request = (await sql("INSERT INTO requests (tenant_id, requester_id, request_type_id, schema_version, title, status) VALUES ($1, $2, (SELECT id FROM request_types WHERE key = 'activity'), 1, 'Done', 'completed') RETURNING id", [communityId, requester])).rows[0].id as string;
    const inquiry = (await sql("INSERT INTO inquiries (tenant_id, request_id, vendor_id, snapshot, status) VALUES ($1, $2, $3, '{}', 'quoted') RETURNING id", [communityId, request, vendorId])).rows[0].id as string;
    const quote = (await sql("INSERT INTO quotes (tenant_id, request_id, inquiry_id, vendor_id, status, total_minor) VALUES ($1, $2, $3, $4, 'accepted', 1000) RETURNING id", [communityId, request, inquiry, vendorId])).rows[0].id as string;
    const booking = (await sql("INSERT INTO bookings (tenant_id, request_id, quote_id, vendor_id, status, agreed_total_minor, scheduled_start, vendor_confirmed_at, confirmed_at) VALUES ($1, $2, $3, $4, 'completed', 1000, now() - interval '2 days', now(), now()) RETURNING id", [communityId, request, quote, vendorId])).rows[0].id as string;
    await sql("INSERT INTO reviews (tenant_id, booking_id, vendor_id, requester_id, rating, status) VALUES ($1, $2, $3, $4, $5, $6)", [communityId, booking, vendorId, requester, rating, status]);
  }
  async function publishedOffering(vendorId: string, name: string, over: Record<string, unknown> = {}): Promise<string> {
    const owner = await makeMember(t, email("disc-owner"), vendorId, ["vendor_owner"], { mfa: true });
    const res = await as(owner, vendorId, `${api}/vendors/${vendorId}/offerings`, { method: "POST", body: { ...OFFERING, name, categoryId: categories.find((c) => c.parentId)?.id, status: "published", ...over } });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  }

  it("shows each vendor's published rating on the catalog and filters by it (pending reviews never count)", async () => {
    const home = await activeCommunity("Rating Home");
    const resident = await makeMember(t, email("rres"), home.id, ["resident"]);
    const loved = await activeVendor("Loved Vendor", [home.id]);
    const unrated = await activeVendor("Unrated Vendor", [home.id]);
    for (const v of [loved, unrated]) expect((await as(home.admin, home.id, `${api}/communities/${home.id}/vendors/${v}`, { method: "PUT", body: { status: "approved" } })).statusCode).toBe(200);
    await publishedOffering(loved, "Loved class");
    await publishedOffering(unrated, "Unrated class");
    const rater = await makeMember(t, email("rater"), home.id, ["resident"]);
    await reviewed(home.id, loved, rater.userId, 5, "published");
    await reviewed(home.id, loved, rater.userId, 4, "published");
    await reviewed(home.id, loved, rater.userId, 1, "pending"); // not moderated yet: must not drag the average down or count

    const all = (await as(resident, home.id, `${api}/catalog/offerings`)).json().data as { name: string; rating: { count: number; average: number | null }; saved: boolean }[];
    expect(all.find((o) => o.name === "Loved class")?.rating).toEqual({ count: 2, average: 4.5 });
    expect(all.find((o) => o.name === "Unrated class")?.rating).toEqual({ count: 0, average: null });
    expect(all.every((o) => o.saved === false)).toBe(true);

    const names = async (qs: string) => ((await as(resident, home.id, `${api}/catalog/offerings${qs}`)).json().data as { name: string }[]).map((o) => o.name);
    expect(await names("?minRating=4")).toEqual(["Loved class"]);
    expect(await names("?minRating=5")).toEqual([]); // the average is 4.5
    expect(await names("?minRating=3")).toEqual(["Loved class"]); // an unrated vendor never passes a rating filter
    expect((await as(resident, home.id, `${api}/catalog/offerings?minRating=9`)).statusCode).toBe(400);
    // out-of-range numbers are refused cleanly, never a server error (a price beyond what the database can hold)
    for (const bad of ["maxPriceMinor=99999999999999999999", "maxPriceMinor=-1", "maxPriceMinor=1.5", "maxPriceMinor=abc", "age=101", "age=-1", "minRating=0"]) {
      expect((await as(resident, home.id, `${api}/catalog/offerings?${bad}`)).statusCode, bad).toBe(400);
    }
    expect((await as(resident, home.id, `${api}/catalog/offerings?maxPriceMinor=1000000000000`)).statusCode).toBe(200);
    // a rating is public, but who gave it is not
    expect(JSON.stringify(all)).not.toContain(rater.userId);
    // The author can read their own pending review (row-level security), so only the explicit "published" condition keeps
    // it out of the rating they are shown: check as the author, the one person for whom the other layer does not help.
    const asAuthor = (await as(rater, home.id, `${api}/catalog/offerings`)).json().data as { name: string; rating: { count: number; average: number | null } }[];
    expect(asAuthor.find((o) => o.name === "Loved class")?.rating).toEqual({ count: 2, average: 4.5 });
    expect((await as(rater, home.id, `${api}/catalog/offerings?minRating=4`)).json().data).toHaveLength(1);
  });

  it("lets a resident save and remove offerings privately, with the same answer for ones they cannot see", async () => {
    const home = await activeCommunity("Saved Home");
    const other = await activeCommunity("Saved Elsewhere");
    const alice = await makeMember(t, email("sal"), home.id, ["resident"]);
    const bob = await makeMember(t, email("sbo"), home.id, ["resident"]);
    const stranger = await makeMember(t, email("sst"), other.id, ["resident"]);
    const vendorId = await activeVendor("Saved Vendor", [home.id]);
    const kept = await publishedOffering(vendorId, "Kept class");
    const draftId = await publishedOffering(vendorId, "Draft class", { status: "draft" });
    const saved = (who: { cookie: string }, qs = "") => as(who, home.id, `${api}/catalog/offerings${qs}`);
    const put = (who: { cookie: string }, id: string) => as(who, home.id, `${api}/catalog/offerings/${id}/saved`, { method: "PUT" });
    const del = (who: { cookie: string }, id: string) => as(who, home.id, `${api}/catalog/offerings/${id}/saved`, { method: "DELETE" });

    // nothing is visible until the community approves the vendor, and then saving works
    expect((await put(alice, kept)).statusCode).toBe(404);
    expect((await as(home.admin, home.id, `${api}/communities/${home.id}/vendors/${vendorId}`, { method: "PUT", body: { status: "approved" } })).statusCode).toBe(200);
    expect((await put(alice, kept)).statusCode).toBe(204);
    expect((await put(alice, kept)).statusCode).toBe(204); // idempotent

    // it shows as saved for Alice only, in the list and on the vendor page
    expect((await saved(alice)).json().data[0]).toMatchObject({ name: "Kept class", saved: true });
    expect((await saved(alice, "?savedOnly=true")).json().data).toHaveLength(1);
    expect((await as(alice, home.id, `${api}/catalog/vendors/${vendorId}`)).json().offerings[0]).toMatchObject({ saved: true });
    expect((await saved(bob)).json().data[0]).toMatchObject({ saved: false });
    expect((await saved(bob, "?savedOnly=true")).json().data).toEqual([]);
    expect((await as(bob, home.id, `${api}/catalog/vendors/${vendorId}`)).json().offerings[0]).toMatchObject({ saved: false });
    // nobody else can see or remove it
    expect((await del(bob, kept)).statusCode).toBe(204); // Bob removes "his own" copy: nothing
    expect((await saved(alice, "?savedOnly=true")).json().data).toHaveLength(1);
    expect((await t.db.admin.query("SELECT count(*)::int AS n FROM saved_offerings WHERE user_id = $1", [alice.userId])).rows[0].n).toBe(1);

    // removing one leaves the others
    const second = await publishedOffering(vendorId, "Second class");
    expect((await put(alice, second)).statusCode).toBe(204);
    expect((await del(alice, kept)).statusCode).toBe(204);
    expect(((await saved(alice, "?savedOnly=true")).json().data as { name: string }[]).map((o) => o.name)).toEqual(["Second class"]);
    expect((await put(alice, kept)).statusCode).toBe(204);

    // what cannot be seen cannot be saved: a draft, an unknown id, another community, platform scope, no session, no origin
    expect((await put(alice, draftId)).statusCode).toBe(404);
    expect((await put(alice, randomUUID())).statusCode).toBe(404);
    expect((await put(alice, "not-a-uuid")).statusCode).toBe(400);
    expect((await as(stranger, home.id, `${api}/catalog/offerings/${kept}/saved`, { method: "PUT" })).statusCode).toBe(403);
    expect((await as(stranger, other.id, `${api}/catalog/offerings/${kept}/saved`, { method: "PUT" })).statusCode).toBe(404);
    expect((await asOps(`${api}/catalog/offerings/${kept}/saved`, { method: "PUT" })).statusCode).toBe(403);
    expect((await call(t.app, { method: "PUT", url: `${api}/catalog/offerings/${kept}/saved` })).statusCode).toBe(401);
    expect((await as(alice, home.id, `${api}/catalog/offerings/${kept}/saved`, { method: "PUT", origin: "https://evil.example" })).statusCode).toBe(403);

    // removing is idempotent, and a withdrawn offering drops out of the saved list
    expect((await put(bob, kept)).statusCode).toBe(204);
    expect((await del(bob, kept)).statusCode).toBe(204);
    expect((await del(bob, kept)).statusCode).toBe(204);
    expect((await post(asOps, `${api}/vendors/${vendorId}/transitions`, { to: "suspended", note: "Investigation" })).statusCode).toBe(200);
    expect((await saved(alice, "?savedOnly=true")).json().data).toEqual([]);
    expect((await put(alice, kept)).statusCode).toBe(404);
  });

  it("stops one person saving more than 200 offerings in a community, with a clear message", async () => {
    const home = await activeCommunity("Limit Home");
    const resident = await makeMember(t, email("lres"), home.id, ["resident"]);
    const vendorId = await activeVendor("Limit Vendor", [home.id]);
    expect((await as(home.admin, home.id, `${api}/communities/${home.id}/vendors/${vendorId}`, { method: "PUT", body: { status: "approved" } })).statusCode).toBe(200);
    const first = await publishedOffering(vendorId, "Limit one");
    const extra = await publishedOffering(vendorId, "Limit two");
    await t.db.admin.query(
      `INSERT INTO offerings (tenant_id, category_id, name, pricing_model, price_minor, status)
         SELECT $1, (SELECT id FROM categories WHERE key = 'magic_shows'), 'Fill ' || n, 'fixed', 100, 'published' FROM generate_series(1, 199) n`,
      [vendorId],
    );
    await t.db.admin.query("INSERT INTO saved_offerings (tenant_id, user_id, offering_id) SELECT $1, $2, id FROM offerings WHERE name LIKE 'Fill %'", [home.id, resident.userId]);
    const put = (id: string) => as(resident, home.id, `${api}/catalog/offerings/${id}/saved`, { method: "PUT" });
    expect((await put(first)).statusCode).toBe(204); // the 200th
    expect((await put(first)).statusCode).toBe(204); // saving it again is not "one more"
    const over = await put(extra);
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe("too_many_saved");
  });
});

describe("vetting must stay current (Phase 4 review)", () => {
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  it("hides a vendor from families the moment a required document lapses, flags it to the platform team, and restores it on renewal", async () => {
    const home = await activeCommunity("Lapse Gardens");
    const resident = await makeMember(t, email("lres"), home.id, ["resident"]);
    const vendorId = await activeVendor("Lapsing Vendor", [home.id]);
    const owner = await makeMember(t, email("lown"), vendorId, ["vendor_owner"], { mfa: true });
    const cat = categories.find((c) => c.parentId)?.id as string;
    const offering = await as(owner, vendorId, `${api}/vendors/${vendorId}/offerings`, { method: "POST", body: { ...OFFERING, categoryId: cat, status: "published" } });
    expect(offering.statusCode, offering.body).toBe(201);
    expect((await as(home.admin, home.id, `${api}/communities/${home.id}/vendors/${vendorId}`, { method: "PUT", body: { status: "approved" } })).statusCode).toBe(200);
    const browse = async () => (await as(resident, home.id, `${api}/catalog/offerings`)).json().data as unknown[];
    const listed = async (vetting: string) => ((await asOps(`${api}/vendors?vetting=${vetting}&q=Lapsing`)).json().data as { id: string }[]).map((v) => v.id);

    expect(await browse()).toHaveLength(1);
    expect((await asOps(`${api}/vendors/${vendorId}`)).json().vetting).toEqual({ state: "current", validUntil: null });
    expect(await listed("lapsed")).toEqual([]);

    // time passes: the background check expires (arranged directly; nothing else changes)
    await t.db.admin.query("UPDATE vendor_documents SET expires_on = current_date - 1 WHERE tenant_id = $1 AND requirement_key = 'background_check'", [vendorId]);
    expect(await browse()).toEqual([]); // hidden at once, no job needed
    expect((await as(resident, home.id, `${api}/catalog/vendors/${vendorId}`)).statusCode).toBe(404);
    expect((await asOps(`${api}/vendors/${vendorId}`)).json().vetting.state).toBe("lapsed");
    expect(await listed("lapsed")).toEqual([vendorId]);
    const vetting = (await asOps(`${api}/vendors/${vendorId}/vetting`)).json();
    expect(vetting.requirements.find((r: { key: string }) => r.key === "background_check").state).toBe("expired");
    // the vendor's own team sees it too, so they know to renew
    expect((await as(owner, vendorId, `${api}/vendors/${vendorId}`)).json().vetting.state).toBe("lapsed");
    // still an active vendor: the platform decides whether to suspend; nothing is deleted
    expect((await asOps(`${api}/vendors/${vendorId}`)).json().status).toBe("active");

    // renewal: a new document is submitted and verified, with a date that will lapse soon
    const doc = await as(owner, vendorId, `${api}/vendors/${vendorId}/documents`, { method: "POST", body: { requirementKey: "background_check", title: "Renewed police verification", expiresOn: inDays(10) } });
    expect(doc.statusCode, doc.body).toBe(201);
    expect(await browse()).toEqual([]); // submitting is not enough
    expect((await post(asOps, `${api}/vendors/${vendorId}/documents/${doc.json().id}/review`, { decision: "verify" })).statusCode).toBe(200);
    expect(await browse()).toHaveLength(1);
    const state = (await asOps(`${api}/vendors/${vendorId}`)).json().vetting;
    expect(state).toEqual({ state: "expiring", validUntil: inDays(10) });
    expect(await listed("expiring")).toEqual([vendorId]);
    expect(await listed("lapsed")).toEqual([]);
    expect((await asOps(`${api}/vendors?vetting=nonsense`)).statusCode).toBe(400);
  });

  it("does not hide a vendor that is not yet active, and shows no vetting state for it", async () => {
    const id = await newVendor("Still Draft");
    expect((await asOps(`${api}/vendors/${id}`)).json().vetting).toBeNull();
  });
});

describe("two-step verification for vendor owners and administrators (Phase 4 review)", () => {
  it("blocks owners and administrators until they enrol, but not ordinary vendor staff", async () => {
    const id = await newVendor("Mfa Vendor");
    const owner = await makeMember(t, email("nomfa-owner"), id, ["vendor_owner"], { mfa: false });
    const res = await as(owner, id, `${api}/vendors/${id}`);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("mfa_enrollment_required");
    const admin = await makeMember(t, email("nomfa-admin"), id, ["vendor_admin"], { mfa: false });
    expect((await as(admin, id, `${api}/vendors/${id}/offerings`)).json().error.code).toBe("mfa_enrollment_required");
    const staff = await makeMember(t, email("nomfa-staff"), id, ["vendor_staff"], { mfa: false });
    expect((await as(staff, id, `${api}/vendors/${id}/availability`)).statusCode).toBe(200);
    // once enrolled, the owner is let in
    const { enrollMfa } = await import("./helpers");
    await enrollMfa(t.app, owner.cookie);
    expect((await as(owner, id, `${api}/vendors/${id}`)).statusCode).toBe(200);
  });
});

describe("limits", () => {
  it("caps documents and offerings per vendor", async () => {
    const id = await newVendor("Capped Vendor");
    const owner = await makeMember(t, email("cap"), id, ["vendor_owner"], { mfa: true });
    await t.db.admin.query("INSERT INTO vendor_documents (tenant_id, requirement_key, title) SELECT $1, 'insurance', 'filler ' || n FROM generate_series(1, 100) n", [id]);
    const doc = await as(owner, id, `${api}/vendors/${id}/documents`, { method: "POST", body: { requirementKey: "insurance", title: "one more" } });
    expect(doc.statusCode).toBe(422);
    expect(doc.json().error.code).toBe("limit_reached");

    const cat = categories.find((c) => c.parentId)?.id as string;
    await t.db.admin.query("INSERT INTO offerings (tenant_id, category_id, name, pricing_model, price_minor) SELECT $1, $2, 'filler ' || n, 'fixed', 100 FROM generate_series(1, 200) n", [id, cat]);
    const offering = await as(owner, id, `${api}/vendors/${id}/offerings`, { method: "POST", body: { ...OFFERING, categoryId: cat } });
    expect(offering.statusCode).toBe(422);
    expect(offering.json().error.code).toBe("limit_reached");
  });
});
