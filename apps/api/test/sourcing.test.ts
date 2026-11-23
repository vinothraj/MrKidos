import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, makeMember, makeStaff, PLATFORM_SCOPE, register, type TestApp } from "./helpers";

let t: TestApp;
let ops: { cookie: string; userId: string };
let boss: { cookie: string; userId: string }; // platform_admin: no matching.override, no inquiries.send
let seq = 0;
const email = (p: string) => `${p}-${++seq}@example.test`;
const api = "/api/v1";

type Who = { cookie: string; userId?: string };
type Caller = (url: string, extra?: Partial<Parameters<typeof call>[1]>) => ReturnType<typeof call>;
const asOps: Caller = (url, extra = {}) => call(t.app, { url, cookie: ops.cookie, headers: PLATFORM_SCOPE, ...extra });
const asBoss: Caller = (url, extra = {}) => call(t.app, { url, cookie: boss.cookie, headers: PLATFORM_SCOPE, ...extra });
const as = (who: Who, tenantId: string): Caller => (url, extra = {}) => call(t.app, { url, cookie: who.cookie, headers: { "x-tenant-id": tenantId }, ...extra });
const post = (who: Caller, url: string, body: unknown = {}) => who(url, { method: "POST", body });
const put = (who: Caller, url: string, body: unknown) => who(url, { method: "PUT", body });

const COMMUNITY = {
  communityType: "gated_community", country: "India", state: "Karnataka", city: "Bengaluru", locality: "Whitefield", address: "12 Lake Road",
  contactName: "Ramesh Kumar", contactEmail: "ramesh@example.test", contactPhone: "+91 98765 43210", latitude: 12.97, longitude: 77.75, unitCount: 420, population: 1500,
};

let categories: { id: string; key: string; parentId: string | null }[] = [];
const catId = (key: string) => categories.find((c) => c.key === key)?.id as string;

async function activeCommunity(name: string) {
  const created = await asOps(`${api}/communities`, { method: "POST", body: { name, ...COMMUNITY } });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().id as string;
  await post(asOps, `${api}/communities/${id}/transitions`, { to: "verification" });
  const adminEmail = email("assign");
  await register(t.app, adminEmail);
  await post(asOps, `${api}/communities/${id}/admins`, { email: adminEmail });
  expect((await post(asBoss, `${api}/communities/${id}/transitions`, { to: "active", note: "Verified." })).statusCode).toBe(200);
  const admin = await makeMember(t, email("cadmin"), id, ["community_admin"]);
  const resident = await makeMember(t, email("res"), id, ["resident"]);
  const neighbour = await makeMember(t, email("nei"), id, ["resident"]);
  return { id, admin, resident, neighbour };
}

interface VendorOpts {
  approved?: boolean;
  serves?: boolean;
  status?: string;
  vetted?: boolean;
  category?: string;
  pricing?: string;
  priceMinor?: number | null;
  ageMin?: number | null;
  ageMax?: number | null;
  minParticipants?: number | null;
  maxParticipants?: number | null;
  years?: number | null;
}
async function vendor(name: string, communityId: string, o: VendorOpts = {}) {
  const id = randomUUID();
  const q = (sql: string, p: unknown[]) => t.db.admin.query(sql, p);
  await q("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'vendor', $2, $3)", [id, name, o.status ?? "active"]);
  await q("INSERT INTO vendor_profiles (tenant_id, description, city, years_experience) VALUES ($1, 'Coaching', 'Bengaluru', $2)", [id, o.years ?? null]);
  await q("INSERT INTO vendor_private (tenant_id, contact_email, legal_name) VALUES ($1, 'private@vendor.test', 'Private Legal LLP')", [id]);
  if (o.serves !== false) await q("INSERT INTO vendor_service_areas (tenant_id, community_id) VALUES ($1, $2)", [id, communityId]);
  await q("INSERT INTO vendor_vetting_summary (tenant_id, complete) VALUES ($1, $2)", [id, o.vetted !== false]);
  if (o.approved !== false) await q("INSERT INTO community_vendor_approvals (tenant_id, vendor_id, status) VALUES ($1, $2, 'approved')", [communityId, id]);
  const category = o.category ?? "cricket";
  await q("INSERT INTO vendor_categories (tenant_id, category_id) VALUES ($1, $2)", [id, catId(category)]);
  const offeringId = (await q(
    `INSERT INTO offerings (tenant_id, category_id, name, description, pricing_model, price_minor, duration_minutes, cancellation_policy, status, age_min, age_max, min_participants, max_participants)
     VALUES ($1, $2, $3, 'Fun', $4, $5, 60, 'Free up to 48h', 'published', $6, $7, $8, $9) RETURNING id`,
    [id, catId(category), `${name} programme`, o.pricing ?? "fixed", o.priceMinor === undefined ? 500_000 : o.priceMinor, o.ageMin ?? null, o.ageMax ?? null, o.minParticipants ?? null, o.maxParticipants ?? null],
  )).rows[0].id as string;
  const owner = await makeMember(t, email("vown"), id, ["vendor_owner"], { mfa: true });
  return { id, name, offeringId, owner, as: as(owner, id) };
}

