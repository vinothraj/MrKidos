import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withContext } from "../src/context";
import { createTestDb, type TestDb } from "../src/testing";

/** The request-stage marker, offline payment records and reviews, attacked the way a hostile client would. */
const PLATFORM_ORG = "00000000-0000-4000-8000-000000000001";
let db: TestDb;
const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);

let community: string;
let v1: string;
let v2: string;
let resident: string;
let neighbour: string;
let ops: string;
let o1: string;
let o2: string;

const OPS = ["payments.record", "payments.read", "reviews.moderate", "bookings.confirm", "bookings.complete", "bookings.cancel", "requests.transition", "requests.read_all"];
const RES = ["requests.create_own", "requests.read_own", "requests.cancel_own", "reviews.create", "quotes.accept"];
const asOps = (permissions = OPS) => ({ tenantId: community, userId: ops, platformScope: true, permissions });
const asResident = (userId = resident) => ({ tenantId: community, userId, permissions: RES });
const asVendor = (vendor: string, userId: string) => ({ tenantId: vendor, userId, permissions: ["inquiries.respond", "quotes.create", "bookings.complete", "vendors.read", "reviews.reply"] });

async function user(name: string): Promise<string> {
  const id = randomUUID();
  await q("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)", [id, `${name}@pay.test`, name]);
  return id;
}

/** A booking for `vendor` on a fresh request by `requester`, in the given booking status. */
async function booking(vendor: string, requester: string, status: string, requestStatus = "confirmed"): Promise<{ request: string; booking: string; quote: string; inquiry: string }> {
  const request = (await q("INSERT INTO requests (tenant_id, requester_id, request_type_id, schema_version, title, status) VALUES ($1, $2, (SELECT id FROM request_types WHERE key = 'activity'), 1, 'Booked', $3) RETURNING id", [community, requester, requestStatus])).rows[0].id as string;
  const inquiry = (await q("INSERT INTO inquiries (tenant_id, request_id, vendor_id, snapshot, status) VALUES ($1, $2, $3, '{}', 'quoted') RETURNING id", [community, request, vendor])).rows[0].id as string;
  const quote = (await q("INSERT INTO quotes (tenant_id, request_id, inquiry_id, vendor_id, status, total_minor) VALUES ($1, $2, $3, $4, 'accepted', 100000) RETURNING id", [community, request, inquiry, vendor])).rows[0].id as string;
  const id = (await q("INSERT INTO bookings (tenant_id, request_id, quote_id, vendor_id, status, agreed_total_minor, scheduled_start, vendor_confirmed_at, confirmed_at) VALUES ($1, $2, $3, $4, $5, 100000, now() + interval '2 days', now(), now()) RETURNING id", [community, request, quote, vendor, status])).rows[0].id as string;
  return { request, booking: id, quote, inquiry };
}

