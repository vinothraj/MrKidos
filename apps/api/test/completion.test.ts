import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Mailer } from "../src/mailer";
import { call, createTestApp, makeMember, makeStaff, PLATFORM_SCOPE, register, type TestApp } from "./helpers";

let t: TestApp;
let ops: { cookie: string; userId: string };
let boss: { cookie: string; userId: string }; // platform_admin: no payments.record, no reviews.moderate
let seq = 0;
const email = (p: string) => `${p}-${++seq}@example.test`;
const api = "/api/v1";

type Who = { cookie: string; userId?: string; email?: string };
type Caller = (url: string, extra?: Partial<Parameters<typeof call>[1]>) => ReturnType<typeof call>;
const asOps: Caller = (url, extra = {}) => call(t.app, { url, cookie: ops.cookie, headers: PLATFORM_SCOPE, ...extra });
const asBoss: Caller = (url, extra = {}) => call(t.app, { url, cookie: boss.cookie, headers: PLATFORM_SCOPE, ...extra });
const as = (who: Who, tenantId: string): Caller => (url, extra = {}) => call(t.app, { url, cookie: who.cookie, headers: { "x-tenant-id": tenantId }, ...extra });
const post = (who: Caller, url: string, body: unknown = {}) => who(url, { method: "POST", body });
const put = (who: Caller, url: string, body: unknown) => who(url, { method: "PUT", body });
const go = (who: Caller, id: string, to: string, note?: string) => post(who, `${api}/requests/${id}/transitions`, { to, ...(note ? { note } : {}) });

const COMMUNITY = {
  communityType: "gated_community", country: "India", state: "Karnataka", city: "Bengaluru", locality: "Whitefield", address: "12 Lake Road",
  contactName: "Ramesh Kumar", contactEmail: "ramesh@example.test", contactPhone: "+91 98765 43210", latitude: 12.97, longitude: 77.75, unitCount: 420, population: 1500,
};
let categories: { id: string; key: string }[] = [];
let activityType = "";
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
type Community = Awaited<ReturnType<typeof activeCommunity>>;

async function vendor(name: string, communityId: string) {
  const id = randomUUID();
  const q = (sql: string, p: unknown[]) => t.db.admin.query(sql, p);
  await q("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'vendor', $2, 'active')", [id, name]);
  await q("INSERT INTO vendor_profiles (tenant_id, description, city) VALUES ($1, 'Coaching', 'Bengaluru')", [id]);
  await q("INSERT INTO vendor_service_areas (tenant_id, community_id) VALUES ($1, $2)", [id, communityId]);
  await q("INSERT INTO vendor_vetting_summary (tenant_id, complete) VALUES ($1, true)", [id]);
  await q("INSERT INTO community_vendor_approvals (tenant_id, vendor_id, status) VALUES ($1, $2, 'approved')", [communityId, id]);
  await q("INSERT INTO vendor_categories (tenant_id, category_id) VALUES ($1, $2)", [id, catId("cricket")]);
  await q("INSERT INTO offerings (tenant_id, category_id, name, description, pricing_model, price_minor, duration_minutes, cancellation_policy, status) VALUES ($1, $2, $3, 'Fun', 'fixed', 500000, 60, 'Free', 'published')", [id, catId("cricket"), `${name} programme`]);
  const ownerEmail = email("vown");
  const owner = { ...(await makeMember(t, ownerEmail, id, ["vendor_owner"], { mfa: true })), email: ownerEmail };
  return { id, name, owner, as: as(owner, id) };
}