let activityType = "";
const FORM = { format: "one_time" };
async function makeRequest(c: Awaited<ReturnType<typeof activeCommunity>>, over: Record<string, unknown> = {}, who: Who = c.resident): Promise<string> {
  const res = await post(as(who, c.id), `${api}/requests`, {
    requestTypeId: activityType, title: "Cricket coaching for the weekend", categoryId: catId("cricket"), participantCount: 12, ageMin: 8, ageMax: 12, budgetMaxMinor: 800_000,
    answers: FORM, ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
const go = (who: Caller, id: string, to: string, note?: string) => post(who, `${api}/requests/${id}/transitions`, { to, ...(note ? { note } : {}) });
const detail = async (who: Caller, id: string) => (await who(`${api}/requests/${id}`)).json();

/** Takes a fresh request to the stage of finding vendors. */
async function sourcingRequest(c: Awaited<ReturnType<typeof activeCommunity>>, over: Record<string, unknown> = {}) {
  const id = await makeRequest(c, over);
  for (const to of ["under_review", "approved", "sourcing"]) expect((await go(asOps, id, to)).statusCode, to).toBe(200);
  return id;
}
const sourcing = async (id: string) => (await asOps(`${api}/requests/${id}/sourcing`)).json();

beforeAll(async () => {
  t = await createTestApp();
  ops = await makeStaff(t, "ops@example.test", "business_operations");
  boss = await makeStaff(t, "boss@example.test", "platform_admin");
  categories = (await asBoss(`${api}/categories`)).json().data;
  const c = await activeCommunity("Bootstrap Heights");
  activityType = ((await as(c.resident, c.id)(`${api}/request-types`)).json().data as { id: string; key: string }[]).find((x) => x.key === "activity")?.id as string;
});
afterAll(async () => {
  await t.close();
});

describe("matching", () => {
  it("suggests only vendors a family could actually be offered, with a reason for every score, and agrees with the catalog", async () => {
    const c = await activeCommunity("Matching Meadows");
    const exact = await vendor("Exact Cricket", c.id, { years: 8, ageMin: 6, ageMax: 14 });
    const sibling = await vendor("Sibling Football", c.id, { category: "football_basketball" });
    const other = await vendor("Elsewhere Chess", c.id, { category: "chess_abacus" });
    const unapproved = await vendor("Unapproved Cricket", c.id, { approved: false });
    const suspended = await vendor("Suspended Cricket", c.id, { status: "suspended" });
    const lapsed = await vendor("Lapsed Cricket", c.id, { vetted: false });
    const away = await vendor("Away Cricket", c.id, { serves: false });
    const id = await sourcingRequest(c);

    const run = await post(asOps, `${api}/requests/${id}/matching/run`);
    expect(run.statusCode, run.body).toBe(200);
    const view = await sourcing(id);
    const names = view.matches.map((m: { vendorName: string }) => m.vendorName);
    expect(names).toEqual(expect.arrayContaining(["Exact Cricket", "Sibling Football", "Elsewhere Chess"]));
    for (const excluded of [unapproved, suspended, lapsed, away]) expect(names, excluded.name).not.toContain(excluded.name);
    expect(names[0]).toBe("Exact Cricket"); // the exact category outranks a sibling category, which outranks an unrelated one
    expect(names.indexOf("Sibling Football")).toBeLessThan(names.indexOf("Elsewhere Chess"));
    const top = view.matches[0];
    expect(top.reasons.map((r: { text: string }) => r.text)).toEqual(expect.arrayContaining(["Offers exactly this category", "Within the budget", "Suitable for the children's ages"]));
    expect(top.reasons.reduce((s: number, r: { points: number }) => s + r.points, 0)).toBeGreaterThanOrEqual(top.score); // every point is explained (scores are clamped to 100)
    expect(top.score).toBeLessThanOrEqual(100);

    // PARITY: a vendor is matchable exactly when the community's families can see it in the catalog
    for (const v of [exact, sibling, other, unapproved, suspended, lapsed, away]) {
      const visible = (await as(c.resident, c.id)(`${api}/catalog/vendors/${v.id}`)).statusCode === 200;
      expect(names.includes(v.name), `${v.name}: matched vs visible (${visible})`).toBe(visible);
    }
  });

  it("scores budget, age, group size and availability, and explains each", async () => {
    const c = await activeCommunity("Scoring Square");
    const pricey = await vendor("Pricey", c.id, { priceMinor: 5_000_000 }); // far over budget
    const young = await vendor("Young Only", c.id, { ageMin: 2, ageMax: 4, minParticipants: 30 }); // wrong ages and group size
    const busy = await vendor("Busy", c.id);
    await t.db.admin.query("INSERT INTO vendor_unavailable_blocks (tenant_id, starts_at, ends_at) VALUES ($1, now() + interval '9 days', now() + interval '11 days')", [busy.id]);
    const day = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const id = await sourcingRequest(c, { preferredDate: day });
    await post(asOps, `${api}/requests/${id}/matching/run`);
    const byName = Object.fromEntries((await sourcing(id)).matches.map((m: { vendorName: string }) => [m.vendorName, m]));
    const texts = (n: string) => byName[n].reasons.map((r: { text: string }) => r.text);
    expect(texts("Pricey")).toContain("Over the budget");
    expect(texts("Young Only")).toEqual(expect.arrayContaining(["The age range does not overlap", "Group size is outside what it offers"]));
    expect(texts("Busy")).toContain("Marked as unavailable on the preferred date");
    expect(byName["Pricey"].score).toBeLessThan(byName["Busy"].score + 40);
    void pricey; void young;
  });

  it("lets operations add an eligible vendor with a reason, never an ineligible one, and runs only while sourcing", async () => {
    const c = await activeCommunity("Manual Mews");
    const known = await vendor("Known Coach", c.id);
    const unapproved = await vendor("Not Approved", c.id, { approved: false });
    const id = await sourcingRequest(c);
    const manual = (vendorId: string, reason = "The family asked for them by name") => post(asOps, `${api}/requests/${id}/matching/manual`, { vendorId, reason });
    expect((await manual(unapproved.id)).json().error.code).toBe("vendor_not_eligible"); // safety rules are not overridable
    expect((await manual(randomUUID())).json().error.code).toBe("vendor_not_eligible");
    expect((await manual(known.id, "x")).statusCode).toBe(400); // a reason is required
    expect((await manual(known.id)).statusCode).toBe(200);
    const row = (await sourcing(id)).matches.find((m: { vendorName: string }) => m.vendorName === "Known Coach");
    expect(row).toMatchObject({ source: "manual", manualReason: "The family asked for them by name" });
    expect((await manual(known.id)).json().error.code).toBe("already_suggested");
    expect((await post(asBoss, `${api}/requests/${id}/matching/manual`, { vendorId: known.id, reason: "because" })).statusCode).toBe(403);
    expect((await post(asBoss, `${api}/requests/${id}/matching/run`)).statusCode).toBe(403);
    expect((await as(c.resident, c.id)(`${api}/requests/${id}/sourcing`)).statusCode).toBe(403);
    // not at this stage
    const early = await makeRequest(c);
    expect((await post(asOps, `${api}/requests/${early}/matching/run`)).json().error.code).toBe("not_in_sourcing");
    // running again keeps manual additions
    await post(asOps, `${api}/requests/${id}/matching/run`);
    expect((await sourcing(id)).matches.map((m: { vendorName: string }) => m.vendorName)).toContain("Known Coach");
  });
});

describe("inquiries and quotes", () => {
  it("asks suggested vendors, shows each only a snapshot that never says who asked, and moves the request on", async () => {
    const c = await activeCommunity("Inquiry Isle");
    const a = await vendor("Vendor A", c.id);
    const b = await vendor("Vendor B", c.id);
    const outsider = await vendor("Vendor Outsider", c.id);
    const id = await sourcingRequest(c, { description: "A morning session in the clubhouse.", venueText: "Clubhouse" });
    await post(asOps, `${api}/requests/${id}/matching/run`);
    const send = (vendorIds: string[], message?: string) => post(asOps, `${api}/requests/${id}/inquiries`, { vendorIds, ...(message ? { message } : {}) });

    expect((await send([randomUUID()])).json().error.code).toBe("vendor_not_suggested");
    expect((await send([])).statusCode).toBe(400);
    expect((await send([a.id, b.id, outsider.id, randomUUID(), randomUUID(), randomUUID()])).statusCode).toBe(400); // at most five per send
    expect((await post(asBoss, `${api}/requests/${id}/inquiries`, { vendorIds: [a.id] })).statusCode).toBe(403);
    const sent = await send([a.id, b.id], "Please quote for the full morning.");
    expect(sent.statusCode, sent.body).toBe(201);
    expect(sent.json().sent).toHaveLength(2);
    expect((await detail(asOps, id)).status).toBe("vendor_inquiry"); // moved on by sending
    expect((await send([a.id])).json().error.code).toBe("already_asked");

    // what the vendor sees
    const list = (await a.as(`${api}/inquiries`)).json().data as { id: string; title: string }[];
    expect(list).toHaveLength(1);
    const view = (await a.as(`${api}/inquiries/${list[0]?.id}`)).json();
    expect(view.message).toBe("Please quote for the full morning.");
    expect(view.request).toMatchObject({ title: "Cricket coaching for the weekend", participantCount: 12, ageMin: 8, ageMax: 12, venueText: "Clubhouse", community: { name: "Inquiry Isle" } });
    expect(view.request.answers).toEqual([{ label: "One time or regular?", value: "One time" }]);
    const raw = JSON.stringify(view);
    for (const secret of [c.resident.userId, "res-", "@example.test", "requester", "Member resident"]) expect(raw, secret).not.toContain(secret as string);
    // another vendor, an outsider, a family and a community administrator see none of it
    expect(((await b.as(`${api}/inquiries`)).json().data as { id: string }[]).map((x) => x.id)).not.toContain(list[0]?.id);
    expect((await b.as(`${api}/inquiries/${list[0]?.id}`)).statusCode).toBe(404);
    expect(((await outsider.as(`${api}/inquiries`)).json().data as unknown[]).length).toBe(0);
    expect((await as(c.resident, c.id)(`${api}/inquiries`)).statusCode).toBe(403);
    expect((await as(c.admin, c.id)(`${api}/inquiries`)).statusCode).toBe(403);
    expect((await asOps(`${api}/inquiries`)).statusCode).toBe(403); // the team has no vendor inbox

    // a vendor that stopped being eligible is refused at send time, even though it was suggested
    await t.db.admin.query("UPDATE vendor_vetting_summary SET complete = false WHERE tenant_id = $1", [outsider.id]);
    expect((await send([outsider.id])).json().error.code).toBe("vendor_not_eligible");
  });

  it("lets a vendor decline with a reason, quote with line items, withdraw and correct a quote, and lets operations capture a quote by phone", async () => {
    const c = await activeCommunity("Quote Quay");
    const a = await vendor("Quoter A", c.id);
    const b = await vendor("Decliner B", c.id);
    const d = await vendor("Phone D", c.id);
    const id = await sourcingRequest(c);
    await post(asOps, `${api}/requests/${id}/matching/run`);
    await post(asOps, `${api}/requests/${id}/inquiries`, { vendorIds: [a.id, b.id, d.id] });
    const inquiry = async (v: { as: Caller }) => ((await v.as(`${api}/inquiries`)).json().data as { id: string }[])[0]?.id as string;
    const [ia, ib] = [await inquiry(a), await inquiry(b)];
    const line = (over: Record<string, unknown> = {}) => ({ description: "Coaching for 12 children", quantity: 12, unitMinor: 40_000, ...over });

    // declining
    expect((await post(b.as, `${api}/inquiries/${ib}/decline`, { reason: "x" })).statusCode).toBe(400);
    expect((await post(b.as, `${api}/inquiries/${ib}/decline`, { reason: "Fully booked that weekend" })).statusCode).toBe(200);
    expect((await post(b.as, `${api}/inquiries/${ib}/decline`, { reason: "Again please" })).json().error.code).toBe("not_open");
    expect((await post(b.as, `${api}/inquiries/${ib}/quote`, { lines: [line()] })).json().error.code).toBe("not_open");
    expect((await post(a.as, `${api}/inquiries/${ib}/decline`, { reason: "not mine to decline" })).statusCode).toBe(409); // not waiting for THEM: no row is theirs to update

    // quoting: the total is computed from the lines, never trusted from the client
    const bad = async (body: unknown) => (await post(a.as, `${api}/inquiries/${ia}/quote`, body)).statusCode;
    expect(await bad({ lines: [] })).toBe(400);
    expect(await bad({ lines: [line({ unitMinor: -1 })] })).toBe(400);
    expect(await bad({ lines: [line({ description: "" })] })).toBe(400);
    expect(await bad({ lines: [line()], validUntil: "2001-01-01" })).toBe(400);
    expect(await bad({ lines: [line()], totalMinor: 1 })).toBe(400); // no client-supplied total
    const made = await post(a.as, `${api}/inquiries/${ia}/quote`, { lines: [line(), line({ kind: "travel", description: "Travel", quantity: 1, unitMinor: 50_000 })], notes: "Includes equipment." });
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json()).toMatchObject({ status: "submitted", totalMinor: 12 * 40_000 + 50_000, vendorName: "Quoter A" });
    expect(made.json().lines).toHaveLength(2);
    expect((await post(a.as, `${api}/inquiries/${ia}/quote`, { lines: [line()] })).json().error.code).toBe("quote_exists");
    // withdraw and correct
    expect((await post(a.as, `${api}/quotes/${made.json().id}/withdraw`)).statusCode).toBe(200);
    expect((await post(a.as, `${api}/quotes/${made.json().id}/withdraw`)).json().error.code).toBe("not_open");
    const corrected = await post(a.as, `${api}/inquiries/${ia}/quote`, { lines: [line({ unitMinor: 35_000 })] });
    expect(corrected.json().totalMinor).toBe(420_000);
    expect((await post(b.as, `${api}/quotes/${corrected.json().id}/withdraw`)).statusCode).toBe(404); // another vendor's quote does not exist for them
    const view = (await a.as(`${api}/inquiries/${ia}`)).json();
    expect(view.status).toBe("quoted");
    expect(view.quotes.map((q: { status: string }) => q.status).sort()).toEqual(["submitted", "withdrawn"]);

    // operations capture a quote obtained by phone for the third vendor
    const idD = ((await sourcing(id)).inquiries as { id: string; vendorName: string }[]).find((i) => i.vendorName === "Phone D")?.id;
    const phone = await post(asOps, `${api}/inquiries/${idD}/quote`, { lines: [line({ unitMinor: 30_000 })], notes: "Quoted by phone, Friday." });
    expect(phone.statusCode, phone.body).toBe(201);
    const view2 = await sourcing(id);
    expect(view2.quotes.filter((q: { status: string }) => q.status === "submitted")).toHaveLength(2);
    expect(view2.inquiries.map((i: { status: string }) => i.status).sort()).toEqual(["declined", "quoted", "quoted"]);
    expect(view2.inquiries.find((i: { vendorName: string }) => i.vendorName === "Decliner B").declineReason).toBe("Fully booked that weekend");
    // the family, the community and other vendors cannot see any of these quotes
    expect(JSON.stringify((await as(c.resident, c.id)(`${api}/requests/${id}`)).json())).not.toContain("Quoter A");
  });

  it("withdraws an inquiry operations no longer want answered, and refuses a quote on it", async () => {
    const c = await activeCommunity("Withdraw Wharf");
    const a = await vendor("Withdrawn A", c.id);
    const id = await sourcingRequest(c);
    await post(asOps, `${api}/requests/${id}/matching/run`);
    await post(asOps, `${api}/requests/${id}/inquiries`, { vendorIds: [a.id] });
    const inquiryId = ((await sourcing(id)).inquiries as { id: string }[])[0]?.id;
    expect((await post(asOps, `${api}/inquiries/${inquiryId}/withdraw`)).statusCode).toBe(200);
    expect((await post(asOps, `${api}/inquiries/${inquiryId}/withdraw`)).json().error.code).toBe("not_open");
    expect((await post(a.as, `${api}/inquiries/${inquiryId}/quote`, { lines: [{ description: "x", unitMinor: 1 }] })).json().error.code).toBe("not_open");
  });
});

describe("comparing, offering and choosing", () => {
  async function quotedRequest(label: string) {
    const c = await activeCommunity(label);
    const cheap = await vendor("Cheap Coach", c.id);
    const dear = await vendor("Dear Coach", c.id);
    const id = await sourcingRequest(c);
    await post(asOps, `${api}/requests/${id}/matching/run`);
    await post(asOps, `${api}/requests/${id}/inquiries`, { vendorIds: [cheap.id, dear.id] });
    const quotes: Record<string, string> = {};
    for (const [v, unit] of [[cheap, 30_000], [dear, 60_000]] as const) {
      const inquiryId = ((await v.as(`${api}/inquiries`)).json().data as { id: string }[])[0]?.id;
      const q = await post(v.as, `${api}/inquiries/${inquiryId}/quote`, { lines: [{ description: "Coaching", quantity: 10, unitMinor: unit }] });
      quotes[v.name] = q.json().id as string;
    }
    return { c, id, cheap, dear, quotes };
  }

  it("guards each step of the workflow with what it needs, and shows the family only what operations offered", async () => {
    const { c, id, quotes } = await quotedRequest("Compare Court");
    const resident = as(c.resident, c.id);
    // quotes can be shortlisted only while comparing: not while vendors are still being asked
    expect((await put(asOps, `${api}/quotes/${quotes["Cheap Coach"]}/shortlist`, { shortlisted: true })).json().error.code).toBe("not_comparing");
    // steps need their preconditions
    expect((await go(asOps, id, "shortlisted")).statusCode).toBe(409); // not a step from vendor_inquiry
    expect((await go(asOps, id, "quotes_received")).statusCode).toBe(200);
    expect((await go(asOps, id, "shortlisted")).json().error.code).toBe("not_ready"); // nothing shortlisted yet
    // shortlisting only while comparing, and only submitted quotes
    expect((await put(asOps, `${api}/quotes/${randomUUID()}/shortlist`, { shortlisted: true })).statusCode).toBe(404);
    expect((await put(asBoss, `${api}/quotes/${quotes["Cheap Coach"]}/shortlist`, { shortlisted: true })).statusCode).toBe(403);
    expect((await put(resident, `${api}/quotes/${quotes["Cheap Coach"]}/shortlist`, { shortlisted: true })).statusCode).toBe(403);
    expect((await put(asOps, `${api}/quotes/${quotes["Cheap Coach"]}/shortlist`, { shortlisted: false })).json().error.code).toBe("invalid_state");
    expect((await put(asOps, `${api}/quotes/${quotes["Cheap Coach"]}/shortlist`, { shortlisted: true })).statusCode).toBe(200);
    // the family still sees nothing until the request is offered to them
    expect((await detail(resident, id)).options.map((o: { vendorName: string }) => o.vendorName)).toEqual(["Cheap Coach"]); // shortlisted rows are visible by policy...
    expect((await detail(resident, id)).status).toBe("quotes_received"); // ...but the page only offers them once the step is taken
    expect((await go(asOps, id, "shortlisted")).statusCode).toBe(200);
    // once offered, the options are fixed until operations take the request back to comparing
    expect((await put(asOps, `${api}/quotes/${quotes["Dear Coach"]}/shortlist`, { shortlisted: true })).json().error.code).toBe("not_comparing");
    const family = await detail(resident, id);
    expect(family.options).toHaveLength(1);
    expect(family.options[0]).toMatchObject({ vendorName: "Cheap Coach", totalMinor: 300_000, status: "shortlisted" });
    expect(family.options[0].lines).toEqual([{ kind: "service", description: "Coaching", quantity: 10, unitMinor: 30_000 }]);
    expect(JSON.stringify(family)).not.toContain("Dear Coach"); // the vendor operations did not offer is invisible
    expect(family.transitions.map((x: { to: string }) => x.to)).toEqual(expect.arrayContaining(["booking_pending", "cancelled"]));
    // the neighbour and the community's administrator see no options
    expect((await as(c.neighbour, c.id)(`${api}/requests/${id}`)).statusCode).toBe(404);
    expect((await detail(as(c.admin, c.id), id)).options).toEqual([]);
    // operations can change the options while the family has not chosen
    expect((await go(asOps, id, "quotes_received")).statusCode).toBe(200);
    expect((await put(asOps, `${api}/quotes/${quotes["Dear Coach"]}/shortlist`, { shortlisted: true })).statusCode).toBe(200);
    expect((await go(asOps, id, "shortlisted")).statusCode).toBe(200);
    expect((await detail(resident, id)).options).toHaveLength(2);
  });

  it("lets the family choose one: the quote is accepted, a booking opens, other people cannot choose for them", async () => {
    const { c, id, quotes } = await quotedRequest("Choose Cove");
    await go(asOps, id, "quotes_received");
    await put(asOps, `${api}/quotes/${quotes["Cheap Coach"]}/shortlist`, { shortlisted: true });
    const resident = as(c.resident, c.id);
    const accept = (who: Caller, quoteId: string) => post(who, `${api}/requests/${id}/quotes/${quoteId}/accept`);

    expect((await accept(resident, quotes["Cheap Coach"] as string)).json().error.code).toBe("not_offered"); // not offered yet
    await go(asOps, id, "shortlisted");
    expect((await accept(asOps, quotes["Cheap Coach"] as string)).statusCode).toBe(403); // the team cannot accept for them
    // not even a super administrator, who holds quotes.accept as every permission: the family chooses, nobody else
    const root = await makeStaff(t, email("root"), "super_admin");
    expect((await accept((u, e) => call(t.app, { url: u, cookie: root.cookie, headers: PLATFORM_SCOPE, ...(e ?? {}) }), quotes["Cheap Coach"] as string)).statusCode).toBe(403);
    // and the bare status change is not a way round choosing: it would skip the quote and the booking
    expect((await go(resident, id, "booking_pending")).json().error.code).toBe("use_accept");
    expect((await go(asOps, id, "booking_pending")).statusCode).toBeGreaterThanOrEqual(403);
    expect((await accept(as(c.neighbour, c.id), quotes["Cheap Coach"] as string)).statusCode).toBe(404);
    expect((await accept(resident, quotes["Dear Coach"] as string)).statusCode).toBe(404); // not offered to them, so invisible to them
    expect((await accept(resident, randomUUID())).statusCode).toBe(404);
    const done = await accept(resident, quotes["Cheap Coach"] as string);
    expect(done.statusCode, done.body).toBe(201);
    const family = await detail(resident, id);
    expect(family.status).toBe("booking_pending");
    expect(family.booking).toMatchObject({ status: "pending_vendor", vendorName: "Cheap Coach", agreedTotalMinor: 300_000, scheduledStart: null });
    expect(family.options.map((o: { status: string }) => o.status)).toEqual(["accepted"]);
    expect((await accept(resident, quotes["Cheap Coach"] as string)).json().error.code).toBe("not_offered"); // only once
  });
});

describe("the booking", () => {
  async function bookedRequest(label: string) {
    const c = await activeCommunity(label);
    const v = await vendor("Booked Coach", c.id);
    const other = await vendor("Other Coach", c.id);
    const id = await sourcingRequest(c);
    await post(asOps, `${api}/requests/${id}/matching/run`);
    await post(asOps, `${api}/requests/${id}/inquiries`, { vendorIds: [v.id, other.id] });
    const inquiryOf = async (x: { as: Caller }) => ((await x.as(`${api}/inquiries`)).json().data as { id: string }[])[0]?.id;
    const quote = (await post(v.as, `${api}/inquiries/${await inquiryOf(v)}/quote`, { lines: [{ description: "Coaching", quantity: 10, unitMinor: 30_000 }] })).json().id as string;
    const otherInquiry = await inquiryOf(other);
    await go(asOps, id, "quotes_received");
    await put(asOps, `${api}/quotes/${quote}/shortlist`, { shortlisted: true });
    await go(asOps, id, "shortlisted");
    expect((await post(as(c.resident, c.id), `${api}/requests/${id}/quotes/${quote}/accept`)).statusCode).toBe(201);
    const booking = (await sourcing(id)).booking as { id: string };
    return { c, id, v, other, otherInquiry, booking: booking.id, resident: as(c.resident, c.id) };
  }
  const when = (days: number, hours = 10) => new Date(Date.now() + days * 86_400_000 + hours * 3_600_000).toISOString();

  it("is scheduled by operations, confirmed by the vendor and then by operations, and completed; each step is refused out of order", async () => {
    const { c, id, v, other, otherInquiry, booking, resident } = await bookedRequest("Booking Bay");

    // out of order
    expect((await post(v.as, `${api}/bookings/${booking}/vendor-confirm`)).json().error.code).toBe("not_scheduled");
    expect((await go(asOps, id, "confirmed")).json().error.code).toBe("vendor_not_confirmed");
    expect((await post(asBoss, `${api}/bookings/${booking}/schedule`, { start: when(3), end: when(3, 12) })).statusCode).toBe(403);
    expect((await post(resident, `${api}/bookings/${booking}/schedule`, { start: when(3), end: when(3, 12) })).statusCode).toBe(403);
    expect((await post(asOps, `${api}/bookings/${booking}/schedule`, { start: when(-1), end: when(0) })).statusCode).toBe(400); // the past
    expect((await post(asOps, `${api}/bookings/${booking}/schedule`, { start: when(3, 12), end: when(3) })).statusCode).toBe(400); // ends before it starts

    expect((await post(asOps, `${api}/bookings/${booking}/schedule`, { start: when(3), end: when(3, 12), venueText: "Clubhouse" })).statusCode).toBe(200);
    // the team's next step releases the vendors that were not chosen: their open inquiry can no longer be quoted
    expect((await post(other.as, `${api}/inquiries/${otherInquiry}/quote`, { lines: [{ description: "late", unitMinor: 1 }] })).json().error.code).toBe("not_open");
    expect((await post(other.as, `${api}/bookings/${booking}/vendor-confirm`)).statusCode).toBe(404); // not their booking
    expect((await post(resident, `${api}/bookings/${booking}/vendor-confirm`)).statusCode).toBe(403);
    expect((await post(v.as, `${api}/bookings/${booking}/vendor-confirm`)).statusCode).toBe(200);
    // rescheduling after the vendor agreed needs their agreement again
    expect((await post(asOps, `${api}/bookings/${booking}/schedule`, { start: when(4), end: when(4, 12), venueText: "Clubhouse" })).statusCode).toBe(200);
    expect((await go(asOps, id, "confirmed")).json().error.code).toBe("vendor_not_confirmed");
    expect((await post(v.as, `${api}/bookings/${booking}/vendor-confirm`)).statusCode).toBe(200);

    expect((await go(asOps, id, "completed")).statusCode).toBe(409); // not from booking_pending
    const confirmed = await go(asOps, id, "confirmed");
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const family = await detail(resident, id);
    expect(family.status).toBe("confirmed");
    expect(family.booking).toMatchObject({ status: "confirmed", venueText: "Clubhouse" });
    expect(new Date(family.booking.scheduledStart).getTime()).toBeGreaterThan(Date.now());
    // a confirmed booking cannot be cancelled by the family, but can by operations with a note
    expect((await go(resident, id, "cancelled")).statusCode).toBe(403); // the step exists, but only for operations
    expect((await go(asOps, id, "completed")).statusCode).toBe(200);
    expect((await detail(resident, id)).booking).toMatchObject({ status: "completed" });
    expect((await detail(resident, id)).terminal).toBe(true);

    const vendorView = ((await v.as(`${api}/bookings`)).json().data as { status: string; requestId: string }[]);
    expect(vendorView).toHaveLength(1);
    expect(vendorView[0]).toMatchObject({ status: "completed", requestId: id });
    expect(JSON.stringify(vendorView)).not.toContain(c.resident.userId ?? "no-id");
    expect(((await other.as(`${api}/bookings`)).json().data as unknown[]).length).toBe(0);
    expect(((await asOps(`${api}/bookings?status=completed`)).json().data as { requestId: string }[]).map((b) => b.requestId)).toContain(id);
    const audit = await t.db.admin.query("SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY created_at", [booking]);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["booking.scheduled", "booking.vendor_confirmed"]));
  });

  it("can be cancelled by operations with a note after confirmation, which closes the booking", async () => {
    const { id, v, booking, resident } = await bookedRequest("Cancel Creek");
    await post(asOps, `${api}/bookings/${booking}/schedule`, { start: when(3), end: when(3, 12) });
    await post(v.as, `${api}/bookings/${booking}/vendor-confirm`);
    await go(asOps, id, "confirmed");
    expect((await go(asOps, id, "cancelled")).json().error.code).toBe("note_required");
    expect((await go(asOps, id, "cancelled", "The vendor fell ill.")).statusCode).toBe(200);
    expect((await detail(resident, id)).booking).toBeNull(); // cancelled bookings are not shown as live
    expect(((await sourcing(id)).cancelledBookings as { cancelReason: string }[])[0]?.cancelReason).toBe("The vendor fell ill.");
  });

  it("lets the family cancel while the vendor has not confirmed, lets the vendor decline, and lets operations start again with other vendors", async () => {
    const a = await bookedRequest("Decline Dock");
    await post(asOps, `${api}/bookings/${a.booking}/schedule`, { start: when(3), end: when(3, 12) });
    expect((await post(a.v.as, `${api}/bookings/${a.booking}/vendor-decline`, { reason: "x" })).statusCode).toBe(400);
    expect((await post(a.v.as, `${api}/bookings/${a.booking}/vendor-decline`, { reason: "Fully booked that day" })).statusCode).toBe(200);
    expect((await post(a.v.as, `${api}/bookings/${a.booking}/vendor-decline`, { reason: "Again please" })).json().error.code).toBe("invalid_state");
    // the request is still waiting; operations restart with a note, which also rejects the accepted quote
    expect((await go(asOps, a.id, "sourcing")).json().error.code).toBe("note_required");
    expect((await go(asOps, a.id, "sourcing", "The vendor declined; finding another.")).statusCode).toBe(200);
    const view = await sourcing(a.id);
    expect(view.booking).toBeNull();
    expect(view.quotes.map((q: { status: string }) => q.status)).toEqual(["rejected"]);
    expect(view.cancelledBookings[0].cancelReason).toContain("Declined by the vendor: Fully booked that day");

    const b = await bookedRequest("Family Fjord");
    expect((await go(b.resident, b.id, "cancelled")).statusCode).toBe(200);
    expect((await sourcing(b.id)).booking).toBeNull();
    expect(((await sourcing(b.id)).cancelledBookings as { cancelReason: string }[])[0]?.cancelReason).toBe("Cancelled by the family");
  });
});

