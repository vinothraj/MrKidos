import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, makeMember, makeStaff, markEmailVerified, PLATFORM_SCOPE, register, type TestApp } from "./helpers";

let t: TestApp;
let ops: { cookie: string; userId: string }; // business_operations: create, verify, assign admins (cannot approve)
let boss: { cookie: string; userId: string }; // platform_admin: approve (cannot create)
let seq = 0;
const email = (p: string) => `${p}${++seq}@example.test`;

const FULL = {
  name: "Aqualily",
  communityType: "gated_community",
  country: "India",
  state: "Karnataka",
  city: "Bengaluru",
  locality: "Whitefield",
  address: "12 Lake Road",
  latitude: 12.97,
  longitude: 77.75,
  contactName: "Ramesh Kumar",
  contactEmail: "ramesh@example.test",
  contactPhone: "+91 98765 43210",
  unitCount: 420,
  population: 1500,
};

const asOps = (url: string, extra: Partial<Parameters<typeof call>[1]> = {}) => call(t.app, { url, cookie: ops.cookie, headers: PLATFORM_SCOPE, ...extra });
const asBoss = (url: string, extra: Partial<Parameters<typeof call>[1]> = {}) => call(t.app, { url, cookie: boss.cookie, headers: PLATFORM_SCOPE, ...extra });
const post = (who: typeof asOps, url: string, body: unknown) => who(url, { method: "POST", body });

