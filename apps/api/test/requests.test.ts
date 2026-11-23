import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, makeMember, makeStaff, PLATFORM_SCOPE, register, type TestApp } from "./helpers";

let t: TestApp;
let ops: { cookie: string; userId: string }; // business_operations: works the queue
let ops2: { cookie: string; userId: string };
let boss: { cookie: string; userId: string }; // platform_admin: can read vendors and approve communities, NOT work requests
let seq = 0;
const email = (p: string) => `${p}-${++seq}@example.test`;
const api = "/api/v1";

const asOps = (url: string, extra: Partial<Parameters<typeof call>[1]> = {}) => call(t.app, { url, cookie: ops.cookie, headers: PLATFORM_SCOPE, ...extra });
const asBoss = (url: string, extra: Partial<Parameters<typeof call>[1]> = {}) => call(t.app, { url, cookie: boss.cookie, headers: PLATFORM_SCOPE, ...extra });
const as = (who: { cookie: string }, tenantId: string, url: string, extra: Partial<Parameters<typeof call>[1]> = {}) =>
  call(t.app, { url, cookie: who.cookie, headers: { "x-tenant-id": tenantId }, ...extra });

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

async function activeCommunity(name: string) {
  const created = await asOps(`${api}/communities`, { method: "POST", body: { name, ...COMMUNITY } });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().id as string;
  await asOps(`${api}/communities/${id}/transitions`, { method: "POST", body: { to: "verification" } });
  const adminEmail = email("assign");
  await register(t.app, adminEmail);
  await asOps(`${api}/communities/${id}/admins`, { method: "POST", body: { email: adminEmail } });
  const done = await asBoss(`${api}/communities/${id}/transitions`, { method: "POST", body: { to: "active", note: "Verified." } });
  expect(done.statusCode, done.body).toBe(200);
  const admin = await makeMember(t, email("cadmin"), id, ["community_admin"]);
  const resident = await makeMember(t, email("res"), id, ["resident"]);
  const neighbour = await makeMember(t, email("nei"), id, ["resident"]);
  return { id, admin, resident, neighbour };
}

let typeId = "";
let celebrationId = "";
let categoryId = "";
const ACTIVITY = (over: Record<string, unknown> = {}) => ({
  requestTypeId: typeId,
  title: "Magic show for Aarav's birthday",
  description: "A one-hour show for about 15 children.",
  participantCount: 15,
  ageMin: 5,
  ageMax: 8,
  budgetMaxMinor: 800_000,
  answers: { format: "one_time", setting: "indoor" },
  ...over,
});

const create = (who: { cookie: string }, community: string, body: unknown) => as(who, community, `${api}/requests`, { method: "POST", body });
const go = (who: (url: string, extra?: Partial<Parameters<typeof call>[1]>) => ReturnType<typeof call>, id: string, to: string, note?: string) =>
  who(`${api}/requests/${id}/transitions`, { method: "POST", body: { to, ...(note ? { note } : {}) } });

beforeAll(async () => {
  t = await createTestApp();
  ops = await makeStaff(t, "ops@example.test", "business_operations");
  ops2 = await makeStaff(t, "ops2@example.test", "business_operations");
  boss = await makeStaff(t, "boss@example.test", "platform_admin");
  const cats = (await asBoss(`${api}/categories`)).json().data as { id: string; parentId: string | null }[];
  categoryId = cats.find((c) => c.parentId)?.id as string;
});
afterAll(async () => {
  await t.close();
});

