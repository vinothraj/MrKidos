import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, makeMember, makeStaff, PLATFORM_SCOPE, register, type TestApp } from "./helpers";

let t: TestApp;
let ops: { cookie: string; userId: string }; // business_operations: holds concerns.manage
let boss: { cookie: string; userId: string }; // platform_admin
let marketing: { cookie: string; userId: string }; // platform staff without concerns.manage
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

/** A vendor this community shows (active, serves it, approved by it), with an owner. */
async function visibleVendor(name: string, communityId: string, approved = true) {
  const id = randomUUID();
  const q = (sql: string, p: unknown[]) => t.db.admin.query(sql, p);
  await q("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'vendor', $2, 'active')", [id, name]);
  await q("INSERT INTO vendor_profiles (tenant_id, description, city) VALUES ($1, 'Coaching', 'Bengaluru')", [id]);
  await q("INSERT INTO vendor_service_areas (tenant_id, community_id) VALUES ($1, $2)", [id, communityId]);
  await q("INSERT INTO vendor_vetting_summary (tenant_id, complete) VALUES ($1, true)", [id]);
  if (approved) await q("INSERT INTO community_vendor_approvals (tenant_id, vendor_id, status) VALUES ($1, $2, 'approved')", [communityId, id]);
  const owner = await makeMember(t, email("vown"), id, ["vendor_owner"], { mfa: true });
  return { id, name, owner };
}

const REPORT = { category: "child_safety", subject: "Coach was alone with a child", details: "On Saturday at the club hall, the coach took one child into a side room and closed the door." };

beforeAll(async () => {
  t = await createTestApp();
  ops = await makeStaff(t, "concern-ops@example.test", "business_operations");
  boss = await makeStaff(t, "concern-boss@example.test", "platform_admin");
  marketing = await makeStaff(t, "concern-marketing@example.test", "marketing");
});
afterAll(async () => {
  await t.close();
});