async function newCommunity(over: Record<string, unknown> = {}): Promise<string> {
  const res = await post(asOps, "/api/v1/communities", { ...FULL, ...over });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/** Brings a community to `active` through the real workflow. */
async function activate(id: string): Promise<{ adminEmail: string }> {
  expect((await post(asOps, `/api/v1/communities/${id}/transitions`, { to: "verification" })).statusCode).toBe(200);
  const adminEmail = email("activeadmin");
  await register(t.app, adminEmail);
  expect((await post(asOps, `/api/v1/communities/${id}/admins`, { email: adminEmail })).statusCode).toBe(201);
  const res = await post(asBoss, `/api/v1/communities/${id}/transitions`, { to: "active", note: "Verified on site." });
  expect(res.statusCode, res.body).toBe(200);
  return { adminEmail };
}

beforeAll(async () => {
  t = await createTestApp();
  ops = await makeStaff(t, "ops@example.test", "business_operations");
  boss = await makeStaff(t, "boss@example.test", "platform_admin");
});
afterAll(async () => {
  await t.close();
});

describe("registering a community", () => {
  it("lets platform operations register a community as a draft, with full details and history", async () => {
    const res = await post(asOps, "/api/v1/communities", FULL);
    expect(res.statusCode).toBe(201);
    const c = res.json();
    expect(c).toMatchObject({ name: "Aqualily", status: "draft", city: "Bengaluru", address: "12 Lake Road", latitude: 12.97, unitCount: 420, communityType: "gated_community" });

    const history = await asOps(`/api/v1/communities/${c.id}/history`);
    expect(history.json().data.map((h: { to: string }) => h.to)).toEqual(["draft"]);
    const audit = await t.db.admin.query("SELECT action FROM audit_log WHERE tenant_id = $1", [c.id]);
    expect(audit.rows.map((r) => r.action)).toContain("community.created");
  });

  it("accepts a minimal registration (name only) and fills the rest later", async () => {
    const res = await post(asOps, "/api/v1/communities", { name: "Minimal Heights" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "draft", city: null, address: null });
  });

  it("refuses people without the permission, non-staff, and attempts to skip the workflow", async () => {
    const resident = await register(t.app, email("res"));
    await markEmailVerified(t.db, resident.userId);
    expect((await call(t.app, { method: "POST", url: "/api/v1/communities", cookie: resident.cookie, headers: PLATFORM_SCOPE, body: FULL })).statusCode).toBe(403);
    expect((await call(t.app, { method: "POST", url: "/api/v1/communities", cookie: resident.cookie, body: FULL })).statusCode).toBe(400); // no tenant selected
    // platform_admin holds approve but not create
    expect((await post(asBoss, "/api/v1/communities", FULL)).statusCode).toBe(403);
    // mass assignment of status or id is rejected
    for (const extra of [{ status: "active" }, { id: randomUUID() }, { type: "platform" }]) {
      expect((await post(asOps, "/api/v1/communities", { ...FULL, ...extra })).statusCode).toBe(400);
    }
  });

  it("validates every field", async () => {
    const bad: Record<string, unknown>[] = [
      { name: "x" },
      { latitude: 120 },
      { longitude: -200 },
      { unitCount: 0 },
      { unitCount: 1.5 },
      { contactEmail: "nope" },
      { communityType: "castle" },
      { description: "d".repeat(2001) },
    ];
    for (const over of bad) {
      expect((await post(asOps, "/api/v1/communities", { ...FULL, ...over })).statusCode, JSON.stringify(over)).toBe(400);
    }
  });

  it("is a platform-only action even for a community administrator", async () => {
    const orgId = await newCommunity({ name: "Admin Owns This" });
    const admin = await makeMember(t, email("cadm"), orgId, ["community_admin"]);
    const res = await call(t.app, { method: "POST", url: "/api/v1/communities", cookie: admin.cookie, headers: { "x-tenant-id": orgId }, body: FULL });
    expect(res.statusCode).toBe(403);
  });
});

describe("listing and access boundaries", () => {
  it("lists communities for platform staff with filters, search and keyset pagination, without private details", async () => {
    for (const n of ["Zeta Park", "Zeta Gardens", "Zeta Towers"]) await newCommunity({ name: n, city: "Zetaville" });
    const search = await asOps("/api/v1/communities?q=zeta&limit=2");
    expect(search.statusCode).toBe(200);
    const names: string[] = [];
    let url = "/api/v1/communities?q=zeta&limit=2";
    for (let i = 0; i < 5; i++) {
      const r = await asOps(url);
      for (const row of r.json().data) {
        names.push(row.name);
        expect(row.address).toBeUndefined();
        expect(row.contactEmail).toBeUndefined();
      }
      if (!r.json().page.nextCursor) break;
      url = `/api/v1/communities?q=zeta&limit=2&cursor=${encodeURIComponent(r.json().page.nextCursor)}`;
    }
    expect(names.sort()).toEqual(["Zeta Gardens", "Zeta Park", "Zeta Towers"]);
    expect((await asOps("/api/v1/communities?status=active&q=zeta")).json().data).toHaveLength(0);
    expect((await asOps("/api/v1/communities?status=bogus")).statusCode).toBe(400);
    expect((await asOps("/api/v1/communities?q=%25")).json().data).toHaveLength(0); // a literal percent sign, not a wildcard
  });

  it("keeps each community's administrators inside their own community", async () => {
    const a = await newCommunity({ name: "Community A1" });
    const b = await newCommunity({ name: "Community B1" });
    const adminA = await makeMember(t, email("adminA"), a, ["community_admin"]);
    const ctx = { cookie: adminA.cookie, headers: { "x-tenant-id": a } };

    const own = await call(t.app, { url: `/api/v1/communities/${a}`, ...ctx });
    expect(own.statusCode).toBe(200);
    expect(own.json().address).toBe("12 Lake Road");

    // Another community answers exactly like a community that does not exist.
    for (const id of [b, randomUUID()]) {
      const res = await call(t.app, { url: `/api/v1/communities/${id}`, ...ctx });
      expect(res.statusCode).toBe(404);
      expect((await call(t.app, { method: "PATCH", url: `/api/v1/communities/${id}`, body: { name: "Hijacked" }, ...ctx })).statusCode).toBe(404);
      expect((await call(t.app, { url: `/api/v1/communities/${id}/facilities`, ...ctx })).statusCode).toBe(404);
    }
    // community administrators cannot enumerate communities
    expect((await call(t.app, { url: "/api/v1/communities", ...ctx })).json().error.code).toBe("platform_scope_required");
    expect((await asOps(`/api/v1/communities/${b}`)).json().name).toBe("Community B1");
  });

  it("denies residents (no community permission) even inside their own community", async () => {
    const a = await newCommunity({ name: "Residents Only" });
    const resident = await makeMember(t, email("resA"), a, ["resident"]);
    const res = await call(t.app, { url: `/api/v1/communities/${a}`, cookie: resident.cookie, headers: { "x-tenant-id": a } });
    expect(res.statusCode).toBe(403);
  });

  it("lets a community administrator edit their profile but never the status", async () => {
    const a = await newCommunity({ name: "Editable" });
    const admin = await makeMember(t, email("edit"), a, ["community_admin"]);
    const ctx = { cookie: admin.cookie, headers: { "x-tenant-id": a } };
    const ok = await call(t.app, { method: "PATCH", url: `/api/v1/communities/${a}`, body: { description: "A lovely place.", locality: "Marathahalli" }, ...ctx });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ description: "A lovely place.", locality: "Marathahalli", name: "Editable" });
    expect((await call(t.app, { method: "PATCH", url: `/api/v1/communities/${a}`, body: { status: "active" }, ...ctx })).statusCode).toBe(400);
    expect((await call(t.app, { method: "PATCH", url: `/api/v1/communities/${a}`, body: {}, ...ctx })).statusCode).toBe(400);
    const audit = await t.db.admin.query("SELECT metadata FROM audit_log WHERE tenant_id = $1 AND action = 'community.updated'", [a]);
    expect(audit.rows[0].metadata.fields).toEqual(["description", "locality"]);
    expect(JSON.stringify(audit.rows)).not.toContain("A lovely place"); // values may be personal data: names only
  });
});