describe("making a request", () => {
  it("offers the request types with their forms, and creates a request that starts submitted with the answers labelled", async () => {
    const c = await activeCommunity("Request Heights");
    const types = (await as(c.resident, c.id, `${api}/request-types`)).json().data as { id: string; key: string; fields: unknown[] }[];
    expect(types.map((x) => x.key)).toEqual(["activity", "celebration", "workshop"]);
    typeId = types.find((x) => x.key === "activity")?.id as string;
    celebrationId = types.find((x) => x.key === "celebration")?.id as string;

    const res = await create(c.resident, c.id, ACTIVITY({ categoryId, preferredDate: "2099-01-15", flexibleDates: true, venueText: "Clubhouse" }));
    expect(res.statusCode, res.body).toBe(201);
    const r = res.json();
    expect(r).toMatchObject({ status: "submitted", statusLabel: "Submitted", waitingOn: "operations", mine: true, participantCount: 15, preferredDate: "2099-01-15", flexibleDates: true });
    expect(r.number).toBeGreaterThan(0);
    expect(r.answers).toEqual([
      { key: "format", label: "One time or regular?", value: "One time" },
      { key: "setting", label: "Indoor or outdoor?", value: "Indoor" },
    ]);
    expect(r.history).toHaveLength(1);
    expect(r.history[0]).toMatchObject({ to: "Submitted", byRequester: true });
    // a family sees neither the operations clock nor who owns it
    expect(r.slaDueAt).toBeUndefined();
    expect(r.assignedTo).toBeUndefined();
    expect(r.requester).toBeUndefined();
    expect(r.transitions.map((x: { to: string }) => x.to)).toEqual(["cancelled"]);
    const audit = await t.db.admin.query("SELECT action FROM audit_log WHERE entity_id = $1", [r.id]);
    expect(audit.rows.map((x) => x.action)).toEqual(["request.created"]);
  });

  it("validates every field on the server: the form, the shared fields, the catalog link and the date", async () => {
    const c = await activeCommunity("Validation Villas");
    const bad = async (body: unknown, field: string) => {
      const res = await create(c.resident, c.id, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(JSON.stringify(res.json().error.details), field).toContain(field);
    };
    await bad(ACTIVITY({ title: "hi" }), "title");
    await bad(ACTIVITY({ answers: { format: "weekly" } }), "answers.format"); // not an option
    await bad(ACTIVITY({ answers: {} }), "answers.format"); // required
    await bad(ACTIVITY({ answers: { format: "one_time", surprise: "x" } }), "answers.surprise"); // unknown keys are refused, not kept
    await bad(ACTIVITY({ answers: { format: "one_time", special_needs: "x".repeat(501) } }), "answers.special_needs");
    await bad(ACTIVITY({ ageMin: 9, ageMax: 5 }), "ageMax");
    await bad(ACTIVITY({ participantCount: 0 }), "participantCount");
    await bad(ACTIVITY({ preferredDate: "2001-01-01" }), "preferredDate");
    await bad(ACTIVITY({ preferredDate: "next friday" }), "preferredDate");
    await bad(ACTIVITY({ categoryId: randomUUID() }), "categoryId");
    await bad(ACTIVITY({ offeringId: randomUUID() }), "offeringId");
    await bad(ACTIVITY({ requestTypeId: randomUUID() }), "requestTypeId");
    await bad(ACTIVITY({ status: "approved" }), "status"); // cannot choose a status
    await bad(ACTIVITY({ requesterId: randomUUID() }), "requesterId"); // cannot make a request for someone else
    await bad(ACTIVITY({ tenantId: randomUUID() }), "tenantId");
    // the celebration form has its own required fields and numeric bounds
    await bad({ requestTypeId: celebrationId, title: "Party", answers: { occasion: "birthday", guest_count: 0, venue_type: "home" } }, "answers.guest_count");
    await bad({ requestTypeId: celebrationId, title: "Party", answers: { occasion: "birthday", guest_count: 12.5, venue_type: "home" } }, "answers.guest_count");
    const ok = await create(c.resident, c.id, { requestTypeId: celebrationId, title: "Garden party", answers: { occasion: "festival", guest_count: 40, venue_type: "community_facility", food_allowed: true, theme: "Diwali" } });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().answers.map((a: { value: string }) => a.value)).toEqual(["Festival", "40", "A community venue", "Yes", "Diwali"]);
  });

  it("is for members of a community acting in it: not for platform staff, not for strangers, not without an organization", async () => {
    const c = await activeCommunity("Members Only Mews");
    const other = await activeCommunity("Elsewhere Estate");
    expect((await asOps(`${api}/requests`, { method: "POST", body: ACTIVITY() })).statusCode).toBe(403);
    // a resident of another community cannot file one here (their context is rejected), nor see this community's types as a member
    expect((await create(other.resident, c.id, ACTIVITY())).statusCode).toBe(403);
    expect((await call(t.app, { method: "POST", url: `${api}/requests`, cookie: c.resident.cookie, body: ACTIVITY() })).statusCode).toBeLessThan(500);
    // community administrators are not residents: they have no permission to file
    expect((await create(c.admin, c.id, ACTIVITY())).statusCode).toBe(403);
    expect((await call(t.app, { method: "POST", url: `${api}/requests`, body: ACTIVITY() })).statusCode).toBe(401);
  });

  it("caps open requests per person, and a finished one frees a place", async () => {
    const c = await activeCommunity("Cap Court");
    for (let i = 0; i < 20; i++) {
      await t.db.admin.query(
        "INSERT INTO requests (tenant_id, requester_id, request_type_id, schema_version, title) VALUES ($1, $2, $3, 1, $4)",
        [c.id, c.resident.userId, typeId, `Filler ${i}`],
      );
    }
    const res = await create(c.resident, c.id, ACTIVITY());
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("limit_reached");
    const first = (await t.db.admin.query("SELECT id FROM requests WHERE tenant_id = $1 ORDER BY created_at LIMIT 1", [c.id])).rows[0].id as string;
    expect((await go((u, e) => as(c.resident, c.id, u, e), first, "cancelled")).statusCode).toBe(200);
    expect((await create(c.resident, c.id, ACTIVITY())).statusCode).toBe(201);
  });

  it("links a request to a catalog offering only if the family could see it", async () => {
    const c = await activeCommunity("Catalog Court");
    const vendor = async (name: string, approved: boolean) => {
      const v = randomUUID();
      const off = randomUUID();
      const q = (sql: string, p: unknown[]) => t.db.admin.query(sql, p);
      await q("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'vendor', $2, 'active')", [v, name]);
      await q("INSERT INTO vendor_profiles (tenant_id, description) VALUES ($1, 'x')", [v]);
      await q("INSERT INTO vendor_service_areas (tenant_id, community_id) VALUES ($1, $2)", [v, c.id]);
      await q("INSERT INTO vendor_vetting_summary (tenant_id, complete) VALUES ($1, true)", [v]);
      if (approved) await q("INSERT INTO community_vendor_approvals (tenant_id, vendor_id, status) VALUES ($1, $2, 'approved')", [c.id, v]);
      await q("INSERT INTO offerings (id, tenant_id, category_id, name, pricing_model, price_minor, status) VALUES ($1, $2, $3, 'Cricket camp', 'fixed', 100, 'published')", [off, v, categoryId]);
      return off;
    };
    const visible = await vendor("Approved Coaching", true);
    const hidden = await vendor("Unapproved Coaching", false);
    const ok = await create(c.resident, c.id, ACTIVITY({ offeringId: visible }));
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().offering).toEqual({ id: visible, name: "Cricket camp", vendor: "Approved Coaching" });
    const refused = await create(c.resident, c.id, ACTIVITY({ offeringId: hidden }));
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.json().error.details)).toContain("offeringId");
  });
});

