/**
 * Creates demo requests for the resident and moves each one to a different stage by calling the real API as the real
 * people (resident, operations, vendor), so every screen of the request-to-booking journey has something to look at.
 * Development only: tools/stack.ts runs it once in dev mode (it does nothing if the resident already has requests).
 */
import type { Pool } from "pg";
import type { buildApp } from "../apps/api/src/app";
import { DEV_COMMUNITY_NAME, DEV_VENDOR_NAME } from "../apps/api/src/dev-accounts";

type Json = Record<string, unknown>;
interface Who {
  cookie: string;
  headers: Record<string, string>;
}

type App = Awaited<ReturnType<typeof buildApp>>;
const ORIGIN = process.env["APP_BASE_URL"] ?? "http://localhost:3000";
const inDays = (n: number): Date => new Date(Date.now() + n * 86_400_000);
const dateOnly = (d: Date): string => d.toISOString().slice(0, 10);

async function signIn(app: App, email: string, tenantId: string | null, platform = false): Promise<Who> {
  const res = await app.inject({ method: "POST", url: "/api/v1/dev/login", headers: { origin: ORIGIN }, payload: { email } });
  const cookie = res.cookies.find((c) => c.name === "kidos_sid")?.value;
  if (res.statusCode !== 200 || !cookie) throw new Error(`demo sign-in failed for ${email}: ${res.statusCode} ${res.body}`);
  return { cookie, headers: { origin: ORIGIN, cookie: `kidos_sid=${cookie}`, ...(tenantId ? { "x-tenant-id": tenantId } : {}), ...(platform ? { "x-platform-scope": "on" } : {}) } };
}