describe("onboarding workflow", () => {
  it("walks registration, verification, administrator assignment, approval and activation, with checklists", async () => {
    const id = await newCommunity({ name: "Workflow Estates" });
    const draft = (await asOps(`/api/v1/communities/${id}`)).json();
    expect(draft.transitions).toEqual([{ to: "verification", noteRequired: false, blockers: [] }]);

    // verification is blocked for an incomplete record, and says exactly what is missing
    const bare = await post(asOps, "/api/v1/communities", { name: "Bare Bones" });
    const bareId = bare.json().id as string;
    const blocked = await post(asOps, `/api/v1/communities/${bareId}/transitions`, { to: "verification" });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe("transition_blocked");
    expect(blocked.json().error.details).toEqual(expect.arrayContaining(["Add the city.", "Add the street address.", "Add a contact email or phone number."]));

    expect((await post(asOps, `/api/v1/communities/${id}/transitions`, { to: "verification" })).json().status).toBe("verification");

    // activation: needs an administrator first, then the approver (ops may not approve)
    const needAdmin = await post(asBoss, `/api/v1/communities/${id}/transitions`, { to: "active", note: "ok" });
    expect(needAdmin.statusCode).toBe(422);
    expect(needAdmin.json().error.details).toEqual(["Assign at least one community administrator."]);

    const unknown = await post(asOps, `/api/v1/communities/${id}/admins`, { email: "ghost@example.test" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("user_not_found");

    const adminEmail = email("wfadmin");
    await register(t.app, adminEmail);
    const assigned = await post(asOps, `/api/v1/communities/${id}/admins`, { email: adminEmail });
    expect(assigned.statusCode).toBe(201);
    expect(assigned.json().data.map((a: { email: string }) => a.email)).toEqual([adminEmail]);
    expect((await post(asOps, `/api/v1/communities/${id}/admins`, { email: adminEmail })).statusCode).toBe(201); // idempotent
    expect((await asOps(`/api/v1/communities/${id}/admins`)).json().data).toHaveLength(1);

    const byOps = await post(asOps, `/api/v1/communities/${id}/transitions`, { to: "active", note: "ok" });
    expect(byOps.statusCode).toBe(403);
    const noNote = await post(asBoss, `/api/v1/communities/${id}/transitions`, { to: "active" });
    expect(noNote.json().error.code).toBe("note_required");
    const done = await post(asBoss, `/api/v1/communities/${id}/transitions`, { to: "active", note: "Documents checked on site." });
    expect(done.statusCode).toBe(200);
    expect(done.json().status).toBe("active");

    const history = (await asBoss(`/api/v1/communities/${id}/history`)).json().data;
    expect(history.map((h: { to: string }) => h.to)).toEqual(["active", "verification", "draft"]);
    expect(history[0].note).toBe("Documents checked on site.");
  });

  it("rejects steps the workflow does not allow", async () => {
    const id = await newCommunity({ name: "Invalid Steps" });
    for (const to of ["active", "suspended", "draft"]) {
      const res = await post(asOps, `/api/v1/communities/${id}/transitions`, { to });
      expect(res.statusCode, to).toBe(409);
      expect(res.json().error.code).toBe("invalid_transition");
    }
    expect((await post(asOps, `/api/v1/communities/${id}/transitions`, { to: "nonsense" })).statusCode).toBe(400);
    expect((await post(asOps, `/api/v1/communities/${randomUUID()}/transitions`, { to: "verification" })).statusCode).toBe(404);
  });

  it("can send a community back for changes, and suspend and reinstate an active one", async () => {
    const id = await newCommunity({ name: "Back And Forth" });
    await post(asOps, `/api/v1/communities/${id}/transitions`, { to: "verification" });
    expect((await post(asOps, `/api/v1/communities/${id}/transitions`, { to: "draft" })).json().error.code).toBe("note_required");
    expect((await post(asOps, `/api/v1/communities/${id}/transitions`, { to: "draft", note: "Address needs correcting." })).json().status).toBe("draft");

    await activate(id);
    expect((await post(asBoss, `/api/v1/communities/${id}/transitions`, { to: "suspended", note: "Safety review." })).json().status).toBe("suspended");
    expect((await post(asBoss, `/api/v1/communities/${id}/transitions`, { to: "active", note: "Review complete." })).json().status).toBe("active");
  });

  it("will not remove the last administrator of an active community, but allows it once another exists", async () => {
    const id = await newCommunity({ name: "Admin Guard" });
    const { adminEmail } = await activate(id);
    const first = (await asOps(`/api/v1/communities/${id}/admins`)).json().data[0].userId as string;
    const blocked = await asOps(`/api/v1/communities/${id}/admins/${first}`, { method: "DELETE" });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe("last_admin");

    const second = email("second");
    await register(t.app, second);
    await post(asOps, `/api/v1/communities/${id}/admins`, { email: second });
    expect((await asOps(`/api/v1/communities/${id}/admins/${first}`, { method: "DELETE" })).statusCode).toBe(204);
    expect((await asOps(`/api/v1/communities/${id}/admins`)).json().data.map((a: { email: string }) => a.email)).toEqual([second]);
    expect(adminEmail).toBeTruthy();
    expect((await asOps(`/api/v1/communities/${id}/admins/${randomUUID()}`, { method: "DELETE" })).statusCode).toBe(404);
  });

  it("keeps administrator assignment with the platform team, not with community administrators", async () => {
    const id = await newCommunity({ name: "No Self Service" });
    const admin = await makeMember(t, email("selfadm"), id, ["community_admin"]);
    const friend = email("friend");
    await register(t.app, friend);
    const res = await call(t.app, { method: "POST", url: `/api/v1/communities/${id}/admins`, cookie: admin.cookie, headers: { "x-tenant-id": id }, body: { email: friend } });
    expect(res.statusCode).toBe(403);
  });
});

describe("facilities", () => {
  it("lets a community administrator manage venues with validation", async () => {
    const id = await newCommunity({ name: "Venue Village" });
    const admin = await makeMember(t, email("fac"), id, ["community_admin"]);
    const ctx = { cookie: admin.cookie, headers: { "x-tenant-id": id } };
    const created = await call(t.app, { method: "POST", url: `/api/v1/communities/${id}/facilities`, body: { name: "Clubhouse", kind: "clubhouse", capacity: 150 }, ...ctx });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: "Clubhouse", kind: "clubhouse", capacity: 150, bookable: true });
    const fid = created.json().id as string;

    expect((await call(t.app, { method: "PATCH", url: `/api/v1/communities/${id}/facilities/${fid}`, body: { capacity: 200, bookable: false }, ...ctx })).json()).toMatchObject({ capacity: 200, bookable: false });
    const list = await call(t.app, { url: `/api/v1/communities/${id}/facilities`, ...ctx });
    expect(list.json().data).toHaveLength(1);

    for (const bad of [{ name: "", kind: "hall" }, { name: "X", kind: "castle" }, { name: "X", kind: "hall", capacity: -1 }, { name: "X", kind: "hall", tenant_id: id }]) {
      expect((await call(t.app, { method: "POST", url: `/api/v1/communities/${id}/facilities`, body: bad, ...ctx })).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await call(t.app, { method: "DELETE", url: `/api/v1/communities/${id}/facilities/${fid}`, ...ctx })).statusCode).toBe(204);
    expect((await call(t.app, { method: "DELETE", url: `/api/v1/communities/${id}/facilities/${fid}`, ...ctx })).statusCode).toBe(404);
  });

  it("never lets one community touch another's venues, by id or by route", async () => {
    const a = await newCommunity({ name: "Venue A" });
    const b = await newCommunity({ name: "Venue B" });
    const adminA = await makeMember(t, email("facA"), a, ["community_admin"]);
    const adminB = await makeMember(t, email("facB"), b, ["community_admin"]);
    const mk = await call(t.app, { method: "POST", url: `/api/v1/communities/${b}/facilities`, body: { name: "B Hall", kind: "hall" }, cookie: adminB.cookie, headers: { "x-tenant-id": b } });
    const bFacility = mk.json().id as string;
    const ctxA = { cookie: adminA.cookie, headers: { "x-tenant-id": a } };
    // B's facility id addressed through A's own route: not found (the query is scoped to A)
    expect((await call(t.app, { method: "PATCH", url: `/api/v1/communities/${a}/facilities/${bFacility}`, body: { name: "Mine now" }, ...ctxA })).statusCode).toBe(404);
    expect((await call(t.app, { method: "DELETE", url: `/api/v1/communities/${a}/facilities/${bFacility}`, ...ctxA })).statusCode).toBe(404);
    // ...and through B's route: not found as well (not A's community)
    expect((await call(t.app, { method: "PATCH", url: `/api/v1/communities/${b}/facilities/${bFacility}`, body: { name: "Mine now" }, ...ctxA })).statusCode).toBe(404);
    const still = await t.db.admin.query("SELECT name FROM community_facilities WHERE id = $1", [bFacility]);
    expect(still.rows[0].name).toBe("B Hall");
  });

  it("caps the number of facilities and lets platform operations manage any community's venues", async () => {
    const id = await newCommunity({ name: "Capped" });
    await t.db.admin.query("INSERT INTO community_facilities (tenant_id, name, kind) SELECT $1, 'F' || g, 'hall' FROM generate_series(1, 100) g", [id]);
    const res = await post(asOps, `/api/v1/communities/${id}/facilities`, { name: "One too many", kind: "hall" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("limit_reached");
    const other = await newCommunity({ name: "Ops Managed" });
    expect((await post(asOps, `/api/v1/communities/${other}/facilities`, { name: "Court", kind: "court" })).statusCode).toBe(201);
  });

  it("does not let residents add venues", async () => {
    const id = await newCommunity({ name: "Resident Venue" });
    const resident = await makeMember(t, email("resfac"), id, ["resident"]);
    const res = await call(t.app, { method: "POST", url: `/api/v1/communities/${id}/facilities`, body: { name: "My House", kind: "hall" }, cookie: resident.cookie, headers: { "x-tenant-id": id } });
    expect(res.statusCode).toBe(403);
  });
});

describe("policies", () => {
  it("lists configurable policies with defaults, and stores validated values", async () => {
    const id = await newCommunity({ name: "Policy Park" });
    const admin = await makeMember(t, email("pol"), id, ["community_admin"]);
    const ctx = { cookie: admin.cookie, headers: { "x-tenant-id": id } };

    const list = (await call(t.app, { url: `/api/v1/communities/${id}/policies`, ...ctx })).json().data as { key: string; isDefault: boolean; value: unknown }[];
    expect(list.map((p) => p.key)).toEqual(["resident_join_mode", "vendor_approval_required", "event_approval_required", "vendor_entry_requirements", "quiet_hours", "require_two_step_all_members", "invite_code_max_days"]);
    expect(list.every((p) => p.isDefault)).toBe(true);
    expect(list.find((p) => p.key === "vendor_approval_required")?.value).toBe(true); // safe default for a children's platform

    const put = (key: string, value: unknown) => call(t.app, { method: "PUT", url: `/api/v1/communities/${id}/policies/${key}`, body: { value }, ...ctx });
    const changed = await put("resident_join_mode", "invite_code_only");
    expect(changed.statusCode).toBe(200);
    expect(changed.json().data.find((p: { key: string }) => p.key === "resident_join_mode")).toMatchObject({ value: "invite_code_only", isDefault: false });
    expect((await put("vendor_approval_required", false)).statusCode).toBe(200);
    expect((await put("quiet_hours", "  22:00-07:00  ")).json().data.find((p: { key: string }) => p.key === "quiet_hours").value).toBe("22:00-07:00");

    expect((await put("resident_join_mode", "open_to_all")).statusCode).toBe(400); // not an allowed value
    expect((await put("vendor_approval_required", "yes")).statusCode).toBe(400); // wrong type
    expect((await put("quiet_hours", "x".repeat(501))).statusCode).toBe(400);
    expect((await put("not_a_policy", true)).statusCode).toBe(404);
    expect((await call(t.app, { method: "PUT", url: `/api/v1/communities/${id}/policies/quiet_hours`, body: { value: "x", extra: 1 }, ...ctx })).statusCode).toBe(400);

    const audit = await t.db.admin.query("SELECT entity_id FROM audit_log WHERE tenant_id = $1 AND action = 'community.policy_changed' ORDER BY created_at", [id]);
    expect(audit.rows.map((r) => r.entity_id)).toEqual(["resident_join_mode", "vendor_approval_required", "quiet_hours"]);
  });

  it("keeps policies separate per community and behind the permission", async () => {
    const a = await newCommunity({ name: "Policy A" });
    const b = await newCommunity({ name: "Policy B" });
    const adminA = await makeMember(t, email("polA"), a, ["community_admin"]);
    const resident = await makeMember(t, email("polR"), a, ["resident"]);
    const ctxA = { cookie: adminA.cookie, headers: { "x-tenant-id": a } };
    await call(t.app, { method: "PUT", url: `/api/v1/communities/${a}/policies/quiet_hours`, body: { value: "A only" }, ...ctxA });
    expect((await call(t.app, { method: "PUT", url: `/api/v1/communities/${b}/policies/quiet_hours`, body: { value: "hijack" }, ...ctxA })).statusCode).toBe(404);
    const bList = (await asOps(`/api/v1/communities/${b}/policies`)).json().data;
    expect(bList.find((p: { key: string }) => p.key === "quiet_hours")).toMatchObject({ value: "", isDefault: true });
    const res = await call(t.app, { method: "PUT", url: `/api/v1/communities/${a}/policies/quiet_hours`, body: { value: "resident edit" }, cookie: resident.cookie, headers: { "x-tenant-id": a } });
    expect(res.statusCode).toBe(403);
  });
});

describe("platform-only internal notes", () => {
  it("are kept by the platform team and invisible to the community's own administrators", async () => {
    const id = await newCommunity({ name: "Notes Estates", internalNotes: "Chairman prefers phone calls; vetted 12 Nov." });
    const admin = await makeMember(t, email("notesadm"), id, ["community_admin"]);
    const ctx = { cookie: admin.cookie, headers: { "x-tenant-id": id } };

    expect((await asOps(`/api/v1/communities/${id}`)).json().internalNotes).toBe("Chairman prefers phone calls; vetted 12 Nov.");
    const seenByAdmin = await call(t.app, { url: `/api/v1/communities/${id}`, ...ctx });
    expect(seenByAdmin.statusCode).toBe(200);
    expect(seenByAdmin.json().internalNotes).toBeNull();
    expect(seenByAdmin.body).not.toContain("Chairman");

    // the administrator cannot read, write or clear them
    const write = await call(t.app, { method: "PATCH", url: `/api/v1/communities/${id}`, body: { internalNotes: "mine now" }, ...ctx });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.code).toBe("platform_only_field");
    expect((await call(t.app, { method: "PATCH", url: `/api/v1/communities/${id}`, body: { internalNotes: null }, ...ctx })).statusCode).toBe(403);
    expect((await call(t.app, { method: "PATCH", url: `/api/v1/communities/${id}`, body: { description: "Fine to change." }, ...ctx })).statusCode).toBe(200);
    expect((await asOps(`/api/v1/communities/${id}`)).json().internalNotes).toBe("Chairman prefers phone calls; vetted 12 Nov.");

    // the platform team can update and clear them; they never appear in lists
    expect((await asOps(`/api/v1/communities/${id}`, { method: "PATCH", body: { internalNotes: "Second visit done." } })).json().internalNotes).toBe("Second visit done.");
    expect((await asOps(`/api/v1/communities/${id}`, { method: "PATCH", body: { internalNotes: null } })).json().internalNotes).toBeNull();
    expect((await asOps("/api/v1/communities?q=Notes Estates")).body).not.toContain("internalNotes\":\"");
  });
});

describe("suspended communities are switched off for their own people", () => {
  it("blocks administrators and residents everywhere except for the platform team, and lifts when reinstated", async () => {
    const id = await newCommunity({ name: "Switch Off Estates" });
    await activate(id);
    const admin = await makeMember(t, email("soadm"), id, ["community_admin"]);
    const resident = await makeMember(t, email("sores"), id, ["resident"]);
    // both were acting in the community before it was suspended
    for (const person of [admin, resident]) {
      expect((await call(t.app, { method: "POST", url: "/api/v1/me/tenants/switch", cookie: person.cookie, body: { tenantId: id } })).statusCode).toBe(204);
    }
    const adminCtx = { cookie: admin.cookie, headers: { "x-tenant-id": id } };
    expect((await call(t.app, { url: `/api/v1/communities/${id}/members`, ...adminCtx })).statusCode).toBe(200);

    await post(asBoss, `/api/v1/communities/${id}/transitions`, { to: "suspended", note: "Safety review." });

    // staff lose every tool: reading, editing, approving members, creating codes
    for (const [method, url, body] of [
      ["GET", `/api/v1/communities/${id}`, undefined],
      ["PATCH", `/api/v1/communities/${id}`, { description: "x" }],
      ["GET", `/api/v1/communities/${id}/members`, undefined],
      ["POST", `/api/v1/communities/${id}/invite-codes`, { label: "x", maxUses: 1 }],
      ["POST", `/api/v1/communities/${id}/facilities`, { name: "x", kind: "hall" }],
    ] as const) {
      const res = await call(t.app, { method, url, ...adminCtx, ...(body ? { body } : {}) });
      expect(res.statusCode, `${method} ${url} -> ${res.body}`).toBe(403);
      expect(res.json().error?.code, `${method} ${url} -> ${res.body}`).toBe("tenant_suspended");
    }
    // an ordinary member is stopped before the permission check even happens (/me itself tolerates it, see below)
    expect((await call(t.app, { url: `/api/v1/communities/${id}/members`, cookie: resident.cookie, headers: { "x-tenant-id": id } })).json().error.code).toBe("tenant_suspended");

    // /me keeps working for their session, tells them why, and shows the organization as suspended
    for (const person of [admin, resident]) {
      const me = await call(t.app, { url: "/api/v1/me", cookie: person.cookie });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ activeTenantId: null, activeOrganizationSuspended: true, permissions: [] });
      expect(me.json().tenants).toMatchObject([{ id, status: "suspended" }]);
    }
    // they cannot switch back into it
    const sw = await call(t.app, { method: "POST", url: "/api/v1/me/tenants/switch", cookie: admin.cookie, body: { tenantId: id } });
    expect(sw.statusCode).toBe(403);
    expect(sw.json().error.code).toBe("tenant_suspended");

    // platform staff are unaffected and can still manage it
    expect((await asOps(`/api/v1/communities/${id}`)).statusCode).toBe(200);
    expect((await asOps(`/api/v1/communities/${id}/members`)).statusCode).toBe(200);

    // reinstating restores everything
    await post(asBoss, `/api/v1/communities/${id}/transitions`, { to: "active", note: "Review complete." });
    expect((await call(t.app, { url: `/api/v1/communities/${id}/members`, ...adminCtx })).statusCode).toBe(200);
    expect((await call(t.app, { url: "/api/v1/me", cookie: admin.cookie })).json()).toMatchObject({ activeTenantId: id, activeOrganizationSuspended: false });
  });

  it("does not block a community that is still being set up (draft or in verification)", async () => {
    const id = await newCommunity({ name: "Still Setting Up" });
    const admin = await makeMember(t, email("setupadm"), id, ["community_admin"]);
    const ctx = { cookie: admin.cookie, headers: { "x-tenant-id": id } };
    expect((await call(t.app, { url: `/api/v1/communities/${id}`, ...ctx })).statusCode).toBe(200);
    await post(asOps, `/api/v1/communities/${id}/transitions`, { to: "verification" });
    expect((await call(t.app, { method: "POST", url: `/api/v1/communities/${id}/facilities`, body: { name: "Clubhouse", kind: "clubhouse" }, ...ctx })).statusCode).toBe(201);
  });
});