describe("who can see which requests", () => {
  it("keeps each family's requests to themselves, shows a community's to its administrators, and everything to operations", async () => {
    const c = await activeCommunity("Privacy Park");
    const other = await activeCommunity("Neighbouring Nook");
    const mine = (await create(c.resident, c.id, ACTIVITY({ title: "Resident one's request" }))).json();
    await create(c.neighbour, c.id, ACTIVITY({ title: "Neighbour's request" }));
    await create(other.resident, other.id, ACTIVITY({ title: "Other community's request" }));

    const titles = async (res: Awaited<ReturnType<typeof call>>) => (res.json().data as { title: string }[]).map((r) => r.title).sort();
    expect(await titles(await as(c.resident, c.id, `${api}/requests`))).toEqual(["Resident one's request"]);
    expect(await titles(await as(c.neighbour, c.id, `${api}/requests`))).toEqual(["Neighbour's request"]);
    expect(await titles(await as(c.admin, c.id, `${api}/requests`))).toEqual(["Neighbour's request", "Resident one's request"]); // the community's, not the other's
    expect(await titles(await as(other.admin, other.id, `${api}/requests`))).toEqual(["Other community's request"]);
    const all = await titles(await asOps(`${api}/requests?q=request`));
    expect(all).toEqual(expect.arrayContaining(["Resident one's request", "Neighbour's request", "Other community's request"]));

    // by id: a neighbour and another community's administrator get the same 404 as a request that does not exist
    expect((await as(c.neighbour, c.id, `${api}/requests/${mine.id}`)).statusCode).toBe(404);
    expect((await as(other.admin, other.id, `${api}/requests/${mine.id}`)).statusCode).toBe(404);
    expect((await as(c.resident, c.id, `${api}/requests/${randomUUID()}`)).statusCode).toBe(404);
    // the community's administrator may read it, with who asked, but not the operations clock or owner
    const adminView = (await as(c.admin, c.id, `${api}/requests/${mine.id}`)).json();
    expect(adminView.requester).toBeDefined();
    expect(adminView.slaDueAt).toBeUndefined();
    expect(adminView.transitions).toEqual([]);
    expect(adminView.can).toEqual({ comment: false, commentInternal: false, assign: false });
    // operations see the clock and ownership
    const opsView = (await asOps(`${api}/requests/${mine.id}`)).json();
    expect(opsView).toMatchObject({ slaState: "on_track", assignedTo: null });
    expect(opsView.requester.name).toBeTruthy();
    // the "mine" filter narrows an administrator who is also a requester
    expect((await as(c.admin, c.id, `${api}/requests?mine=true`)).json().data).toEqual([]);
    // platform staff outside platform scope, platform admins who cannot work requests, and filters
    expect((await call(t.app, { url: `${api}/requests`, cookie: ops.cookie })).statusCode).toBe(400);
    expect((await asBoss(`${api}/requests`)).statusCode).toBe(403);
    expect((await asOps(`${api}/requests?communityId=${other.id}`)).json().data).toHaveLength(1);
    expect((await asOps(`${api}/requests?limit=0`)).statusCode).toBe(400);
    expect((await asOps(`${api}/requests?cursor=garbage`)).json().error.code).toBe("invalid_cursor");
    // keyset pagination
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page = await asOps(`${api}/requests?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      for (const r of page.json().data) seen.push(r.id);
      cursor = page.json().page.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain(mine.id);
  });
});

describe("the operations journey", () => {
  it("runs from submitted through a question to the family, their reply, and approval, with a visible history", async () => {
    const c = await activeCommunity("Journey Jetty");
    const r = (await create(c.resident, c.id, ACTIVITY())).json();
    const id = r.id as string;
    const resident = (u: string, e?: Partial<Parameters<typeof call>[1]>) => as(c.resident, c.id, u, e);

    // the family cannot move their own request forward; staff without the permission cannot either
    expect((await go(resident, id, "under_review")).statusCode).toBe(403);
    expect((await go(resident, id, "approved")).statusCode).toBe(409); // not a step from here at all
    expect((await go(asBoss, id, "under_review")).statusCode).toBe(403); // platform_admin lacks requests.read_all
    expect((await go(asOps, id, "approved")).statusCode).toBe(409);
    expect((await go(asOps, id, "nonsense")).statusCode).toBe(409);
    expect((await go(asOps, randomUUID(), "under_review")).statusCode).toBe(404);

    const review = await go(asOps, id, "under_review");
    expect(review.statusCode, review.body).toBe(200);
    expect(review.json().statusLabel).toBe("Under review");
    expect(review.json().transitions.map((x: { to: string }) => x.to)).toEqual(["information_required", "approved", "rejected", "cancelled"].filter((x) => x !== "cancelled"));

    // asking for information needs a note, and the note is what the family reads
    const noNote = await go(asOps, id, "information_required");
    expect(noNote.statusCode).toBe(400);
    expect(noNote.json().error.code).toBe("note_required");
    expect((await asOps(`${api}/requests/${id}/transitions`, { method: "POST", body: { to: "information_required", note: "   " } })).json().error.code).toBe("note_required");
    const asked = await go(asOps, id, "information_required", "Which weekend works, and how many children under five?");
    expect(asked.json()).toMatchObject({ status: "information_required", waitingOn: "resident" });

    const familyView = (await resident(`${api}/requests/${id}`)).json();
    expect(familyView.history.map((h: { to: string }) => h.to)).toEqual(["Submitted", "Under review", "We need more information"]);
    expect(familyView.history[2]).toMatchObject({ note: "Which weekend works, and how many children under five?", byRequester: false });
    expect(familyView.history[2].by).toBeUndefined(); // the family sees "the team", not a staff member's name
    expect(familyView.can.comment).toBe(true);
    expect(familyView.transitions.map((x: { to: string }) => x.to).sort()).toEqual(["cancelled", "under_review"]);

    // the family answers; the reply sends the request back to the team in the same step
    const reply = await resident(`${api}/requests/${id}/comments`, { method: "POST", body: { body: "The 14th or 15th. Two under five.", returnToReview: true } });
    expect(reply.statusCode, reply.body).toBe(201);
    expect(reply.json().status).toBe("under_review");
    expect(reply.json().comments).toHaveLength(1);
    expect(reply.json().comments[0]).toMatchObject({ visibility: "resident", byRequester: true });
    // returnToReview outside "information required" does nothing to the status
    const chat = await resident(`${api}/requests/${id}/comments`, { method: "POST", body: { body: "Thanks!", returnToReview: true } });
    expect(chat.json().status).toBe("under_review");

    const approved = await go(asOps, id, "approved", "Looks good; we will start finding vendors.");
    expect(approved.json()).toMatchObject({ status: "approved", slaDueAt: null, slaState: null });
    // finishing: operations close it without a booking; nothing can reopen or message a finished request
    expect((await go(asOps, id, "closed")).json().error.code).toBe("note_required");
    expect((await go(asOps, id, "closed", "Family found a vendor themselves.")).json().status).toBe("closed");
    expect((await go(asOps, id, "under_review")).statusCode).toBe(409);
    expect((await go(resident, id, "cancelled")).statusCode).toBe(409);
    const late = await resident(`${api}/requests/${id}/comments`, { method: "POST", body: { body: "One more thing" } });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe("request_closed");
    expect((await asOps(`${api}/requests/${id}/comments`, { method: "POST", body: { body: "Staff too" } })).statusCode).toBe(409);

    const full = (await asOps(`${api}/requests/${id}`)).json();
    expect(full.history.map((h: { to: string }) => h.to)).toEqual(["Submitted", "Under review", "We need more information", "Under review", "Approved", "Closed"]);
    expect(full.history[2].by).toBeTruthy(); // operations see who did what
    const audit = await t.db.admin.query("SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'request.status_changed'", [id]);
    expect(audit.rows[0].n).toBe(5);
  });

  it("lets the family cancel while the request is open, and nobody can work a cancelled request", async () => {
    const c = await activeCommunity("Cancel Cove");
    const resident = (u: string, e?: Partial<Parameters<typeof call>[1]>) => as(c.resident, c.id, u, e);
    const neighbour = (u: string, e?: Partial<Parameters<typeof call>[1]>) => as(c.neighbour, c.id, u, e);
    const one = (await create(c.resident, c.id, ACTIVITY())).json().id as string;
    expect((await go(neighbour, one, "cancelled")).statusCode).toBe(404); // not theirs
    expect((await go((u, e) => as(c.admin, c.id, u, e), one, "cancelled")).statusCode).toBe(403); // administrators read only
    expect((await go(resident, one, "cancelled")).json()).toMatchObject({ status: "cancelled", terminal: true });
    expect((await go(asOps, one, "under_review")).statusCode).toBe(409); // a cancelled request is finished for operations too
  });

  it("allows rejection straight from submitted, and a rejected request cannot be cancelled away", async () => {
    const c = await activeCommunity("Reject Ridge");
    const resident = (u: string, e?: Partial<Parameters<typeof call>[1]>) => as(c.resident, c.id, u, e);
    const id = (await create(c.resident, c.id, ACTIVITY({ title: "Skydiving party" }))).json().id as string;
    expect((await go(asOps, id, "rejected")).json().error.code).toBe("note_required");
    const rejected = await go(asOps, id, "rejected", "We cannot arrange anything involving aircraft.");
    expect(rejected.statusCode, rejected.body).toBe(200);
    const view = (await resident(`${api}/requests/${id}`)).json();
    expect(view).toMatchObject({ status: "rejected", statusLabel: "Not possible" });
    expect(view.history.at(-1).note).toBe("We cannot arrange anything involving aircraft.");
    expect((await go(resident, id, "cancelled")).statusCode).toBe(409);
  });
});

describe("messages and internal notes", () => {
  it("keeps internal notes from the family and the community, and lets only the right people write each kind", async () => {
    const c = await activeCommunity("Notes Nook");
    const id = (await create(c.resident, c.id, ACTIVITY())).json().id as string;
    const post = (who: Parameters<typeof as>[0] | "ops", body: unknown) =>
      who === "ops" ? asOps(`${api}/requests/${id}/comments`, { method: "POST", body }) : as(who, c.id, `${api}/requests/${id}/comments`, { method: "POST", body });

    expect((await post(c.resident, { body: "We prefer mornings." })).statusCode).toBe(201);
    expect((await post("ops", { body: "Thanks, noted." })).statusCode).toBe(201);
    expect((await post("ops", { body: "Parent was curt on the phone; keep replies brief.", visibility: "internal" })).statusCode).toBe(201);

    expect((await post(c.resident, { body: "sneaky", visibility: "internal" })).statusCode).toBe(403);
    expect((await post(c.neighbour, { body: "on a neighbour's request" })).statusCode).toBe(404);
    expect((await post(c.admin, { body: "administrators read" })).statusCode).toBe(403);
    expect((await post(c.resident, { body: "" })).statusCode).toBe(400);
    expect((await post(c.resident, { body: "x".repeat(2001) })).statusCode).toBe(400);
    expect((await post(c.resident, { body: "hi", extra: 1 })).statusCode).toBe(400);
    expect((await asBoss(`${api}/requests/${id}/comments`, { method: "POST", body: { body: "no" } })).statusCode).toBe(403);

    const bodies = (res: Awaited<ReturnType<typeof call>>) => (res.json().comments as { body: string }[]).map((m) => m.body);
    expect(bodies(await as(c.resident, c.id, `${api}/requests/${id}`))).toEqual(["We prefer mornings.", "Thanks, noted."]);
    expect(bodies(await as(c.admin, c.id, `${api}/requests/${id}`))).toEqual(["We prefer mornings.", "Thanks, noted."]);
    expect(bodies(await asOps(`${api}/requests/${id}`))).toHaveLength(3);
    // not even a leftover substring in the family's payload
    expect((await as(c.resident, c.id, `${api}/requests/${id}`)).body).not.toContain("curt");
    expect((await as(c.admin, c.id, `${api}/requests/${id}`)).body).not.toContain("curt");
  });
});

describe("ownership and the queue", () => {
  it("assigns only to the operations team, shows ownership to the team alone, and summarises the queue", async () => {
    const c = await activeCommunity("Queue Quay");
    const a = (await create(c.resident, c.id, ACTIVITY({ title: "Queue one" }))).json().id as string;
    const b = (await create(c.neighbour, c.id, ACTIVITY({ title: "Queue two" }))).json().id as string;
    const assign = (id: string, userId: string | null, who: typeof asOps = asOps) => who(`${api}/requests/${id}/assignee`, { method: "PUT", body: { userId } });

    expect((await assign(a, ops.userId)).json().assignedTo).toMatchObject({ id: ops.userId });
    expect((await assign(a, ops2.userId)).json().assignedTo.id).toBe(ops2.userId); // reassign to a colleague
    expect((await assign(a, c.resident.userId)).json().error.code).toBe("invalid_assignee"); // a resident is not on the team
    expect((await assign(a, randomUUID())).json().error.code).toBe("invalid_assignee");
    expect((await assign(a, ops.userId, ((u, e) => as(c.resident, c.id, u, e)) as typeof asOps)).statusCode).toBe(403);
    expect((await assign(a, ops.userId, asBoss)).statusCode).toBe(403);
    expect((await assign(randomUUID(), ops.userId)).statusCode).toBe(404);
    expect((await asOps(`${api}/requests/${a}/assignee`, { method: "PUT", body: {} })).statusCode).toBe(400);
    expect((await as(c.resident, c.id, `${api}/requests/${a}`)).body).not.toContain(ops2.userId); // the family never sees the owner

    await assign(a, ops.userId);
    const mineIds = ((await asOps(`${api}/requests?assigned=me`)).json().data as { id: string }[]).map((r) => r.id);
    expect(mineIds).toContain(a);
    expect(mineIds).not.toContain(b);
    const unassigned = ((await asOps(`${api}/requests?assigned=unassigned`)).json().data as { id: string }[]).map((r) => r.id);
    expect(unassigned).toContain(b);
    expect(unassigned).not.toContain(a);

    const summary = (await asOps(`${api}/requests/summary`)).json();
    expect(summary.open).toBeGreaterThanOrEqual(2);
    expect(summary.mine).toBeGreaterThanOrEqual(1);
    expect(summary.unassigned).toBeGreaterThanOrEqual(1);
    expect(summary.byStatus.find((s: { status: string }) => s.status === "submitted").count).toBeGreaterThanOrEqual(2);
    expect((await as(c.resident, c.id, `${api}/requests/summary`)).statusCode).toBe(403);
    expect((await as(c.admin, c.id, `${api}/requests/summary`)).statusCode).toBe(403);
    expect((await asBoss(`${api}/requests/summary`)).statusCode).toBe(403);
  });

  it("flags requests that are late for the operations clock only, and the family's wait is not a breach", async () => {
    const c = await activeCommunity("Clock Court");
    const late = (await create(c.resident, c.id, ACTIVITY({ title: "Late one" }))).json().id as string;
    const waiting = (await create(c.neighbour, c.id, ACTIVITY({ title: "Waiting on family" }))).json().id as string;
    await go(asOps, waiting, "under_review");
    await go(asOps, waiting, "information_required", "Please confirm the date.");
    // time passes (the clock fields are only ever set by the workflow, so the test pauses the trigger to move them)
    const admin = t.db.admin;
    await admin.query("ALTER TABLE requests DISABLE TRIGGER requests_a_enforce_workflow");
    try {
      await admin.query("UPDATE requests SET sla_due_at = now() - interval '2 hours' WHERE id = ANY($1)", [[late, waiting]]);
    } finally {
      await admin.query("ALTER TABLE requests ENABLE TRIGGER requests_a_enforce_workflow");
    }
    const view = async (id: string) => (await asOps(`${api}/requests/${id}`)).json();
    expect((await view(late)).slaState).toBe("overdue");
    expect((await view(waiting)).slaState).toBeNull(); // waiting on the family: not the team's breach

    const overdue = ((await asOps(`${api}/requests?sla=overdue`)).json().data as { id: string }[]).map((r) => r.id);
    expect(overdue).toContain(late);
    expect(overdue).not.toContain(waiting);
    expect((await asOps(`${api}/requests/summary`)).json().overdue).toBeGreaterThanOrEqual(1);

    await admin.query("ALTER TABLE requests DISABLE TRIGGER requests_a_enforce_workflow");
    try {
      await admin.query("UPDATE requests SET sla_due_at = now() + interval '2 hours' WHERE id = $1", [late]);
    } finally {
      await admin.query("ALTER TABLE requests ENABLE TRIGGER requests_a_enforce_workflow");
    }
    expect((await view(late)).slaState).toBe("due_soon");
    expect(((await asOps(`${api}/requests?sla=due_soon`)).json().data as { id: string }[]).map((r) => r.id)).toContain(late);
    // moving to the next step restarts the clock (48 hours for review)
    const moved = await go(asOps, late, "under_review");
    expect(moved.json().slaState).toBe("on_track");
    // the resident's own screens never carry any of this
    expect((await as(c.resident, c.id, `${api}/requests/${late}`)).body).not.toContain("slaState");
  });

  it("searches by title or number and filters by status", async () => {
    const c = await activeCommunity("Search Square");
    const r = (await create(c.resident, c.id, ACTIVITY({ title: "Unmistakable pottery morning" }))).json();
    expect(((await asOps(`${api}/requests?q=pottery`)).json().data as { id: string }[]).map((x) => x.id)).toContain(r.id);
    expect(((await asOps(`${api}/requests?q=%25`)).json().data as unknown[]).length).toBe(0); // wildcards are escaped
    expect(((await asOps(`${api}/requests?q=${r.number}`)).json().data as { id: string }[]).map((x) => x.id)).toContain(r.id);
    expect(((await asOps(`${api}/requests?q=%23${r.number}`)).json().data as { id: string }[]).map((x) => x.id)).toContain(r.id);
    expect(((await asOps(`${api}/requests?status=approved&q=pottery`)).json().data as unknown[]).length).toBe(0);
    expect(((await asOps(`${api}/requests?open=false&q=pottery`)).json().data as unknown[]).length).toBe(0);
    expect(((await asOps(`${api}/requests?open=true&q=pottery`)).json().data as unknown[]).length).toBe(1);
    expect((await asOps(`${api}/requests?status=Bad Value`)).statusCode).toBe(400);
  });
});