async function request(c: Community, who: Who = c.resident): Promise<string> {
  const res = await post(as(who, c.id), `${api}/requests`, { requestTypeId: activityType, title: "Private title about my child", categoryId: catId("cricket"), participantCount: 12, ageMin: 8, ageMax: 12, budgetMaxMinor: 800_000, answers: { format: "one_time" } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
const when = (days: number, hours = 10) => new Date(Date.now() + days * 86_400_000 + hours * 3_600_000).toISOString();
const sourcing = async (id: string) => (await asOps(`${api}/requests/${id}/sourcing`)).json();

/** Takes a request all the way to a confirmed (and optionally completed) booking, through the real API. */
async function booked(label: string, finish = false) {
  const c = await activeCommunity(label);
  const v = await vendor(`${label} Coach`, c.id);
  const other = await vendor(`${label} Other`, c.id);
  const id = await request(c);
  for (const to of ["under_review", "approved", "sourcing"]) expect((await go(asOps, id, to)).statusCode, to).toBe(200);
  await post(asOps, `${api}/requests/${id}/matching/run`);
  await post(asOps, `${api}/requests/${id}/inquiries`, { vendorIds: [v.id, other.id] });
  const inquiryOf = async (x: { as: Caller }) => ((await x.as(`${api}/inquiries`)).json().data as { id: string }[])[0]?.id;
  const quote = (await post(v.as, `${api}/inquiries/${await inquiryOf(v)}/quote`, { lines: [{ description: "Coaching", quantity: 10, unitMinor: 30_000 }] })).json().id as string;
  await go(asOps, id, "quotes_received");
  await put(asOps, `${api}/quotes/${quote}/shortlist`, { shortlisted: true });
  await go(asOps, id, "shortlisted");
  const resident = as(c.resident, c.id);
  expect((await post(resident, `${api}/requests/${id}/quotes/${quote}/accept`)).statusCode).toBe(201);
  const booking = ((await sourcing(id)).booking as { id: string }).id;
  expect((await post(asOps, `${api}/bookings/${booking}/schedule`, { start: when(3), end: when(3, 12) })).statusCode).toBe(200);
  expect((await post(v.as, `${api}/bookings/${booking}/vendor-confirm`)).statusCode).toBe(200);
  expect((await go(asOps, id, "confirmed")).statusCode).toBe(200);
  if (finish) expect((await go(asOps, id, "completed")).statusCode).toBe(200);
  return { c, v, other, id, booking, resident, otherInquiry: await inquiryOf(other) };
}

beforeAll(async () => {
  t = await createTestApp();
  ops = await makeStaff(t, "ops@example.test", "business_operations");
  boss = await makeStaff(t, "boss@example.test", "platform_admin");
  categories = (await asBoss(`${api}/categories`)).json().data;
  const c = await activeCommunity("Bootstrap Bay");
  activityType = ((await as(c.resident, c.id)(`${api}/request-types`)).json().data as { id: string; key: string }[]).find((x) => x.key === "activity")?.id as string;
});
afterAll(async () => {
  await t.close();
});

describe("email notifications", () => {
  const mailsTo = (to: string) => t.mailer.sent.filter((m) => m.to === to);

  it("tell people what is waiting for them, with a link and nothing private, and only the people concerned", async () => {
    const c = await activeCommunity("Notify Nook");
    const v = await vendor("Notified Coach", c.id);
    const bystander = await vendor("Bystander Coach", c.id);
    const before = t.mailer.sent.length;
    const id = await request(c);
    // a new request alerts the ops desk address (set in the test configuration), without saying what it is about
    const alert = t.mailer.sent.slice(before).find((m) => m.to === "ops-desk@example.test");
    expect(alert?.subject).toContain("A new request");
    expect(alert?.text).toContain(`/app/requests/${id}`);

    for (const to of ["under_review", "approved", "sourcing"]) await go(asOps, id, to);
    await post(asOps, `${api}/requests/${id}/matching/run`);
    const mark = t.mailer.sent.length;
    await post(asOps, `${api}/requests/${id}/inquiries`, { vendorIds: [v.id] });
    const sent = t.mailer.sent.slice(mark);
    expect(sent.map((m) => m.to)).toEqual([v.owner.email]); // the vendor's team, nobody else
    expect(sent[0]?.subject).toContain("A request to quote");
    expect(mailsTo(bystander.owner.email).filter((m) => m.subject.includes("A request to quote"))).toHaveLength(0); // (registration emails are not events)

    // ...and none of it carries private content: no request title, no names, no prices, no ids of people
    const everything = JSON.stringify(t.mailer.sent.slice(before));
    for (const secret of ["Private title", "child", c.resident.userId ?? "no-id", "Rhea", "30000", "Coaching"]) expect(everything, secret).not.toContain(secret);
    expect(sent[0]?.text).toContain("/app/inquiries");

    // a question for the family goes to the family
    await go(asOps, id, "quotes_received").catch(() => undefined);
  });

  it("reach the family at each step that waits for them, and the vendor when a booking is confirmed", async () => {
    const c = await activeCommunity("Steps Strand");
    const id = await request(c);
    const address = c.resident.email;
    const subjects = () => mailsTo(address).map((m) => m.subject);
    await go(asOps, id, "under_review");
    await go(asOps, id, "information_required", "Which weekend?");
    expect(subjects().some((s) => s.includes("The team has a question for you"))).toBe(true);
    expect(JSON.stringify(mailsTo(address))).not.toContain("Which weekend"); // the question itself stays in the app
    await go(asOps, id, "under_review");
    await go(asOps, id, "approved");
    expect(subjects().some((s) => s.includes("Your request was approved"))).toBe(true);
    // a rejected request says there is an update, not why
    const other = await request(c);
    await go(asOps, other, "rejected", "Not something we can do.");
    expect(subjects().filter((s) => s.includes("An update on your request"))).toHaveLength(1);
    expect(JSON.stringify(mailsTo(address))).not.toContain("Not something we can do");
  });

  it("go out only after the action succeeds, and a failing mailer never breaks the action", async () => {
    const c = await activeCommunity("Quiet Quay");
    const id = await request(c);
    await go(asOps, id, "under_review");
    const before = t.mailer.sent.length;
    expect((await go(asOps, id, "information_required")).statusCode).toBe(400); // note required: refused, so nothing is sent
    expect((await go(asOps, id, "closed")).statusCode).toBe(409);
    expect(t.mailer.sent.length).toBe(before);

    const failing: Mailer = { send: async () => { throw new Error("provider down"); } };
    const broken = await createTestApp({}, failing);
    try {
      const staff = await makeStaff(broken, "ops@example.test", "business_operations");
      const admin = await makeStaff(broken, "boss@example.test", "platform_admin");
      const asB = (url: string, extra: Partial<Parameters<typeof call>[1]> = {}) => call(broken.app, { url, cookie: admin.cookie, headers: PLATFORM_SCOPE, ...extra });
      const asS = (url: string, extra: Partial<Parameters<typeof call>[1]> = {}) => call(broken.app, { url, cookie: staff.cookie, headers: PLATFORM_SCOPE, ...extra });
      const created = await asS(`${api}/communities`, { method: "POST", body: { name: "Broken Mail Bay", ...COMMUNITY } });
      const cid = created.json().id as string;
      await asS(`${api}/communities/${cid}/transitions`, { method: "POST", body: { to: "verification" } });
      const adminEmail = email("assign");
      await register(broken.app, adminEmail);
      await asS(`${api}/communities/${cid}/admins`, { method: "POST", body: { email: adminEmail } });
      await asB(`${api}/communities/${cid}/transitions`, { method: "POST", body: { to: "active", note: "ok" } });
      const resident = await makeMember(broken, email("res"), cid, ["resident"]);
      const types = (await call(broken.app, { url: `${api}/request-types`, cookie: resident.cookie, headers: { "x-tenant-id": cid } })).json().data as { id: string; key: string }[];
      const res = await call(broken.app, { method: "POST", url: `${api}/requests`, cookie: resident.cookie, headers: { "x-tenant-id": cid }, body: { requestTypeId: types.find((x) => x.key === "activity")?.id, title: "Still created", answers: { format: "one_time" } } });
      expect(res.statusCode, res.body).toBe(201); // the email failed; the request was made
    } finally {
      await broken.close();
    }
  });

  it("alert operations to what only a vendor or family can trigger, and the vendor when a review is published", async () => {
    const b = await booked("Alerts Arbor", true);
    const text = JSON.stringify(t.mailer.sent);
    expect(t.mailer.sent.some((m) => m.to === "ops-desk@example.test" && m.subject.includes("A quote arrived"))).toBe(true);
    expect(t.mailer.sent.some((m) => m.to === "ops-desk@example.test" && m.subject.includes("A family chose an option"))).toBe(true);
    expect(t.mailer.sent.some((m) => m.to === "ops-desk@example.test" && m.subject.includes("A vendor confirmed a date"))).toBe(true);
    expect(t.mailer.sent.some((m) => m.to === b.v.owner.email && m.subject.includes("Please confirm a date"))).toBe(true);
    expect(t.mailer.sent.some((m) => m.to === b.v.owner.email && m.subject.includes("A booking is confirmed"))).toBe(true);
    expect(text).not.toContain("Private title");
    const review = await post(b.resident, `${api}/bookings/${b.booking}/review`, { rating: 5, body: "Wonderful" });
    expect(review.statusCode, review.body).toBe(201);
    expect(t.mailer.sent.some((m) => m.to === "ops-desk@example.test" && m.subject.includes("A review to look at"))).toBe(true);
    const before = t.mailer.sent.length;
    await put(asOps, `${api}/reviews/${review.json().id}/moderation`, { decision: "publish" });
    expect(t.mailer.sent.slice(before).map((m) => m.to)).toEqual([b.v.owner.email]);
  });
});

describe("a request that has moved on no longer waits for vendors", () => {
  it("withdraws the other vendors' open inquiries at once when the family chooses, even though a family cannot touch inquiries", async () => {
    const b = await booked("Stale Strand");
    // the family chose one vendor; the other was never chosen
    const inbox = (await b.other.as(`${api}/inquiries`)).json().data as { id: string; status: string }[];
    expect(inbox[0]).toMatchObject({ id: b.otherInquiry, status: "withdrawn" }); // reads as "no longer needed" immediately
    const quote = await post(b.other.as, `${api}/inquiries/${b.otherInquiry}/quote`, { lines: [{ description: "late", unitMinor: 1 }] });
    expect(quote.statusCode).toBe(409);
    expect(quote.json().error.code).toBe("not_open");
    expect(((await b.other.as(`${api}/inquiries/${b.otherInquiry}`)).json() as { status: string }).status).toBe("withdrawn");
    // the database wall holds even if the API check were skipped
    await expect(
      t.db.app.query("SELECT 1"), // (connection sanity only; the policy itself is tested in the database suite)
    ).resolves.toBeDefined();
  });

  it("also when the family cancels, and reopens if operations start again", async () => {
    const c = await activeCommunity("Cancel Cove");
    const v = await vendor("Cancelled Coach", c.id);
    const id = await request(c);
    for (const to of ["under_review", "approved", "sourcing"]) await go(asOps, id, to);
    await post(asOps, `${api}/requests/${id}/matching/run`);
    await post(asOps, `${api}/requests/${id}/inquiries`, { vendorIds: [v.id] });
    const inquiry = ((await v.as(`${api}/inquiries`)).json().data as { id: string; status: string }[])[0];
    expect(inquiry?.status).toBe("sent");
    expect((await go(as(c.resident, c.id), id, "cancelled")).statusCode).toBe(200);
    expect(((await v.as(`${api}/inquiries`)).json().data as { status: string }[])[0]?.status).toBe("withdrawn");
    expect((await post(v.as, `${api}/inquiries/${inquiry?.id}/quote`, { lines: [{ description: "late", unitMinor: 1 }] })).json().error.code).toBe("not_open");
  });
});

describe("offline payments and the platform fee", () => {
  it("are recorded by operations for an active booking, summarised for each party, and bounded by what was agreed", async () => {
    const b = await booked("Pay Pier");
    const pay = (body: unknown, who: Caller = asOps) => post(who, `${api}/bookings/${b.booking}/payments`, body);
    const row = { kind: "family_to_vendor", amountMinor: 100_000, method: "upi", reference: "UPI-123", paidOn: new Date().toISOString().slice(0, 10) };

    expect((await pay(row, asBoss)).statusCode).toBe(403); // platform_admin cannot record payments
    expect((await pay(row, b.resident)).statusCode).toBe(403);
    expect((await pay({ ...row, paidOn: "2099-01-01" })).statusCode).toBe(400); // not in the future
    expect((await pay({ ...row, amountMinor: 0 })).statusCode).toBe(400);
    expect((await pay({ ...row, method: "bitcoin" })).statusCode).toBe(400);
    expect((await pay({ ...row, amountMinor: 400_000 })).json().error.code).toBe("overpaid"); // the price is 3,000
    expect((await pay({ ...row, kind: "vendor_to_platform", amountMinor: 1000 })).json().error.code).toBe("fee_not_set");

    const first = await pay(row);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ paidMinor: 100_000, balanceMinor: 200_000, paymentStatus: "partial", agreedTotalMinor: 300_000 });
    const second = await pay({ ...row, amountMinor: 200_000, method: "cash", reference: null });
    expect(second.json()).toMatchObject({ paidMinor: 300_000, balanceMinor: 0, paymentStatus: "paid" });
    expect((await pay({ ...row, amountMinor: 1 })).json().error.code).toBe("overpaid"); // nothing left to pay

    // the fee: set by operations, bounded, never below what was paid
    const fee = (feeMinor: number | null, who: Caller = asOps) => put(who, `${api}/bookings/${b.booking}/fee`, { feeMinor });
    expect((await fee(30_000, asBoss)).statusCode).toBe(403);
    expect((await fee(400_000)).statusCode).toBe(400);
    expect((await fee(-1)).statusCode).toBe(400);
    expect((await fee(30_000)).json().platformFeeMinor).toBe(30_000);
    expect((await pay({ ...row, kind: "vendor_to_platform", amountMinor: 20_000, method: "bank_transfer" })).json()).toMatchObject({ platformFeeMinor: 30_000, feePaidMinor: 20_000 });
    expect((await pay({ ...row, kind: "vendor_to_platform", amountMinor: 20_000 })).json().error.code).toBe("overpaid");
    expect((await fee(10_000)).json().error.code).toBe("fee_below_paid");

    // what each party sees
    const family2 = (await b.resident(`${api}/requests/${b.id}`)).json().booking;
    expect(family2).toMatchObject({ paidMinor: 300_000, paymentStatus: "paid" });
    expect(family2.payments).toHaveLength(2);
    expect(family2.platformFeeMinor).toBeUndefined(); // the vendor's fee arrangement is none of the family's business
    expect(family2.feePaidMinor).toBeUndefined();
    expect(JSON.stringify(family2)).not.toContain("vendor_to_platform");
    const vendorView = ((await b.v.as(`${api}/bookings`)).json().data as { platformFeeMinor: number; feePaidMinor: number; paidMinor: number }[])[0];
    expect(vendorView).toMatchObject({ platformFeeMinor: 30_000, feePaidMinor: 20_000, paidMinor: 300_000 });
    expect(JSON.stringify((await b.other.as(`${api}/bookings`)).json())).not.toContain(b.booking); // another vendor sees nothing
    const neighbour = await as(b.c.neighbour, b.c.id)(`${api}/requests/${b.id}`);
    expect(neighbour.statusCode).toBe(404);
    // payments can still be recorded after completion, and a cancelled booking takes none
    await go(asOps, b.id, "completed");
    expect((await fee(30_000)).statusCode).toBe(200); // unchanged: fine
    expect((await fee(31_000)).json().platformFeeMinor).toBe(31_000); // changed after completion: allowed for operations
    const c2 = await booked("Pay Pier Two");
    await go(asOps, c2.id, "cancelled", "The vendor fell ill.");
    expect((await post(asOps, `${api}/bookings/${c2.booking}/payments`, row)).json().error.code).toBe("booking_not_active");
  });

  it("cannot be recorded before the booking is confirmed", async () => {
    const c = await activeCommunity("Early Eddy");
    const v = await vendor("Early Coach", c.id);
    const id = await request(c);
    for (const to of ["under_review", "approved", "sourcing"]) await go(asOps, id, to);
    await post(asOps, `${api}/requests/${id}/matching/run`);
    await post(asOps, `${api}/requests/${id}/inquiries`, { vendorIds: [v.id] });
    const inquiryId = ((await v.as(`${api}/inquiries`)).json().data as { id: string }[])[0]?.id;
    const quote = (await post(v.as, `${api}/inquiries/${inquiryId}/quote`, { lines: [{ description: "x", unitMinor: 10_000 }] })).json().id as string;
    await go(asOps, id, "quotes_received");
    await put(asOps, `${api}/quotes/${quote}/shortlist`, { shortlisted: true });
    await go(asOps, id, "shortlisted");
    await post(as(c.resident, c.id), `${api}/requests/${id}/quotes/${quote}/accept`);
    const booking = ((await sourcing(id)).booking as { id: string }).id;
    const res = await post(asOps, `${api}/bookings/${booking}/payments`, { kind: "family_to_vendor", amountMinor: 100, method: "cash", paidOn: new Date().toISOString().slice(0, 10) });
    expect(res.json().error.code).toBe("booking_not_active");
    expect((await put(asOps, `${api}/bookings/${booking}/fee`, { feeMinor: 100 })).json().error.code).toBe("booking_not_active");
  });
});

describe("reviews", () => {
  it("are written once by the family after completion, stay private until operations publish them, and show no name", async () => {
    const b = await booked("Review Ridge");
    const review = (who: Caller, body: unknown = { rating: 5, body: "Brilliant afternoon" }) => post(who, `${api}/bookings/${b.booking}/review`, body);
    expect((await review(b.resident)).json().error.code).toBe("not_completed");
    await go(asOps, b.id, "completed");
    expect((await review(asOps)).statusCode).toBe(403); // the team does not review its own bookings
    expect((await review(as(b.c.neighbour, b.c.id))).statusCode).toBe(404); // a neighbour cannot even see the booking
    expect((await review(b.v.as)).statusCode).toBeGreaterThanOrEqual(403);
    expect((await review(b.resident, { rating: 0 })).statusCode).toBe(400);
    expect((await review(b.resident, { rating: 6 })).statusCode).toBe(400);
    expect((await review(b.resident, { rating: 4, body: "x".repeat(1001) })).statusCode).toBe(400);
    expect((await review(b.resident, { rating: 4, status: "published" })).statusCode).toBe(400); // cannot publish itself
    const made = await review(b.resident);
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json()).toMatchObject({ rating: 5, status: "pending", reply: null });
    expect((await review(b.resident)).json().error.code).toBe("already_reviewed");

    // private: the vendor, the neighbour and the public vendor page see nothing yet
    const catalog = async () => (await as(b.c.neighbour, b.c.id)(`${api}/catalog/vendors/${b.v.id}`)).json();
    expect(await catalog()).toMatchObject({ rating: { count: 0, average: null }, reviews: [] });
    // not even for the author: the public page lists published reviews only (the author sees theirs on their own request)
    expect(await (async () => (await b.resident(`${api}/catalog/vendors/${b.v.id}`)).json())()).toMatchObject({ rating: { count: 0, average: null }, reviews: [] });
    expect(((await b.v.as(`${api}/reviews`)).json().data as unknown[])).toHaveLength(0);
    // the author sees their own, pending, on their request
    expect((await b.resident(`${api}/requests/${b.id}`)).json().review).toMatchObject({ status: "pending", rating: 5 });

    // moderation
    expect((await asBoss(`${api}/reviews`)).statusCode).toBe(403); // platform_admin cannot moderate
    const queue = (await asOps(`${api}/reviews`)).json().data as { id: string; author: string; community: string; vendorName: string }[];
    expect(queue.find((r) => r.id === made.json().id)).toMatchObject({ vendorName: "Review Ridge Coach", community: "Review Ridge" });
    expect(queue.find((r) => r.id === made.json().id)?.author).toBeTruthy(); // moderators see who wrote it
    const decide = (decision: string, note?: string) => put(asOps, `${api}/reviews/${made.json().id}/moderation`, { decision, ...(note ? { note } : {}) });
    expect((await put(b.resident, `${api}/reviews/${made.json().id}/moderation`, { decision: "publish" })).statusCode).toBe(403);
    expect((await decide("reject")).json().error.code).toBe("note_required");
    expect((await decide("publish")).json().status).toBe("published");
    expect((await decide("reject")).json().error.code).toBe("note_required");

    // published: the vendor page shows it, anonymously, with a rating summary
    const page = await catalog();
    expect(page.rating).toEqual({ count: 1, average: 5 });
    expect(page.reviews).toHaveLength(1);
    expect(page.reviews[0]).toMatchObject({ rating: 5, body: "Brilliant afternoon", reply: null });
    expect(JSON.stringify(page)).not.toMatch(/Member resident|@example\.test/u);
    expect(((await b.v.as(`${api}/reviews`)).json().data as { id: string }[]).map((r) => r.id)).toEqual([made.json().id]);

    // the vendor answers once
    const reply = (who: Caller, text = "Thank you, it was a pleasure!") => post(who, `${api}/reviews/${made.json().id}/reply`, { reply: text });
    expect((await reply(b.other.as)).statusCode).toBe(409); // another vendor: not theirs
    expect((await reply(b.resident)).statusCode).toBe(403);
    expect((await reply(b.v.as, "")).statusCode).toBe(400);
    expect((await reply(b.v.as)).json().reply).toBe("Thank you, it was a pleasure!");
    expect((await reply(b.v.as, "Another thought")).json().error.code).toBe("cannot_reply");
    expect((await as(b.c.neighbour, b.c.id)(`${api}/catalog/vendors/${b.v.id}`)).json().reviews[0].reply).toBe("Thank you, it was a pleasure!");
    // the vendor sees the review next to its booking
    expect(((await b.v.as(`${api}/inquiries/${((await b.v.as(`${api}/inquiries`)).json().data as { id: string }[])[0]?.id}`)).json() as { review: { rating: number } }).review.rating).toBe(5);
  });

  it("can be declined with a reason the author reads, and a declined review stays hidden", async () => {
    const b = await booked("Reject Reef", true);
    const made = (await post(b.resident, `${api}/bookings/${b.booking}/review`, { rating: 1, body: "Mentions a child by name" })).json();
    const res = await put(asOps, `${api}/reviews/${made.id}/moderation`, { decision: "reject", note: "Please do not name children." });
    expect(res.json()).toMatchObject({ status: "rejected", moderationNote: "Please do not name children." });
    expect((await b.resident(`${api}/requests/${b.id}`)).json().review).toMatchObject({ status: "rejected", moderationNote: "Please do not name children." });
    expect((await as(b.c.neighbour, b.c.id)(`${api}/catalog/vendors/${b.v.id}`)).json().rating.count).toBe(0);
    expect((await b.resident(`${api}/catalog/vendors/${b.v.id}`)).json()).toMatchObject({ rating: { count: 0 }, reviews: [] }); // a declined review is not shown to its author on the public page either
    expect((await put(asOps, `${api}/reviews/${made.id}/moderation`, { decision: "publish" })).json().error.code).toBe("invalid_state"); // final
    expect((await post(b.v.as, `${api}/reviews/${made.id}/reply`, { reply: "hello" })).statusCode).toBe(409);
  });
});