describe("community directory", () => {
  it("shows only ACTIVE communities, only public details, to any signed-in user", async () => {
    const live = await newCommunity({ name: "Directory Lake", city: "Pune", locality: "Baner" });
    await activate(live);
    await newCommunity({ name: "Directory Hidden Draft" });

    const resident = await register(t.app, email("finder"));
    const res = await call(t.app, { url: "/api/v1/directory/communities?q=directory", cookie: resident.cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([{ id: live, name: "Directory Lake", city: "Pune", locality: "Baner", communityType: "gated_community" }]);
    expect(res.body).not.toContain("12 Lake Road");
    expect(res.body).not.toContain("ramesh@example.test");

    expect((await call(t.app, { url: "/api/v1/directory/communities?q=pune", cookie: resident.cookie })).json().data).toHaveLength(1); // city search
    expect((await call(t.app, { url: "/api/v1/directory/communities?q=%25", cookie: resident.cookie })).json().data).toHaveLength(0); // literal %
    expect((await call(t.app, { url: "/api/v1/directory/communities" })).statusCode).toBe(401);
    expect((await call(t.app, { url: "/api/v1/directory/communities?limit=500", cookie: resident.cookie })).statusCode).toBe(400);
  });

  it("drops a suspended community from the directory immediately", async () => {
    const id = await newCommunity({ name: "Directory Suspended" });
    await activate(id);
    const resident = await register(t.app, email("finder2"));
    expect((await call(t.app, { url: "/api/v1/directory/communities?q=Directory Suspended", cookie: resident.cookie })).json().data).toHaveLength(1);
    await post(asBoss, `/api/v1/communities/${id}/transitions`, { to: "suspended", note: "Pending review." });
    expect((await call(t.app, { url: "/api/v1/directory/communities?q=Directory Suspended", cookie: resident.cookie })).json().data).toHaveLength(0);
  });
});