describe("what each person can see, in one place", () => {
  it("never shows a vendor the family, never shows a family another vendor's price, and never shows a community's administrator the options", async () => {
    const c = await activeCommunity("Privacy Pier");
    const a = await vendor("Privacy A", c.id);
    const b = await vendor("Privacy B", c.id);
    const id = await sourcingRequest(c, { description: "For my daughter's birthday." });
    await post(asOps, `${api}/requests/${id}/matching/run`);
    await post(asOps, `${api}/requests/${id}/inquiries`, { vendorIds: [a.id, b.id] });
    for (const v of [a, b]) {
      const inquiryId = ((await v.as(`${api}/inquiries`)).json().data as { id: string }[])[0]?.id;
      await post(v.as, `${api}/inquiries/${inquiryId}/quote`, { lines: [{ description: `${v.name} price`, unitMinor: 111_111 }] });
    }
    // vendors cannot read requests or each other's inquiries through any route
    for (const v of [a, b]) {
      expect((await v.as(`${api}/requests/${id}`)).statusCode).toBeGreaterThanOrEqual(403);
      expect((await v.as(`${api}/requests`)).statusCode).toBe(403);
    }
    const inquiryPayloads = JSON.stringify([(await a.as(`${api}/inquiries`)).json(), (await b.as(`${api}/inquiries`)).json()]);
    expect(inquiryPayloads).not.toContain(c.resident.userId ?? "no-id");
    // the family's page names no vendor until operations offer one
    expect(JSON.stringify(await detail(as(c.resident, c.id), id))).not.toMatch(/Privacy A|Privacy B/u);
    // the community's administrator sees the request but no vendors' prices
    const adminView = JSON.stringify(await detail(as(c.admin, c.id), id));
    expect(adminView).not.toMatch(/Privacy A|Privacy B|111111/u);
    // vendor private details never appear in the ops sourcing view either
    expect(JSON.stringify(await sourcing(id))).not.toMatch(/private@vendor\.test|Private Legal LLP/u);
  });
});