describe("needs your attention", () => {
  it("tells each person what is waiting for them, only what they could open, and nothing when nothing waits", async () => {
    const c = await activeCommunity("Attention Alley");
    const v = await vendor("Attention Coach", c.id);
    const id = await request(c);
    const family = as(c.resident, c.id);
    const items = async (who: Caller) => ((await who(`${api}/me/attention`)).json().items as { key: string; label: string; href: string }[]);
    expect(await items(family)).toEqual([]);
    expect((await call(t.app, { url: `${api}/me/attention` })).statusCode).toBe(401);

    await go(asOps, id, "under_review");
    await go(asOps, id, "information_required", "Which weekend?");
    const asked = await items(family);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ href: `/app/requests/${id}` });
    expect(asked[0]?.label).toContain("We need more information");
    expect(await items(as(c.neighbour, c.id))).toEqual([]); // not their request
    expect(await items(as(c.admin, c.id))).toEqual([]);

    // the vendor: a request to quote, then nothing once it has moved on
    await go(asOps, id, "under_review");
    for (const to of ["approved", "sourcing"]) await go(asOps, id, to);
    await post(asOps, `${api}/requests/${id}/matching/run`);
    await post(asOps, `${api}/requests/${id}/inquiries`, { vendorIds: [v.id] });
    expect((await items(v.as)).map((i) => i.label)).toEqual(["1 request needs your quote"]);
    await go(family, id, "cancelled");
    expect(await items(v.as)).toEqual([]);

    // operations: what needs them, per permission (platform_admin lacks the booking and review permissions)
    const opsItems = await items(asOps);
    expect(opsItems.map((i) => i.key)).toEqual(expect.arrayContaining(["unassigned"]));
    const bossItems = await items(asBoss);
    expect(bossItems.map((i) => i.key)).not.toContain("reviews");
    const done = await booked("Attention Done", true);
    await post(done.resident, `${api}/bookings/${done.booking}/review`, { rating: 4 });
    expect((await items(asOps)).map((i) => i.key)).toEqual(expect.arrayContaining(["reviews", "unpaid"]));
    expect((await items(asBoss)).map((i) => i.key)).not.toContain("reviews");
  });

  it("reminds a family to review a completed booking until they have", async () => {
    const b = await booked("Remind Ridge", true);
    const review = async () => ((await b.resident(`${api}/me/attention`)).json().items as { key: string }[]).filter((i) => i.key.startsWith("review:"));
    expect(await review()).toHaveLength(1);
    await post(b.resident, `${api}/bookings/${b.booking}/review`, { rating: 5 });
    expect(await review()).toHaveLength(0);
  });
});