beforeAll(async () => {
  db = await createTestDb();
  [community, v1, v2] = [randomUUID(), randomUUID(), randomUUID()];
  await q("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'community', 'Pay Heights', 'active')", [community]);
  await q("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'vendor', 'Vendor One', 'active'), ($2, 'vendor', 'Vendor Two', 'active')", [v1, v2]);
  [resident, neighbour, ops, o1, o2] = (await Promise.all(["res", "nei", "ops", "own1", "own2"].map(user))) as [string, string, string, string, string];
  await q("INSERT INTO platform_staff (user_id) VALUES ($1)", [ops]);
  await q("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [PLATFORM_ORG, ops]);
  await q("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'business_operations' AND tenant_id IS NULL", [PLATFORM_ORG, ops]);
  for (const id of [resident, neighbour]) {
    await q("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [community, id]);
    await q("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'resident' AND tenant_id IS NULL", [community, id]);
  }
  for (const [vendor, owner] of [[v1, o1], [v2, o2]] as const) {
    await q("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [vendor, owner]);
    await q("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'vendor_owner' AND tenant_id IS NULL", [vendor, owner]);
  }
  // vendors are visible to the community's families (so published reviews can be read)
  for (const v of [v1, v2]) {
    await q("INSERT INTO vendor_profiles (tenant_id) VALUES ($1)", [v]);
    await q("INSERT INTO vendor_service_areas (tenant_id, community_id) VALUES ($1, $2)", [v, community]);
    await q("INSERT INTO vendor_vetting_summary (tenant_id, complete) VALUES ($1, true)", [v]);
    await q("INSERT INTO community_vendor_approvals (tenant_id, vendor_id, status) VALUES ($1, $2, 'approved')", [community, v]);
  }
});
afterAll(async () => {
  await db.close();
});

describe("the request stage marker", () => {
  it("follows the request and stops vendors quoting once it has moved past the asking stage", async () => {
    const request = (await q("INSERT INTO requests (tenant_id, requester_id, request_type_id, schema_version, title, status) VALUES ($1, $2, (SELECT id FROM request_types WHERE key = 'activity'), 1, 'Stage', 'vendor_inquiry') RETURNING id", [community, resident])).rows[0].id as string;
    const inquiry = (await q("INSERT INTO inquiries (tenant_id, request_id, vendor_id, snapshot) VALUES ($1, $2, $3, '{}') RETURNING id", [community, request, v1])).rows[0].id as string;
    const flag = async () => (await q("SELECT closed FROM request_stage_flags WHERE request_id = $1", [request])).rows[0]?.closed as boolean;
    const quote = (ctx = asVendor(v1, o1)) => withContext(db.app, ctx, (c) => c.query("INSERT INTO quotes (tenant_id, request_id, inquiry_id, vendor_id, total_minor) VALUES ($1, $2, $3, $4, 1000) RETURNING id", [community, request, inquiry, v1]));
    expect(await flag()).toBe(false); // created by the trigger with the (admin-inserted) request
    // a vendor reads the marker only for requests it was asked about
    expect(await withContext(db.app, asVendor(v1, o1), async (c) => (await c.query("SELECT 1 FROM request_stage_flags WHERE request_id = $1", [request])).rowCount)).toBe(1);
    expect(await withContext(db.app, asVendor(v2, o2), async (c) => (await c.query("SELECT 1 FROM request_stage_flags WHERE request_id = $1", [request])).rowCount)).toBe(0);

    // the FAMILY choosing (a request update in their own context) closes it, with no inquiry access needed
    await q("UPDATE requests SET status = 'shortlisted' WHERE id = $1", [request]).catch(() => undefined);
    await withContext(db.app, asResident(), async (c) => {
      await c.query("SELECT set_config('app.note', '', true)");
      await c.query("UPDATE requests SET status = 'cancelled' WHERE id = $1", [request]); // a step the requester may take from asking stages
    });
    expect(await flag()).toBe(true);
    await expect(quote()).rejects.toMatchObject({ code: "42501" }); // the vendor can no longer quote
    // operations capturing a quote on a closed request is their call
    await expect(quote(asOps() as never)).resolves.toBeDefined();
  });

  it("is not writable by vendors or by other families", async () => {
    const request = (await q("INSERT INTO requests (tenant_id, requester_id, request_type_id, schema_version, title, status) VALUES ($1, $2, (SELECT id FROM request_types WHERE key = 'activity'), 1, 'Flag', 'sourcing') RETURNING id", [community, resident])).rows[0].id as string;
    await q("INSERT INTO inquiries (tenant_id, request_id, vendor_id, snapshot) VALUES ($1, $2, $3, '{}')", [community, request, v1]);
    expect((await withContext(db.app, asVendor(v1, o1), (c) => c.query("UPDATE request_stage_flags SET closed = true WHERE request_id = $1", [request]))).rowCount).toBe(0);
    expect((await withContext(db.app, asResident(neighbour), (c) => c.query("UPDATE request_stage_flags SET closed = true WHERE request_id = $1", [request]))).rowCount).toBe(0);
    expect((await q("SELECT closed FROM request_stage_flags WHERE request_id = $1", [request])).rows[0].closed).toBe(false);
  });
});

describe("offline payments", () => {
  it("are recorded by operations only, visible to the people they concern, append-only", async () => {
    const b = await booking(v1, resident, "confirmed");
    const pay = (ctx: Parameters<typeof withContext>[1], kind: string, amount = 5000) =>
      withContext(db.app, ctx, (c) => c.query("INSERT INTO booking_payments (tenant_id, booking_id, kind, amount_minor, method, paid_on, recorded_by) VALUES ($1, $2, $3, $4, 'upi', current_date, $5)", [community, b.booking, kind, amount, ops]));
    await expect(pay(asResident(), "family_to_vendor")).rejects.toMatchObject({ code: "42501" });
    await expect(pay(asVendor(v1, o1), "vendor_to_platform")).rejects.toMatchObject({ code: "42501" });
    await expect(pay(asOps(), "family_to_vendor", 0)).rejects.toThrow(); // a payment is a positive amount
    await pay(asOps(), "family_to_vendor", 60000);
    await pay(asOps(), "vendor_to_platform", 6000);

    const kinds = (ctx: Parameters<typeof withContext>[1]) => withContext(db.app, ctx, async (c) => (await c.query("SELECT kind FROM booking_payments WHERE booking_id = $1 ORDER BY kind", [b.booking])).rows.map((r) => r.kind as string));
    expect(await kinds(asOps())).toEqual(["family_to_vendor", "vendor_to_platform"]);
    expect(await kinds(asVendor(v1, o1))).toEqual(["family_to_vendor", "vendor_to_platform"]); // the vendor sees what the family paid and its own fee
    expect(await kinds(asResident())).toEqual(["family_to_vendor"]); // the family never sees the vendor's fee arrangement
    expect(await kinds(asResident(neighbour))).toEqual([]);
    expect(await kinds(asVendor(v2, o2))).toEqual([]);
    await expect(q("UPDATE booking_payments SET amount_minor = 1")).rejects.toThrow();
    await expect(q("DELETE FROM booking_payments")).rejects.toThrow();
  });

  it("the platform fee is set by operations with payments.record, also after completion, and nothing else about a finished booking moves", async () => {
    const b = await booking(v1, resident, "completed", "completed");
    const set = (ctx: Parameters<typeof withContext>[1], sql = "UPDATE bookings SET platform_fee_minor = 5000 WHERE id = $1") => withContext(db.app, ctx, (c) => c.query(sql, [b.booking]));
    // a vendor cannot set its own fee: not on a finished booking (the row is not theirs to update) and not on one it is still answering
    expect((await set(asVendor(v1, o1))).rowCount).toBe(0);
    const waiting = await booking(v1, resident, "pending_vendor", "booking_pending");
    await expect(withContext(db.app, asVendor(v1, o1), (c) => c.query("UPDATE bookings SET platform_fee_minor = 1 WHERE id = $1", [waiting.booking]))).rejects.toMatchObject({ code: "42501" });
    expect((await set(asResident())).rowCount).toBe(0); // the family: row not updatable
    await expect(set(asOps(["requests.read_all"]))).rejects.toMatchObject({ code: "42501" }); // needs payments.record
    await set(asOps());
    expect((await q("SELECT platform_fee_minor::int AS f FROM bookings WHERE id = $1", [b.booking])).rows[0].f).toBe(5000);
    await set(asOps(), "UPDATE bookings SET platform_fee_minor = 6000 WHERE id = $1");
    // a finished booking is otherwise frozen
    await expect(set(asOps(), "UPDATE bookings SET venue_text = 'moved' WHERE id = $1")).rejects.toMatchObject({ code: "42501" });
    await expect(set(asOps(), "UPDATE bookings SET status = 'cancelled', cancel_reason = 'late' WHERE id = $1")).rejects.toMatchObject({ code: "42501" });
    await expect(q("UPDATE bookings SET platform_fee_minor = -1 WHERE id = $1", [b.booking])).rejects.toThrow(); // never negative
  });
});

describe("reviews", () => {
  const review = (ctx: Parameters<typeof withContext>[1], b: { booking: string }, over: { vendor?: string; rating?: number; requester?: string } = {}) =>
    withContext(db.app, ctx, (c) =>
      c.query("INSERT INTO reviews (tenant_id, booking_id, vendor_id, requester_id, rating, body) VALUES ($1, $2, $3, $4, $5, 'Great fun') RETURNING id", [community, b.booking, over.vendor ?? v1, over.requester ?? (ctx as { userId: string }).userId, over.rating ?? 5]),
    );

  it("can be written only by the requester of a completed booking, once, and start unpublished", async () => {
    const done = await booking(v1, resident, "completed", "completed");
    const open = await booking(v1, resident, "confirmed");
    await expect(review(asResident(), open)).rejects.toMatchObject({ code: "42501" }); // not completed yet
    await expect(review(asResident(neighbour), done)).rejects.toMatchObject({ code: "42501" }); // not their booking
    await expect(review(asResident(neighbour), done, { requester: resident })).rejects.toMatchObject({ code: "42501" }); // not as someone else
    await expect(review(asVendor(v1, o1), done, { requester: o1 })).rejects.toMatchObject({ code: "42501" }); // vendors do not review themselves
    await expect(review(asResident(), done, { vendor: v2 })).rejects.toMatchObject({ code: "42501" }); // not about a different vendor
    await expect(review(asResident(), done, { rating: 6 })).rejects.toThrow();
    await expect(review(asResident(), done, { rating: 0 })).rejects.toThrow();
    await expect(withContext(db.app, asResident(), (c) => c.query("INSERT INTO reviews (tenant_id, booking_id, vendor_id, requester_id, rating, status) VALUES ($1, $2, $3, $4, 5, 'published')", [community, done.booking, v1, resident]))).rejects.toMatchObject({ code: "42501" }); // cannot publish itself
    const id = (await review(asResident(), done)).rows[0].id as string;
    await expect(review(asResident(), done)).rejects.toMatchObject({ code: "23505" }); // one per booking
    expect((await q("SELECT status FROM reviews WHERE id = $1", [id])).rows[0].status).toBe("pending");
  });

  it("is invisible to everyone but its author and operations until published, then readable by those who can see the vendor", async () => {
    const done = await booking(v1, resident, "completed", "completed");
    const id = (await review(asResident(), done)).rows[0].id as string;
    const count = (ctx: Parameters<typeof withContext>[1]) => withContext(db.app, ctx, async (c) => (await c.query("SELECT 1 FROM reviews WHERE id = $1", [id])).rowCount);
    expect([await count(asResident()), await count(asOps()), await count(asResident(neighbour)), await count(asVendor(v1, o1))]).toEqual([1, 1, 0, 0]);
    const decide = (ctx: Parameters<typeof withContext>[1], status: string, note: string | null = null) => withContext(db.app, ctx, (c) => c.query("UPDATE reviews SET status = $2, moderation_note = $3 WHERE id = $1", [id, status, note]));
    await expect(decide(asResident(), "published")).resolves.toMatchObject({ rowCount: 0 }); // the author cannot publish
    await expect(decide(asOps(["requests.read_all"]), "published")).rejects.toMatchObject({ code: "42501" }); // needs reviews.moderate
    await decide(asOps(), "published");
    expect((await q("SELECT status, moderated_by FROM reviews WHERE id = $1", [id])).rows[0]).toEqual({ status: "published", moderated_by: ops });
    expect([await count(asResident(neighbour)), await count(asVendor(v1, o1)), await count(asVendor(v2, o2))]).toEqual([1, 1, 0]); // a different vendor cannot see it
    await expect(decide(asOps(), "pending")).rejects.toMatchObject({ code: "42501" }); // no un-publishing back to pending
    // taking one down needs a reason, and is final
    await expect(decide(asOps(), "rejected")).rejects.toMatchObject({ code: "23514" });
    await decide(asOps(), "rejected", "Mentions a child by name.");
    expect([await count(asResident(neighbour)), await count(asVendor(v1, o1))]).toEqual([0, 0]);
    await expect(decide(asOps(), "published")).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot be rewritten, and lets the vendor answer a published review once", async () => {
    const done = await booking(v1, resident, "completed", "completed");
    const id = (await review(asResident(), done)).rows[0].id as string;
    await withContext(db.app, asOps(), (c) => c.query("UPDATE reviews SET status = 'published' WHERE id = $1", [id]));
    await expect(withContext(db.app, asResident(), (c) => c.query("UPDATE reviews SET rating = 1 WHERE id = $1", [id]))).rejects.toMatchObject({ code: "42501" }); // no column grant
    await expect(q("UPDATE reviews SET rating = 1, body = 'changed' WHERE id = $1", [id])).rejects.toMatchObject({ code: "42501" }); // nor over the admin connection: the trigger
    const reply = (ctx: Parameters<typeof withContext>[1], text = "Thank you!") => withContext(db.app, ctx, (c) => c.query("UPDATE reviews SET vendor_reply = $2 WHERE id = $1", [id, text]));
    expect((await reply(asVendor(v2, o2))).rowCount).toBe(0); // another vendor
    // a vendor team member whose ROLE lacks reviews.reply cannot answer (permissions are role-derived, not whatever a caller claims)
    const staff = await user(`staff-${randomUUID().slice(0, 6)}`);
    await q("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [v1, staff]);
    await q("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'vendor_staff' AND tenant_id IS NULL", [v1, staff]);
    expect((await reply(asVendor(v1, staff))).rowCount).toBe(0);
    await reply(asVendor(v1, o1));
    expect((await q("SELECT vendor_reply, replied_by FROM reviews WHERE id = $1", [id])).rows[0]).toEqual({ vendor_reply: "Thank you!", replied_by: o1 });
    await expect(reply(asVendor(v1, o1), "Second thoughts")).rejects.toMatchObject({ code: "42501" }); // once
    await expect(withContext(db.app, asVendor(v1, o1), (c) => c.query("UPDATE reviews SET status = 'rejected', moderation_note = 'x' WHERE id = $1", [id]))).rejects.toMatchObject({ code: "42501" }); // a vendor cannot take down its own review
    // an unpublished review cannot be answered
    const other = await booking(v1, resident, "completed", "completed");
    const pendingId = (await review(asResident(), other)).rows[0].id as string;
    expect((await withContext(db.app, asVendor(v1, o1), (c) => c.query("UPDATE reviews SET vendor_reply = 'hi' WHERE id = $1", [pendingId]))).rowCount).toBe(0);
  });
});
