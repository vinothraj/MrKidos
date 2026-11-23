import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withContext } from "../src/context";
import { createTestDb, type TestDb } from "../src/testing";

/**
 * Sourcing and booking as the database enforces them: what a vendor can see (never the requester), what a family can
 * see (only what operations offered), and the life of a booking, attacked the way a hostile client would.
 */
const PLATFORM_ORG = "00000000-0000-4000-8000-000000000001";
let db: TestDb;
const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);

let community: string;
let resident: string;
let neighbour: string;
let ops: string;
let v1: string; // vendor organizations
let v2: string;
let o1: string; // owner of v1
let o2: string;
let req: string; // the request, in status 'shortlisted'
let inq1: string;
let inq2: string;
let quote1: string; // shortlisted, v1
let quote2: string; // merely submitted, v2

const OPS_PERMS = ["requests.read_all", "requests.transition", "bookings.confirm", "bookings.complete", "bookings.cancel", "inquiries.send", "quotes.create", "quotes.compare", "matching.run"];
const RES_PERMS = ["requests.create_own", "requests.read_own", "requests.cancel_own", "requests.comment_public", "quotes.accept"];
const asOps = (permissions = OPS_PERMS) => ({ tenantId: community, userId: ops, platformScope: true, permissions });
const asResident = (userId = resident) => ({ tenantId: community, userId, permissions: RES_PERMS });
const asVendor = (vendor: string, userId: string) => ({ tenantId: vendor, userId, permissions: ["inquiries.respond", "quotes.create", "bookings.complete", "vendors.read"] });

async function newUser(name: string): Promise<string> {
  const id = randomUUID();
  await q("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)", [id, `${name}@sourcing.test`, name]);
  return id;
}

beforeAll(async () => {
  db = await createTestDb();
  community = randomUUID();
  [v1, v2] = [randomUUID(), randomUUID()];
  await q("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'community', 'Sourcing Heights', 'active')", [community]);
  await q("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'vendor', 'Vendor One', 'active'), ($2, 'vendor', 'Vendor Two', 'active')", [v1, v2]);
  [resident, neighbour, ops, o1, o2] = await Promise.all(["res", "nei", "ops", "own1", "own2"].map(newUser)) as [string, string, string, string, string];
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
  req = (await q(
    "INSERT INTO requests (tenant_id, requester_id, request_type_id, schema_version, title, status) VALUES ($1, $2, (SELECT id FROM request_types WHERE key = 'activity'), 1, 'Magic show', 'shortlisted') RETURNING id",
    [community, resident],
  )).rows[0].id;
  for (const [vendor, label] of [[v1, "one"], [v2, "two"]] as const) {
    const inquiry = (await q("INSERT INTO inquiries (tenant_id, request_id, vendor_id, snapshot, status) VALUES ($1, $2, $3, $4::jsonb, 'quoted') RETURNING id", [community, req, vendor, JSON.stringify({ title: "Magic show", participantCount: 15 })])).rows[0].id as string;
    const quote = (await q("INSERT INTO quotes (tenant_id, request_id, inquiry_id, vendor_id, status, total_minor) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id", [community, req, inquiry, vendor, label === "one" ? "shortlisted" : "submitted", label === "one" ? 500000 : 400000])).rows[0].id as string;
    await q("INSERT INTO quote_line_items (tenant_id, quote_id, description, quantity, unit_minor) VALUES ($1, $2, 'The show', 1, $3)", [community, quote, label === "one" ? 500000 : 400000]);
    if (label === "one") [inq1, quote1] = [inquiry, quote];
    else [inq2, quote2] = [inquiry, quote];
  }
});
afterAll(async () => {
  await db.close();
});