describe("reporting a concern", () => {
  it("accepts a report, tells the desk without saying what it is about, and shows the reporter its progress", async () => {
    const home = await activeCommunity("Concern Home");
    const vendor = await visibleVendor("Named Vendor", home.id);
    const mark = t.mailer.sent.length;
    const res = await post(as(home.resident, home.id), `${api}/concerns`, { ...REPORT, vendorId: vendor.id });
    expect(res.statusCode, res.body).toBe(201);

    // the desk is told that something was reported, and nothing else
    const alert = t.mailer.sent.slice(mark).find((m) => m.to === "ops-desk@example.test");
    expect(alert?.subject).toContain("A safety concern was reported");
    const everything = JSON.stringify(t.mailer.sent.slice(mark));
    for (const secret of ["Coach was alone", "side room", "Named Vendor", "closed the door", home.resident.email, "Concern Home"]) expect(everything).not.toContain(secret);
    // the same holds for a report that is not about safety
    const mark2 = t.mailer.sent.length;
    expect((await post(as(home.resident, home.id), `${api}/concerns`, { category: "conduct", subject: "Rude about parking", details: "Shouted at the gate on Sunday.", vendorId: vendor.id })).statusCode).toBe(201);
    const second = t.mailer.sent.slice(mark2).find((m) => m.to === "ops-desk@example.test");
    expect(second?.subject).toContain("A concern was reported");
    expect(JSON.stringify(t.mailer.sent.slice(mark2))).not.toMatch(/Rude about parking|Shouted at the gate|Named Vendor|Concern Home/u);
    // the audit trail names the category, never the words
    const audit = (await t.db.admin.query("SELECT string_agg(metadata::text, ' ') AS m FROM audit_log WHERE action = 'concern.reported' AND tenant_id = $1", [home.id])).rows[0].m as string;
    expect(audit).toContain("child_safety");
    expect(audit).toContain("conduct");
    expect(audit).not.toMatch(/side room|Coach was alone|Rude about parking|Shouted at the gate/u);

    // the reporter sees it, with the vendor's name, as received
    const mine = (await as(home.resident, home.id)(`${api}/concerns/mine`)).json().data;
    expect(mine).toEqual(expect.arrayContaining([expect.objectContaining({ subject: REPORT.subject, status: "open", resolution: null, vendor: { id: vendor.id, name: "Named Vendor" } })]));
    // nobody else can see it: a neighbour, the community administrator, the vendor it names
    for (const who of [home.neighbour, home.admin]) expect((await as(who, home.id)(`${api}/concerns/mine`)).json().data).toEqual([]);
    expect((await as(vendor.owner, vendor.id)(`${api}/concerns/mine`)).json().data).toEqual([]);
    for (const [who, org] of [[home.neighbour, home.id], [home.admin, home.id], [vendor.owner, vendor.id]] as const) {
      expect((await as(who, org)(`${api}/concerns`)).statusCode).toBe(403);
    }
  });

  it("checks what it is given, and does not let a vendor id be probed", async () => {
    const home = await activeCommunity("Concern Checks");
    const hidden = await visibleVendor("Hidden Vendor", home.id, false);
    const send = (body: unknown) => post(as(home.resident, home.id), `${api}/concerns`, body);
    expect((await send({})).statusCode).toBe(400);
    expect((await send({ ...REPORT, category: "gossip" })).statusCode).toBe(400);
    expect((await send({ ...REPORT, subject: "   " })).statusCode).toBe(400);
    expect((await send({ ...REPORT, details: "x".repeat(3001) })).statusCode).toBe(400);
    expect((await send({ ...REPORT, status: "resolved" })).statusCode).toBe(400); // no extra fields
    expect((await send({ ...REPORT, vendorId: "not-a-uuid" })).statusCode).toBe(400);
    // a vendor this community does not show, and one that does not exist, get the same answer
    const unseen = await send({ ...REPORT, vendorId: hidden.id });
    const unknown = await send({ ...REPORT, vendorId: randomUUID() });
    expect(unseen.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(unseen.json().error.code).toBe(unknown.json().error.code);
    // a report about nobody in particular is fine
    expect((await send({ category: "other", subject: "Noise", details: "Loud music at night." })).statusCode).toBe(201);
  });

  it("is open to signed-in members only, with the right origin, and not in platform scope", async () => {
    const home = await activeCommunity("Concern Access");
    expect((await call(t.app, { method: "POST", url: `${api}/concerns`, body: REPORT })).statusCode).toBe(401);
    expect((await as(home.resident, home.id)(`${api}/concerns`, { method: "POST", body: REPORT, origin: "https://evil.example" })).statusCode).toBe(403);
    // someone acting in a community they have no role in
    const stranger = await register(t.app, email("stranger"));
    expect((await as(stranger, home.id)(`${api}/concerns`, { method: "POST", body: REPORT })).statusCode).toBe(403);
    // the platform team decides; it does not report as the platform
    expect((await post(asOps, `${api}/concerns`, REPORT)).statusCode).toBe(403);
    expect((await asOps(`${api}/concerns/mine`)).statusCode).toBe(403);
    // even a super administrator, who holds every permission including this one, does not report as the platform
    const root = await makeStaff(t, "concern-root@example.test", "super_admin");
    const asRoot: Caller = (url, extra = {}) => call(t.app, { url, cookie: root.cookie, headers: PLATFORM_SCOPE, ...extra });
    expect((await post(asRoot, `${api}/concerns`, REPORT)).statusCode).toBe(403);
    expect((await asRoot(`${api}/concerns/mine`)).statusCode).toBe(403);
    // a vendor's own person may report
    const vendor = await visibleVendor("Reporting Vendor", home.id);
    expect((await post(as(vendor.owner, vendor.id), `${api}/concerns`, { category: "conduct", subject: "A parent shouted", details: "At the end of the class." })).statusCode).toBe(201);
  });

  it("stops one person flooding the desk with undecided reports, with a clear message", async () => {
    const home = await activeCommunity("Concern Flood");
    await t.db.admin.query(
      "INSERT INTO concerns (tenant_id, reporter_id, category, subject, details) SELECT $1, $2, 'other', 's', 'd' FROM generate_series(1, 10)",
      [home.id, home.neighbour.userId],
    );
    const over = await post(as(home.neighbour, home.id), `${api}/concerns`, REPORT);
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe("too_many_open");
    expect((await post(as(home.resident, home.id), `${api}/concerns`, REPORT)).statusCode).toBe(201); // someone else is unaffected
  });
});

describe("the team's queue and decisions", () => {
  it("lists child-safety reports first with who sent them, and only to staff who may manage concerns", async () => {
    const home = await activeCommunity("Concern Queue");
    const send = (body: unknown) => post(as(home.resident, home.id), `${api}/concerns`, body);
    await send({ category: "payment", subject: "Overcharged", details: "Asked for more cash on the day." });
    await send(REPORT);
    const list = (await asOps(`${api}/concerns?view=active`)).json().data as { subject: string; category: string; reportedBy: { name: string; email: string }; organization: string }[];
    const mine = list.filter((c) => c.organization === "Concern Queue");
    expect(mine.map((c) => c.category)).toEqual(["child_safety", "payment"]); // safety first, then the oldest
    expect(mine[0]?.reportedBy.email).toBe(home.resident.email);
    expect(mine[0]).toMatchObject({ subject: REPORT.subject, details: REPORT.details });
    // staff without the permission, and families, cannot read the queue
    expect((await call(t.app, { url: `${api}/concerns`, cookie: marketing.cookie, headers: PLATFORM_SCOPE })).statusCode).toBe(403);
    expect((await as(home.resident, home.id)(`${api}/concerns`)).statusCode).toBe(403);
    expect((await call(t.app, { url: `${api}/concerns` })).statusCode).toBe(401);
    expect((await asOps(`${api}/concerns?view=everything`)).statusCode).toBe(400);
    // a platform administrator (who holds concerns.manage) can read it as well
    expect((await asBoss(`${api}/concerns`)).statusCode).toBe(200);
  });

  it("walks a report to a decision the reporter can read, and tells them without repeating it", async () => {
    const home = await activeCommunity("Concern Decide");
    const id = (await post(as(home.resident, home.id), `${api}/concerns`, REPORT)).json().id as string;
    const status = (body: unknown, who: Caller = asOps) => put(who, `${api}/concerns/${id}/status`, body);

    // rules of the road
    expect((await status({ status: "resolved" })).json().error.code).toBe("resolution_required");
    expect((await status({ status: "resolved", resolution: "   " })).json().error.code).toBe("resolution_required");
    expect((await status({ status: "reviewing", resolution: "early" })).json().error.code).toBe("resolution_not_allowed");
    expect((await status({ status: "open" })).statusCode).toBe(400);
    expect((await put(asOps, `${api}/concerns/${randomUUID()}/status`, { status: "reviewing" })).statusCode).toBe(404);
    // a family, a neighbour and staff without the permission cannot decide
    for (const who of [as(home.resident, home.id), as(home.admin, home.id)]) expect((await status({ status: "resolved", resolution: "Fine." }, who)).statusCode).toBe(403);
    expect((await put((url, extra) => call(t.app, { url, cookie: marketing.cookie, headers: PLATFORM_SCOPE, ...extra }), `${api}/concerns/${id}/status`, { status: "resolved", resolution: "Fine." })).statusCode).toBe(403);
    expect((await as(home.resident, home.id)(`${api}/concerns/mine`)).json().data[0]).toMatchObject({ status: "open", resolution: null });

    // take it on, then decide
    expect((await status({ status: "reviewing" })).json()).toMatchObject({ status: "reviewing" });
    expect((await as(home.resident, home.id)(`${api}/concerns/mine`)).json().data[0]).toMatchObject({ status: "reviewing" });
    const mark = t.mailer.sent.length;
    const outcome = "We have removed the vendor from the platform while we investigate.";
    expect((await status({ status: "resolved", resolution: outcome })).json()).toMatchObject({ status: "resolved", resolution: outcome });
    expect((await as(home.resident, home.id)(`${api}/concerns/mine`)).json().data[0]).toMatchObject({ status: "resolved", resolution: outcome });
    // the reporter is emailed that there is an update, and the email does not carry the outcome or the report
    const note = t.mailer.sent.slice(mark).find((m) => m.to === home.resident.email);
    expect(note?.subject).toContain("An update on your report");
    expect(JSON.stringify(t.mailer.sent.slice(mark))).not.toMatch(/removed the vendor|side room|Coach was alone/u);
    // a decided report stays decided
    expect((await status({ status: "reviewing" })).json().error.code).toBe("invalid_state");
    expect((await status({ status: "dismissed", resolution: "Changed my mind." })).json().error.code).toBe("invalid_state");
    // and the neighbour never learns of any of it
    expect((await as(home.neighbour, home.id)(`${api}/concerns/mine`)).json().data).toEqual([]);
  });

  it("can be closed without action, filtered by outcome, and is counted for the desk as it waits", async () => {
    const home = await activeCommunity("Concern Close");
    const send = async (body: unknown) => (await post(as(home.resident, home.id), `${api}/concerns`, body)).json().id as string;
    const safety = await send(REPORT);
    const other = await send({ category: "other", subject: "Parking", details: "Cars blocking the entrance." });
    const waiting = async () => (await asOps(`${api}/me/attention`)).json().items as { key: string; label: string; count: number; href: string }[];
    const before = await waiting();
    expect(before.find((i) => i.key === "safety_concerns")?.label).toMatch(/child-safety report/u);
    expect(before.find((i) => i.key === "safety_concerns")?.href).toBe("/app/concerns");
    expect((await put(asOps, `${api}/concerns/${other}/status`, { status: "dismissed", resolution: "This is a matter for the community office." })).json().status).toBe("dismissed");
    expect((await asOps(`${api}/concerns?view=dismissed`)).json().data.map((c: { id: string }) => c.id)).toContain(other);
    expect((await asOps(`${api}/concerns?view=active`)).json().data.map((c: { id: string }) => c.id)).not.toContain(other);
    expect((await asOps(`${api}/concerns?view=all`)).json().data.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining([safety, other]));
    // resolved ones stop being counted as waiting
    const countOf = async () => (await waiting()).find((i) => i.key === "safety_concerns")?.count ?? 0;
    const open = await countOf();
    await put(asOps, `${api}/concerns/${safety}/status`, { status: "resolved", resolution: "Handled." });
    expect(await countOf()).toBe(open - 1);
    // a family is never told about the team's queue
    expect(((await as(home.resident, home.id)(`${api}/me/attention`)).json().items as { key: string }[]).some((i) => i.key.includes("concern"))).toBe(false);
  });
});