export async function seedDemoFlows(app: App, admin: Pool): Promise<void> {
  const org = async (type: string, name: string): Promise<string> => {
    const r = await admin.query<{ id: string }>("SELECT id FROM organizations WHERE type = $1 AND name = $2", [type, name]);
    const id = r.rows[0]?.id;
    if (!id) throw new Error(`demo organization missing: ${name}`);
    return id;
  };
  const community = await org("community", DEV_COMMUNITY_NAME);
  const vendor = await org("vendor", DEV_VENDOR_NAME);
  const resident = await admin.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = 'resident@dev.kidos.test'");
  const residentId = resident.rows[0]?.id;
  if (!residentId) return;
  const existing = await admin.query("SELECT 1 FROM requests WHERE requester_id = $1", [residentId]);
  if (existing.rowCount) return;

  const family = await signIn(app, "resident@dev.kidos.test", community);
  const ops = await signIn(app, "super-admin@dev.kidos.test", null, true);
  const vendorOwner = await signIn(app, "vendor-owner@dev.kidos.test", vendor);

  const call = async (who: Who, method: "GET" | "POST" | "PUT", url: string, payload?: Json): Promise<Json> => {
    const res = await app.inject({ method, url: `/api/v1${url}`, headers: who.headers, ...(payload ? { payload } : {}) });
    if (res.statusCode >= 300) throw new Error(`demo step failed: ${method} ${url} -> ${res.statusCode} ${res.body}`);
    return res.body ? (JSON.parse(res.body) as Json) : {};
  };
  const to = (id: string, status: string, note?: string) => call(ops, "POST", `/requests/${id}/transitions`, { to: status, ...(note ? { note } : {}) });

  const types = (await call(family, "GET", "/request-types")) as { data: { id: string; key: string }[] };
  const typeId = (key: string): string => {
    const t = types.data.find((x) => x.key === key);
    if (!t) throw new Error(`request type missing: ${key}`);
    return t.id;
  };
  const offerings = await admin.query<{ id: string; name: string; category_id: string }>("SELECT id, name, category_id FROM offerings WHERE tenant_id = $1", [vendor]);
  const offering = (name: string) => {
    const o = offerings.rows.find((x) => x.name === name);
    if (!o) throw new Error(`demo offering missing: ${name}`);
    return o;
  };

  async function newRequest(body: Json): Promise<string> {
    const res = (await call(family, "POST", "/requests", body)) as { id?: string };
    if (!res.id) throw new Error("demo request has no id");
    return res.id;
  }

  /** The operations team approves and finds vendors; the vendor answers; the team offers the quote to the family. */
  async function sourceAndQuote(id: string, offeringName: string, lines: Json[]): Promise<void> {
    await to(id, "under_review");
    await to(id, "approved");
    await to(id, "sourcing");
    await call(ops, "POST", `/requests/${id}/matching/run`);
    await call(ops, "POST", `/requests/${id}/inquiries`, { vendorIds: [vendor], message: `Please send a quote for ${offeringName}.` });
    const inbox = (await call(vendorOwner, "GET", "/inquiries")) as { data: { id: string; title: string }[] };
    const sent = (await call(ops, "GET", `/requests/${id}/sourcing`)) as { inquiries: { id: string }[] };
    const inquiryId = sent.inquiries[0]?.id ?? inbox.data[0]?.id;
    if (!inquiryId) throw new Error("demo inquiry missing");
    await call(vendorOwner, "POST", `/inquiries/${inquiryId}/quote`, { lines, validUntil: dateOnly(inDays(14)), notes: "Happy to adjust the timing to suit your families." });
    await to(id, "quotes_received");
  }
  async function offerToFamily(id: string): Promise<string> {
    const s = (await call(ops, "GET", `/requests/${id}/sourcing`)) as { quotes: { id: string }[] };
    const quoteId = s.quotes[0]?.id;
    if (!quoteId) throw new Error("demo quote missing");
    await call(ops, "PUT", `/quotes/${quoteId}/shortlist`, { shortlisted: true });
    await to(id, "shortlisted");
    return quoteId;
  }
  async function bookAndConfirm(id: string, quoteId: string, venue: string): Promise<string> {
    await call(family, "POST", `/requests/${id}/quotes/${quoteId}/accept`);
    const s = (await call(ops, "GET", `/requests/${id}/sourcing`)) as { booking: { id: string } | null };
    const bookingId = s.booking?.id;
    if (!bookingId) throw new Error("demo booking missing");
    const start = inDays(21);
    start.setUTCHours(4, 30, 0, 0); // 10:00 India time
    const end = new Date(start.getTime() + 60 * 60_000);
    await call(ops, "POST", `/bookings/${bookingId}/schedule`, { start: start.toISOString(), end: end.toISOString(), venueText: venue });
    await call(vendorOwner, "POST", `/bookings/${bookingId}/vendor-confirm`);
    await to(id, "confirmed");
    return bookingId;
  }

  const science = offering("Kitchen Science Show");
  const robotics = offering("Junior Robotics Workshop");
  const stars = offering("Stargazing Evening");

  // 1. A confirmed booking: the whole journey done.
  const r1 = await newRequest({
    requestTypeId: typeId("celebration"),
    title: "Science show for Aarav's 8th birthday",
    description: "About 20 children aged 6 to 9. We would love something hands-on and not too noisy.",
    categoryId: science.category_id,
    offeringId: science.id,
    preferredDate: dateOnly(inDays(21)),
    participantCount: 20,
    ageMin: 6,
    ageMax: 9,
    budgetMaxMinor: 800_000,
    venueText: "Clubhouse, Block C",
    answers: { occasion: "birthday", guest_count: 20, venue_type: "community_facility" },
  });
  await sourceAndQuote(r1, science.name, [
    { kind: "service", description: "Kitchen Science Show, 60 minutes", quantity: 1, unitMinor: 600_000 },
    { kind: "travel", description: "Travel to Whitefield", quantity: 1, unitMinor: 50_000 },
  ]);
  await bookAndConfirm(r1, await offerToFamily(r1), "Clubhouse, Block C");

  // 2. Quotes are in and offered: the family now chooses (the resident's "choose an option" screen).
  const r2 = await newRequest({
    requestTypeId: typeId("activity"),
    title: "Robotics classes for my daughter",
    description: "She is 10 and loves building things. One Saturday workshop for her friends would be perfect.",
    categoryId: robotics.category_id,
    offeringId: robotics.id,
    preferredDate: dateOnly(inDays(28)),
    participantCount: 10,
    ageMin: 9,
    ageMax: 11,
    budgetMaxMinor: 700_000,
    venueText: "Our community hall",
    answers: { format: "one_time", setting: "indoor" },
  });
  await sourceAndQuote(r2, robotics.name, [
    { kind: "service", description: "Junior Robotics Workshop, per child (10 children)", quantity: 10, unitMinor: 45_000 },
    { kind: "equipment", description: "Robot kits and laptops", quantity: 1, unitMinor: 40_000 },
  ]);
  await offerToFamily(r2);

  // 3. Waiting for the vendor's quote (the vendor's "inquiries" inbox has something to answer).
  const r3 = await newRequest({
    requestTypeId: typeId("activity"),
    title: "Stargazing evening for the building",
    description: "A calm evening on our terrace for children and parents.",
    categoryId: stars.category_id,
    offeringId: stars.id,
    preferredDate: dateOnly(inDays(35)),
    participantCount: 30,
    ageMin: 6,
    ageMax: 14,
    venueText: "Terrace, Block A",
    answers: { format: "one_time", setting: "outdoor" },
  });
  await to(r3, "under_review");
  await to(r3, "approved");
  await to(r3, "sourcing");
  await call(ops, "POST", `/requests/${r3}/matching/run`);
  await call(ops, "POST", `/requests/${r3}/inquiries`, { vendorIds: [vendor], message: "Could you do a stargazing evening for about 30 people?" });

  // 4. The team needs more information from the family.
  const r4 = await newRequest({
    requestTypeId: typeId("activity"),
    title: "Something creative for the rainy weekend",
    description: "My two children are bored indoors. Any ideas?",
    answers: { format: "one_time", setting: "indoor" },
  });
  await to(r4, "under_review");
  await to(r4, "information_required", "How old are the children, and roughly how many will join? That helps us suggest the right activity.");

  // 5. Just submitted: the operations team has not looked at it yet.
  await newRequest({
    requestTypeId: typeId("activity"),
    title: "Weekly chess club for beginners",
    description: "Hoping to start a small after-school club for 8 to 10 year olds.",
    answers: { format: "recurring", setting: "indoor" },
  });
}