describe("what a vendor can see", () => {
  it("is its own inquiries, quotes and bookings: never the request, never who asked, never another vendor's", async () => {
    const seen = await withContext(db.app, asVendor(v1, o1), async (c) => ({
      inquiries: (await c.query("SELECT id FROM inquiries")).rows.map((r) => r.id as string),
      quotes: (await c.query("SELECT id FROM quotes")).rows.map((r) => r.id as string),
      lines: (await c.query("SELECT 1 FROM quote_line_items")).rowCount,
      requests: (await c.query("SELECT 1 FROM requests")).rowCount,
      users: (await c.query("SELECT 1 FROM users WHERE id = $1", [resident])).rowCount,
      comments: (await c.query("SELECT 1 FROM request_comments")).rowCount,
      history: (await c.query("SELECT 1 FROM request_status_history")).rowCount,
      matches: (await c.query("SELECT 1 FROM request_matches")).rowCount,
    }));
    expect(seen).toEqual({ inquiries: [inq1], quotes: [quote1], lines: 1, requests: 0, users: 0, comments: 0, history: 0, matches: 0 });
    // what the vendor reads of the inquiry is the snapshot, which names no one
    const snapshot = await withContext(db.app, asVendor(v1, o1), async (c) => (await c.query("SELECT snapshot FROM inquiries")).rows[0].snapshot);
    expect(JSON.stringify(snapshot)).not.toMatch(/res@sourcing|requester/u);
  });

  it("needs the permission as well as the tenant, and a vendor acting in a community sees nothing of the sort", async () => {
    expect(await withContext(db.app, { tenantId: v1, userId: o1, permissions: [] }, async (c) => (await c.query("SELECT 1 FROM inquiries")).rowCount)).toBe(0);
    expect(await withContext(db.app, { tenantId: community, userId: o1, permissions: ["inquiries.respond", "quotes.create"] }, async (c) => (await c.query("SELECT 1 FROM inquiries")).rowCount)).toBe(0);
    expect(await withContext(db.app, { userId: o1 }, async (c) => (await c.query("SELECT 1 FROM inquiries")).rowCount)).toBe(0);
  });

  it("can only answer its own inquiries: decline or quote, never edit what it was asked or reach another vendor's", async () => {
    await expect(withContext(db.app, asVendor(v1, o1), (c) => c.query("INSERT INTO inquiries (tenant_id, request_id, vendor_id, snapshot) VALUES ($1, $2, $3, '{}')", [community, req, v1]))).rejects.toMatchObject({ code: "42501" });
    await expect(withContext(db.app, asVendor(v1, o1), (c) => c.query("UPDATE inquiries SET snapshot = '{\"title\":\"edited\"}'::jsonb"))).rejects.toMatchObject({ code: "42501" }); // no column grant
    // the inquiry is already 'quoted' in this fixture, so it can no longer be answered; another vendor's is invisible
    expect((await withContext(db.app, asVendor(v1, o1), (c) => c.query("UPDATE inquiries SET status = 'declined' WHERE id = $1", [inq1]))).rowCount).toBe(0);
    expect((await withContext(db.app, asVendor(v1, o1), (c) => c.query("UPDATE inquiries SET status = 'declined' WHERE id = $1", [inq2]))).rowCount).toBe(0);
    // a fresh inquiry can be declined by the vendor it was sent to (with its reason), and by no other vendor
    const req3 = (await q("INSERT INTO requests (tenant_id, requester_id, request_type_id, schema_version, title, status) VALUES ($1, $2, (SELECT id FROM request_types WHERE key = 'activity'), 1, 'Decline test', 'vendor_inquiry') RETURNING id", [community, resident])).rows[0].id as string;
    const fresh = (await q("INSERT INTO inquiries (tenant_id, request_id, vendor_id, snapshot) VALUES ($1, $2, $3, '{}') RETURNING id", [community, req3, v1])).rows[0].id as string;
    const decline = (vendor: string, user: string) =>
      withContext(db.app, asVendor(vendor, user), (c) => c.query("UPDATE inquiries SET status = 'declined', decline_reason = 'Fully booked', responded_at = now() WHERE id = $1", [fresh]));
    expect((await decline(v2, o2)).rowCount).toBe(0);
    expect((await decline(v1, o1)).rowCount).toBe(1);
    expect((await q("SELECT status, decline_reason FROM inquiries WHERE id = $1", [fresh])).rows[0]).toEqual({ status: "declined", decline_reason: "Fully booked" });
    // a declined inquiry cannot be re-opened by the vendor
    expect((await withContext(db.app, asVendor(v1, o1), (c) => c.query("UPDATE inquiries SET status = 'sent' WHERE id = $1", [fresh]))).rowCount).toBe(0);
  });

  it("can submit a quote only for an inquiry it was sent, as itself, and can withdraw but never shortlist or accept", async () => {
    const vendor = await newVendor();
    const owner = await newUser(`owner-${randomUUID().slice(0, 6)}`);
    await q("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [vendor, owner]);
    await q("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'vendor_owner' AND tenant_id IS NULL", [vendor, owner]);
    const req2 = (await q("INSERT INTO requests (tenant_id, requester_id, request_type_id, schema_version, title, status) VALUES ($1, $2, (SELECT id FROM request_types WHERE key = 'activity'), 1, 'Second', 'vendor_inquiry') RETURNING id", [community, resident])).rows[0].id as string;
    const mine = (await q("INSERT INTO inquiries (tenant_id, request_id, vendor_id, snapshot) VALUES ($1, $2, $3, '{}') RETURNING id", [community, req2, vendor])).rows[0].id as string;
    const insert = (ctxVendor: string, ctxUser: string, inquiry: string, status = "submitted", vendorId = vendor) =>
      withContext(db.app, asVendor(ctxVendor, ctxUser), (c) =>
        c.query("INSERT INTO quotes (tenant_id, request_id, inquiry_id, vendor_id, status, total_minor) VALUES ($1, $2, $3, $4, $5, 1000) RETURNING id", [community, req2, inquiry, vendorId, status]),
      );
    await expect(insert(vendor, owner, inq1)).rejects.toMatchObject({ code: "42501" }); // someone else's inquiry
    await expect(insert(vendor, owner, mine, "shortlisted")).rejects.toMatchObject({ code: "42501" }); // cannot start shortlisted
    await expect(insert(vendor, owner, mine, "accepted")).rejects.toMatchObject({ code: "42501" });
    await expect(insert(v1, o1, mine, "submitted", v1)).rejects.toMatchObject({ code: "42501" }); // another vendor quoting on this inquiry
    await expect(insert(vendor, owner, mine, "submitted", v1)).rejects.toMatchObject({ code: "42501" }); // naming another vendor on its own quote
    const made = (await insert(vendor, owner, mine)).rows[0].id as string;
    await expect(insert(vendor, owner, mine)).rejects.toMatchObject({ code: "23505" }); // one live quote per inquiry
    const update = (status: string) => withContext(db.app, asVendor(vendor, owner), (c) => c.query("UPDATE quotes SET status = $2 WHERE id = $1", [made, status]));
    await expect(update("shortlisted")).rejects.toMatchObject({ code: "42501" });
    await expect(update("accepted")).rejects.toMatchObject({ code: "42501" });
    await expect(withContext(db.app, asVendor(vendor, owner), (c) => c.query("UPDATE quotes SET total_minor = 1 WHERE id = $1", [made]))).rejects.toMatchObject({ code: "42501" }); // the price cannot be edited
    await update("withdrawn");
    expect((await q("SELECT status FROM quotes WHERE id = $1", [made])).rows[0].status).toBe("withdrawn");
    // after withdrawing, a corrected quote may be made
    await expect(insert(vendor, owner, mine)).resolves.toBeDefined();
  });
});

async function newVendor(): Promise<string> {
  const id = randomUUID();
  await q("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'vendor', $2, 'active')", [id, `Vendor ${id.slice(0, 6)}`]);
  return id;
}

describe("what a family can see and do about quotes", () => {
  it("sees only the quotes operations offered (shortlisted or accepted) for their own request, with their lines", async () => {
    const mine = await withContext(db.app, asResident(), async (c) => ({
      quotes: (await c.query("SELECT id FROM quotes")).rows.map((r) => r.id as string),
      lines: (await c.query("SELECT 1 FROM quote_line_items")).rowCount,
      inquiries: (await c.query("SELECT 1 FROM inquiries")).rowCount,
      matches: (await c.query("SELECT 1 FROM request_matches")).rowCount,
    }));
    expect(mine).toEqual({ quotes: [quote1], lines: 1, inquiries: 0, matches: 0 }); // not the submitted quote of the other vendor
    expect(await withContext(db.app, asResident(neighbour), async (c) => (await c.query("SELECT 1 FROM quotes")).rowCount)).toBe(0);
    expect(await withContext(db.app, asOps(), async (c) => (await c.query("SELECT 1 FROM quotes")).rowCount)).toBeGreaterThanOrEqual(2);
  });

  it("can accept an offered quote on their own request and nothing else about it", async () => {
    const accept = (id: string, ctx = asResident()) => withContext(db.app, ctx, (c) => c.query("UPDATE quotes SET status = 'accepted' WHERE id = $1", [id]));
    expect((await accept(quote2)).rowCount).toBe(0); // not offered to them: invisible
    expect((await accept(quote1, asResident(neighbour))).rowCount).toBe(0); // not their request
    await expect(withContext(db.app, asResident(), (c) => c.query("UPDATE quotes SET status = 'rejected' WHERE id = $1", [quote1]))).rejects.toMatchObject({ code: "42501" });
    await expect(withContext(db.app, asResident(), (c) => c.query("UPDATE quotes SET total_minor = 1 WHERE id = $1", [quote1]))).rejects.toMatchObject({ code: "42501" });
    await accept(quote1);
    expect((await q("SELECT status FROM quotes WHERE id = $1", [quote1])).rows[0].status).toBe("accepted");
    await q("UPDATE quotes SET status = 'shortlisted' WHERE id = $1", [quote1]); // reset for the next tests
  });
});

describe("the request workflow around sourcing", () => {
  it("lets the family accept an offered quote (the step needs quotes.accept) and nobody else take it", async () => {
    const id = (await q("INSERT INTO requests (tenant_id, requester_id, request_type_id, schema_version, title, status) VALUES ($1, $2, (SELECT id FROM request_types WHERE key = 'activity'), 1, 'Flow', 'shortlisted') RETURNING id", [community, resident])).rows[0].id as string;
    const move = (ctx: Parameters<typeof withContext>[1], to: string, note?: string) =>
      withContext(db.app, ctx, async (c) => {
        if (note) await c.query("SELECT set_config('app.note', $1, true)", [note]);
        return c.query("UPDATE requests SET status = $2 WHERE id = $1", [id, to]);
      });
    await expect(move({ ...asResident(), permissions: RES_PERMS.filter((p) => p !== "quotes.accept") }, "booking_pending")).resolves.toBeDefined(); // permission list is ignored for requester steps...
    expect((await q("SELECT status FROM requests WHERE id = $1", [id])).rows[0].status).toBe("booking_pending"); // ...they are table-derived: the resident ROLE holds quotes.accept
    await q("UPDATE requests SET status = 'shortlisted' WHERE id = $1", [id]).catch(() => undefined);
    const id2 = (await q("INSERT INTO requests (tenant_id, requester_id, request_type_id, schema_version, title, status) VALUES ($1, $2, (SELECT id FROM request_types WHERE key = 'activity'), 1, 'Flow 2', 'shortlisted') RETURNING id", [community, resident])).rows[0].id as string;
    expect((await withContext(db.app, asResident(neighbour), (c) => c.query("UPDATE requests SET status = 'booking_pending' WHERE id = $1", [id2]))).rowCount).toBe(0);
    await expect(withContext(db.app, asOps(), (c) => c.query("UPDATE requests SET status = 'booking_pending' WHERE id = $1", [id2]))).rejects.toMatchObject({ code: "42501" }); // operations cannot accept on the family's behalf
    // the step needs the quotes.accept PERMISSION (granted to the resident role), not merely being the requester
    const id4 = (await q("INSERT INTO requests (tenant_id, requester_id, request_type_id, schema_version, title, status) VALUES ($1, $2, (SELECT id FROM request_types WHERE key = 'activity'), 1, 'Flow 4', 'shortlisted') RETURNING id", [community, resident])).rows[0].id as string;
    const residentRole = "(SELECT id FROM roles WHERE key = 'resident' AND tenant_id IS NULL)";
    await q(`DELETE FROM role_permissions WHERE permission_code = 'quotes.accept' AND role_id = ${residentRole}`);
    try {
      await expect(withContext(db.app, asResident(), (c) => c.query("UPDATE requests SET status = 'booking_pending' WHERE id = $1", [id4]))).rejects.toMatchObject({ code: "42501" });
      // other requester steps, which they still hold, are unaffected
      await expect(withContext(db.app, asResident(), (c) => c.query("UPDATE requests SET status = 'cancelled' WHERE id = $1", [id4]))).resolves.toBeDefined();
    } finally {
      await q(`INSERT INTO role_permissions (role_id, permission_code) SELECT ${residentRole}, 'quotes.accept'`);
    }
    // operations drive the sourcing steps, each needing its permission
    const id3 = (await q("INSERT INTO requests (tenant_id, requester_id, request_type_id, schema_version, title, status) VALUES ($1, $2, (SELECT id FROM request_types WHERE key = 'activity'), 1, 'Flow 3', 'approved') RETURNING id", [community, resident])).rows[0].id as string;
    const ops3 = (to: string, perms = OPS_PERMS) => withContext(db.app, asOps(perms), (c) => c.query("UPDATE requests SET status = $2 WHERE id = $1", [id3, to]));
    await expect(ops3("sourcing", ["requests.read_all"])).rejects.toMatchObject({ code: "42501" });
    await ops3("sourcing");
    await expect(ops3("shortlisted")).rejects.toMatchObject({ code: "42501" }); // cannot skip inquiries and quotes
    await ops3("vendor_inquiry");
    await ops3("quotes_received");
    await ops3("shortlisted");
    expect(Math.round(((await q("SELECT sla_due_at FROM requests WHERE id = $1", [id3])).rows[0].sla_due_at.getTime() - Date.now()) / 3_600_000)).toBe(120); // the family's clock
  });
});

describe("a booking's life", () => {
  let booking: string;
  let reqB: string;
  let quoteB: string;

  beforeAll(async () => {
    reqB = (await q("INSERT INTO requests (tenant_id, requester_id, request_type_id, schema_version, title, status) VALUES ($1, $2, (SELECT id FROM request_types WHERE key = 'activity'), 1, 'Booked', 'booking_pending') RETURNING id", [community, resident])).rows[0].id as string;
    const inquiry = (await q("INSERT INTO inquiries (tenant_id, request_id, vendor_id, snapshot, status) VALUES ($1, $2, $3, '{}', 'quoted') RETURNING id", [community, reqB, v1])).rows[0].id as string;
    quoteB = (await q("INSERT INTO quotes (tenant_id, request_id, inquiry_id, vendor_id, status, total_minor) VALUES ($1, $2, $3, $4, 'accepted', 750000) RETURNING id", [community, reqB, inquiry, v1])).rows[0].id as string;
  });

  const create = (ctx: Parameters<typeof withContext>[1], over: { total?: number; vendor?: string; quote?: string } = {}) =>
    withContext(db.app, ctx, (c) =>
      c.query("INSERT INTO bookings (tenant_id, request_id, quote_id, vendor_id, agreed_total_minor, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id", [community, reqB, over.quote ?? quoteB, over.vendor ?? v1, over.total ?? 750000, (ctx as { userId: string }).userId]),
    );

  it("is created by the requester for an accepted quote, at its price and its vendor, and by no one else", async () => {
    await expect(create(asResident(), { total: 1 })).rejects.toMatchObject({ code: "42501" }); // not the agreed price
    await expect(create(asResident(), { vendor: v2 })).rejects.toMatchObject({ code: "42501" }); // not the quoting vendor
    await expect(create(asResident(), { quote: quote1 })).rejects.toMatchObject({ code: "42501" }); // that quote is for another request and not accepted
    await expect(create(asResident(neighbour))).rejects.toMatchObject({ code: "42501" });
    await expect(create(asVendor(v1, o1))).rejects.toMatchObject({ code: "42501" });
    booking = (await create(asResident())).rows[0].id;
    await expect(create(asResident())).rejects.toMatchObject({ code: "23505" }); // one live booking per request
    expect((await q("SELECT status FROM bookings WHERE id = $1", [booking])).rows[0].status).toBe("pending_vendor");
    // who can read it
    const count = (ctx: Parameters<typeof withContext>[1]) => withContext(db.app, ctx, async (c) => (await c.query("SELECT 1 FROM bookings WHERE id = $1", [booking])).rowCount);
    expect([await count(asResident()), await count(asVendor(v1, o1)), await count(asOps()), await count(asResident(neighbour)), await count(asVendor(v2, o2))]).toEqual([1, 1, 1, 0, 0]);
  });

  it("is scheduled by operations only; the vendor can then confirm as itself; confirmation by operations needs the vendor's first", async () => {
    const upd = (ctx: Parameters<typeof withContext>[1], sql: string, params: unknown[] = []) => withContext(db.app, ctx, (c) => c.query(sql, [booking, ...params]));
    await expect(upd(asVendor(v1, o1), "UPDATE bookings SET vendor_confirmed_at = now(), vendor_confirmed_by = $2 WHERE id = $1", [o1])).rejects.toMatchObject({ code: "23514" }); // no date yet
    await expect(upd(asResident(), "UPDATE bookings SET scheduled_start = now() + interval '3 days', scheduled_end = now() + interval '3 days 1 hour' WHERE id = $1")).rejects.toMatchObject({ code: "42501" }); // the family cannot schedule
    await expect(upd(asVendor(v1, o1), "UPDATE bookings SET scheduled_start = now() + interval '3 days' WHERE id = $1")).rejects.toMatchObject({ code: "42501" }); // nor the vendor
    await expect(upd(asOps(), "UPDATE bookings SET status = 'confirmed' WHERE id = $1")).rejects.toThrow(); // vendor has not confirmed
    await upd(asOps(), "UPDATE bookings SET scheduled_start = now() + interval '3 days', scheduled_end = now() + interval '3 days 1 hour', venue_text = 'Clubhouse' WHERE id = $1");
    await expect(upd(asOps(), "UPDATE bookings SET scheduled_start = now() + interval '3 days', scheduled_end = now() WHERE id = $1")).rejects.toMatchObject({ code: "23514" }); // ends before it starts
    await expect(upd(asVendor(v2, o2), "UPDATE bookings SET vendor_confirmed_at = now(), vendor_confirmed_by = $2 WHERE id = $1", [o2])).resolves.toMatchObject({ rowCount: 0 }); // another vendor: invisible
    await expect(upd(asVendor(v1, o1), "UPDATE bookings SET vendor_confirmed_at = now(), vendor_confirmed_by = $2 WHERE id = $1", [o2])).rejects.toMatchObject({ code: "42501" }); // cannot confirm "as" someone else
    await upd(asVendor(v1, o1), "UPDATE bookings SET vendor_confirmed_at = now(), vendor_confirmed_by = $2 WHERE id = $1", [o1]);
    await expect(upd(asVendor(v1, o1), "UPDATE bookings SET status = 'confirmed' WHERE id = $1")).rejects.toMatchObject({ code: "42501" }); // the vendor cannot confirm for operations
    await expect(upd(asOps(["requests.read_all"]), "UPDATE bookings SET status = 'confirmed' WHERE id = $1")).rejects.toMatchObject({ code: "42501" }); // operations need bookings.confirm
    await upd(asOps(), "UPDATE bookings SET status = 'confirmed' WHERE id = $1");
    const row = (await q("SELECT status, confirmed_by, confirmed_at FROM bookings WHERE id = $1", [booking])).rows[0];
    expect(row).toMatchObject({ status: "confirmed", confirmed_by: ops });
    expect(row.confirmed_at).toBeTruthy();
  });

  it("can be completed only from confirmed and only by operations, cancelled only with a reason, and then never changes; the price and parties are fixed", async () => {
    const upd = (ctx: Parameters<typeof withContext>[1], sql: string, params: unknown[] = []) => withContext(db.app, ctx, (c) => c.query(sql, [booking, ...params]));
    await expect(upd(asOps(), "UPDATE bookings SET agreed_total_minor = 1 WHERE id = $1")).rejects.toMatchObject({ code: "42501" });
    // the trigger is the second wall: even the admin connection (which skips column grants and row security) cannot move the price or the parties
    await expect(q("UPDATE bookings SET agreed_total_minor = 1 WHERE id = $1", [booking])).rejects.toMatchObject({ code: "42501" });
    await expect(q("UPDATE bookings SET vendor_id = $2 WHERE id = $1", [booking, v2])).rejects.toMatchObject({ code: "42501" });
    await expect(upd(asOps(), "UPDATE bookings SET vendor_id = $2 WHERE id = $1", [v2])).rejects.toMatchObject({ code: "42501" });
    await expect(upd(asResident(), "UPDATE bookings SET status = 'cancelled', cancel_reason = 'changed my mind' WHERE id = $1")).resolves.toMatchObject({ rowCount: 0 }); // confirmed: the family can no longer cancel it themselves
    await expect(upd(asVendor(v1, o1), "UPDATE bookings SET status = 'cancelled', cancel_reason = 'sorry' WHERE id = $1")).resolves.toMatchObject({ rowCount: 0 });
    await expect(upd(asOps(["requests.read_all", "bookings.complete"]), "UPDATE bookings SET status = 'cancelled', cancel_reason = 'x' WHERE id = $1")).rejects.toMatchObject({ code: "42501" }); // needs bookings.cancel
    await expect(upd(asOps(), "UPDATE bookings SET status = 'cancelled' WHERE id = $1")).rejects.toMatchObject({ code: "23514" }); // needs a reason
    await expect(upd(asOps(), "UPDATE bookings SET status = 'pending_vendor' WHERE id = $1")).rejects.toMatchObject({ code: "42501" }); // cannot go back
    await upd(asOps(), "UPDATE bookings SET status = 'completed' WHERE id = $1");
    expect((await q("SELECT completed_at FROM bookings WHERE id = $1", [booking])).rows[0].completed_at).toBeTruthy();
    await expect(upd(asOps(), "UPDATE bookings SET status = 'cancelled', cancel_reason = 'late' WHERE id = $1")).rejects.toMatchObject({ code: "42501" }); // finished is final
    await expect(upd(asOps(), "UPDATE bookings SET venue_text = 'elsewhere' WHERE id = $1")).rejects.toMatchObject({ code: "42501" });
  });

  it("lets a vendor decline a booking it has not confirmed, and the family cancel one still waiting for the vendor", async () => {
    const make = async (label: string) => {
      const r = (await q("INSERT INTO requests (tenant_id, requester_id, request_type_id, schema_version, title, status) VALUES ($1, $2, (SELECT id FROM request_types WHERE key = 'activity'), 1, $3, 'booking_pending') RETURNING id", [community, resident, label])).rows[0].id as string;
      const i = (await q("INSERT INTO inquiries (tenant_id, request_id, vendor_id, snapshot, status) VALUES ($1, $2, $3, '{}', 'quoted') RETURNING id", [community, r, v1])).rows[0].id as string;
      const qt = (await q("INSERT INTO quotes (tenant_id, request_id, inquiry_id, vendor_id, status, total_minor) VALUES ($1, $2, $3, $4, 'accepted', 100) RETURNING id", [community, r, i, v1])).rows[0].id as string;
      return (await q("INSERT INTO bookings (tenant_id, request_id, quote_id, vendor_id, agreed_total_minor) VALUES ($1, $2, $3, $4, 100) RETURNING id", [community, r, qt, v1])).rows[0].id as string;
    };
    const declined = await make("Decline me");
    await expect(withContext(db.app, asVendor(v1, o1), (c) => c.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [declined]))).rejects.toMatchObject({ code: "23514" }); // reason required
    await withContext(db.app, asVendor(v1, o1), (c) => c.query("UPDATE bookings SET status = 'cancelled', cancel_reason = 'Fully booked that day' WHERE id = $1", [declined]));
    expect((await q("SELECT status, cancel_reason FROM bookings WHERE id = $1", [declined])).rows[0]).toEqual({ status: "cancelled", cancel_reason: "Fully booked that day" });
    const cancelled = await make("Cancel me");
    expect((await withContext(db.app, asResident(neighbour), (c) => c.query("UPDATE bookings SET status = 'cancelled', cancel_reason = 'x' WHERE id = $1", [cancelled]))).rowCount).toBe(0);
    await withContext(db.app, asResident(), (c) => c.query("UPDATE bookings SET status = 'cancelled', cancel_reason = 'Plans changed' WHERE id = $1", [cancelled]));
    expect((await q("SELECT status FROM bookings WHERE id = $1", [cancelled])).rows[0].status).toBe("cancelled");
  });
});

describe("matches", () => {
  it("are operations-only", async () => {
    await expect(withContext(db.app, asResident(), (c) => c.query("INSERT INTO request_matches (tenant_id, request_id, vendor_id, score, source) VALUES ($1, $2, $3, 50, 'auto')", [community, req, v1]))).rejects.toMatchObject({ code: "42501" });
    await withContext(db.app, asOps(), (c) => c.query("INSERT INTO request_matches (tenant_id, request_id, vendor_id, score, source) VALUES ($1, $2, $3, 80, 'auto')", [community, req, v1]));
    await expect(withContext(db.app, asOps(), (c) => c.query("INSERT INTO request_matches (tenant_id, request_id, vendor_id, score, source) VALUES ($1, $2, $3, 80, 'manual')", [community, req, v2]))).rejects.toMatchObject({ code: "23514" }); // a manual addition needs its reason
    expect(await withContext(db.app, asVendor(v1, o1), async (c) => (await c.query("SELECT 1 FROM request_matches")).rowCount)).toBe(0);
    expect(await withContext(db.app, asResident(), async (c) => (await c.query("SELECT 1 FROM request_matches")).rowCount)).toBe(0);
  });
});
