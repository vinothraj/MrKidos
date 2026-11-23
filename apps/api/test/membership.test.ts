import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, makeMember, makeStaff, markEmailVerified, PLATFORM_SCOPE, register, type TestApp } from "./helpers";

let t: TestApp;
let ops: { cookie: string; userId: string };
let seq = 0;
const email = (p: string) => `${p}${++seq}@example.test`;
const CODE_SHAPE = /^[A-Z2-7]{5}-[A-Z2-7]{5}$/u;

/** An ACTIVE community with a profile, set up directly in the database (the onboarding workflow has its own tests). */
async function activeCommunity(name: string, joinMode?: "admin_approval" | "invite_code_only"): Promise<string> {
  const id = randomUUID();
  await t.db.admin.query("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'community', $2, 'active')", [id, name]);
  await t.db.admin.query("INSERT INTO community_profiles (tenant_id, city, locality) VALUES ($1, 'Pune', 'Baner')", [id]);
  if (joinMode) await t.db.admin.query("INSERT INTO community_policies (tenant_id, key, value) VALUES ($1, 'resident_join_mode', $2::jsonb)", [id, JSON.stringify(joinMode)]);
  return id;
}

async function verifiedResident(prefix: string) {
  const e = email(prefix);
  const u = await register(t.app, e, `Resident ${prefix}`);
  await markEmailVerified(t.db, u.userId);
  return { ...u, email: e };
}

const adminCtx = (admin: { cookie: string }, communityId: string) => ({ cookie: admin.cookie, headers: { "x-tenant-id": communityId } });

async function newCode(admin: { cookie: string }, communityId: string, body: Record<string, unknown> = {}): Promise<{ id: string; code: string }> {
  const res = await call(t.app, { method: "POST", url: `/api/v1/communities/${communityId}/invite-codes`, body: { label: "Block A", maxUses: 10, ...body }, ...adminCtx(admin, communityId) });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

const join = (cookie: string, code: string, extra: Record<string, unknown> = {}) =>
  call(t.app, { method: "POST", url: "/api/v1/communities/join", cookie, body: { code, ...extra } });

beforeAll(async () => {
  t = await createTestApp();
  ops = await makeStaff(t, "ops-m@example.test", "business_operations");
});
afterAll(async () => {
  await t.close();
});

describe("invite codes (administrators)", () => {
  it("creates a code shown once, stores only its hash, and lists it without revealing it", async () => {
    const id = await activeCommunity("Codes Village");
    const admin = await makeMember(t, email("cadm"), id, ["community_admin"]);
    const created = await newCode(admin, id, { label: "Block A", maxUses: 25, expiresInDays: 30 });
    expect(created.code).toMatch(CODE_SHAPE);

    const stored = await t.db.admin.query("SELECT code_hash, code_hint FROM invite_codes WHERE id = $1", [created.id]);
    expect(stored.rows[0].code_hash).not.toContain(created.code.replace("-", ""));
    expect(stored.rows[0].code_hint).toBe(created.code.slice(-4));

    const list = await call(t.app, { url: `/api/v1/communities/${id}/invite-codes`, ...adminCtx(admin, id) });
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0]).toMatchObject({ label: "Block A", maxUses: 25, uses: 0, state: "active", hint: `…${created.code.slice(-4)}` });
    expect(list.body).not.toContain(created.code);
  });

  it("derives expired, used-up and revoked states, and revoking is permanent", async () => {
    const id = await activeCommunity("States Village");
    const admin = await makeMember(t, email("sadm"), id, ["community_admin"]);
    const a = await newCode(admin, id, { label: "will expire" });
    const b = await newCode(admin, id, { label: "will fill", maxUses: 1 });
    const c = await newCode(admin, id, { label: "will revoke" });
    await t.db.admin.query("UPDATE invite_codes SET expires_at = now() - interval '1 minute' WHERE id = $1", [a.id]);
    await t.db.admin.query("UPDATE invite_codes SET uses = 1 WHERE id = $1", [b.id]);
    expect((await call(t.app, { method: "DELETE", url: `/api/v1/communities/${id}/invite-codes/${c.id}`, ...adminCtx(admin, id) })).statusCode).toBe(204);
    expect((await call(t.app, { method: "DELETE", url: `/api/v1/communities/${id}/invite-codes/${c.id}`, ...adminCtx(admin, id) })).statusCode).toBe(404);

    const states = Object.fromEntries((await call(t.app, { url: `/api/v1/communities/${id}/invite-codes`, ...adminCtx(admin, id) })).json().data.map((r: { label: string; state: string }) => [r.label, r.state]));
    expect(states).toEqual({ "will expire": "expired", "will fill": "used_up", "will revoke": "revoked" });
  });

  it("validates input, refuses non-staff, and only issues codes for an active community", async () => {
    const id = await activeCommunity("Rules Village");
    const admin = await makeMember(t, email("vadm"), id, ["community_admin"]);
    const resident = await makeMember(t, email("vres"), id, ["resident"]);
    for (const bad of [{ label: "", maxUses: 5 }, { label: "x", maxUses: 0 }, { label: "x", maxUses: 20000 }, { label: "x", maxUses: 5, expiresInDays: 0 }, { label: "x", maxUses: 5, tenantId: id }]) {
      const res = await call(t.app, { method: "POST", url: `/api/v1/communities/${id}/invite-codes`, body: bad, ...adminCtx(admin, id) });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await call(t.app, { method: "POST", url: `/api/v1/communities/${id}/invite-codes`, body: { label: "x", maxUses: 5 }, ...adminCtx(resident, id) })).statusCode).toBe(403);

    const draft = randomUUID();
    await t.db.admin.query("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'community', 'Draft Place', 'draft')", [draft]);
    const res = await call(t.app, { method: "POST", url: `/api/v1/communities/${draft}/invite-codes`, body: { label: "x", maxUses: 5 }, cookie: ops.cookie, headers: PLATFORM_SCOPE });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("community_not_active");
  });

  it("keeps each community's codes private to that community", async () => {
    const a = await activeCommunity("Codes A");
    const b = await activeCommunity("Codes B");
    const adminA = await makeMember(t, email("ka"), a, ["community_admin"]);
    const adminB = await makeMember(t, email("kb"), b, ["community_admin"]);
    const codeB = await newCode(adminB, b);
    expect((await call(t.app, { url: `/api/v1/communities/${b}/invite-codes`, ...adminCtx(adminA, a) })).statusCode).toBe(404);
    expect((await call(t.app, { method: "DELETE", url: `/api/v1/communities/${a}/invite-codes/${codeB.id}`, ...adminCtx(adminA, a) })).statusCode).toBe(404);
    const still = await t.db.admin.query("SELECT revoked_at FROM invite_codes WHERE id = $1", [codeB.id]);
    expect(still.rows[0].revoked_at).toBeNull();
  });
});

describe("joining with a code (residents)", () => {
  it("makes the person a member with resident roles, counts the use, and records it", async () => {
    const id = await activeCommunity("Join Village");
    const admin = await makeMember(t, email("jadm"), id, ["community_admin"]);
    const { code } = await newCode(admin, id, { maxUses: 3 });
    const me = await verifiedResident("joiner");

    const res = await join(me.cookie, code, { unitLabel: "B-204" });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().community).toEqual({ id, name: "Join Village" });

    const profile = await call(t.app, { url: "/api/v1/me", cookie: me.cookie });
    expect(profile.json().tenants).toEqual([{ id, name: "Join Village", type: "community", status: "active", roles: ["parent_guardian", "resident"] }]);
    const row = await t.db.admin.query("SELECT status, join_method, unit_label FROM memberships WHERE tenant_id = $1 AND user_id = $2", [id, me.userId]);
    expect(row.rows[0]).toEqual({ status: "active", join_method: "invite_code", unit_label: "B-204" });
    expect((await t.db.admin.query("SELECT uses FROM invite_codes WHERE tenant_id = $1", [id])).rows[0].uses).toBe(1);
    expect((await t.db.admin.query("SELECT action FROM audit_log WHERE tenant_id = $1 AND action = 'membership.joined_with_code'", [id])).rowCount).toBe(1);

    // a resident has no administrative reach
    const ctx = { cookie: me.cookie, headers: { "x-tenant-id": id } };
    expect((await call(t.app, { url: `/api/v1/communities/${id}/members`, ...ctx })).statusCode).toBe(403);
    expect((await call(t.app, { url: `/api/v1/communities/${id}/invite-codes`, ...ctx })).statusCode).toBe(403);
  });

  it("accepts the code however it is typed", async () => {
    const id = await activeCommunity("Typing Village");
    const admin = await makeMember(t, email("tadm"), id, ["community_admin"]);
    const { code } = await newCode(admin, id, { maxUses: 5 });
    const raw = code.replace("-", "");
    for (const typed of [code.toLowerCase(), ` ${raw} `, raw.slice(0, 5) + " " + raw.slice(5)]) {
      const r = await verifiedResident("typed");
      expect((await join(r.cookie, typed)).statusCode, typed).toBe(201);
    }
  });

  it("gives the same answer for unknown, malformed, expired, revoked and used-up codes", async () => {
    const id = await activeCommunity("Same Answer");
    const admin = await makeMember(t, email("sadm2"), id, ["community_admin"]);
    const expired = await newCode(admin, id);
    const revoked = await newCode(admin, id);
    const full = await newCode(admin, id, { maxUses: 1 });
    await t.db.admin.query("UPDATE invite_codes SET expires_at = now() - interval '1 second' WHERE id = $1", [expired.id]);
    await t.db.admin.query("UPDATE invite_codes SET revoked_at = now() WHERE id = $1", [revoked.id]);
    await t.db.admin.query("UPDATE invite_codes SET uses = 1 WHERE id = $1", [full.id]);
    const me = await verifiedResident("probe");
    const answers = [];
    for (const code of [expired.code, revoked.code, full.code, "AAAAA-BBBBB", "short", "!!!!!-!!!!!", "A".repeat(10)]) {
      const r = await join(me.cookie, code);
      answers.push([r.statusCode, r.json().error.code, r.json().error.message]);
    }
    expect(new Set(answers.map((a) => a.join("|"))).size).toBe(1);
    expect(answers[0]).toEqual([400, "invalid_code", "That code is not valid, has expired, or has been used up."]);
    expect((await call(t.app, { url: "/api/v1/me", cookie: me.cookie })).json().tenants).toEqual([]);
  });

  it("requires a signed-in user with a verified email", async () => {
    const id = await activeCommunity("Verified Only");
    const admin = await makeMember(t, email("vadm2"), id, ["community_admin"]);
    const { code } = await newCode(admin, id);
    expect((await call(t.app, { method: "POST", url: "/api/v1/communities/join", body: { code } })).statusCode).toBe(401);
    const unverified = await register(t.app, email("unver"));
    const res = await join(unverified.cookie, code);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("email_verification_required");
    expect((await t.db.admin.query("SELECT uses FROM invite_codes WHERE tenant_id = $1", [id])).rows[0].uses).toBe(0);
  });

  it("will not let someone join twice or burn a second use", async () => {
    const id = await activeCommunity("Twice Village");
    const admin = await makeMember(t, email("twadm"), id, ["community_admin"]);
    const { code } = await newCode(admin, id, { maxUses: 5 });
    const me = await verifiedResident("twice");
    expect((await join(me.cookie, code)).statusCode).toBe(201);
    const again = await join(me.cookie, code);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("already_member");
    expect((await t.db.admin.query("SELECT uses FROM invite_codes WHERE tenant_id = $1", [id])).rows[0].uses).toBe(1);
  });

  it("admits exactly one of two people racing for the last place, and leaves no half-made membership", async () => {
    const id = await activeCommunity("Race Village");
    const admin = await makeMember(t, email("raadm"), id, ["community_admin"]);
    const { code } = await newCode(admin, id, { maxUses: 1 });
    const racers = await Promise.all([verifiedResident("race1"), verifiedResident("race2"), verifiedResident("race3")]);
    const results = await Promise.all(racers.map((r) => join(r.cookie, code)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 400, 400]);
    const members = await t.db.admin.query("SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1 AND join_method = 'invite_code'", [id]);
    expect(members.rows[0].n).toBe(1);
    const roles = await t.db.admin.query("SELECT count(DISTINCT user_id)::int AS n FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)", [id, racers.map((r) => r.userId)]);
    expect(roles.rows[0].n).toBe(1);
  });

  it("stops accepting a code once its community is suspended", async () => {
    const id = await activeCommunity("Suspended Soon");
    const admin = await makeMember(t, email("susadm"), id, ["community_admin"]);
    const { code } = await newCode(admin, id);
    await t.db.admin.query("UPDATE organizations SET status = 'suspended' WHERE id = $1", [id]);
    const me = await verifiedResident("lateJoin");
    expect((await join(me.cookie, code)).json().error.code).toBe("invalid_code");
  });

  it("rate limits code guessing per session", async () => {
    const limited = await createTestApp({ authRateLimitPerMinute: 3 });
    try {
      const u = await register(limited.app, "guesser@example.test");
      await markEmailVerified(limited.db, u.userId);
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await call(limited.app, { method: "POST", url: "/api/v1/communities/join", cookie: u.cookie, body: { code: "AAAAA-BBBBB" } })).statusCode);
      expect(statuses).toEqual([400, 400, 400, 429, 429]);
    } finally {
      await limited.close();
    }
  });
});

describe("asking to join, and approval (administrators)", () => {
  it("lets a resident ask, shows the request, and gives no access until it is approved", async () => {
    const id = await activeCommunity("Approval Village");
    const admin = await makeMember(t, email("aadm"), id, ["community_admin"]);
    const me = await verifiedResident("asker");

    const asked = await call(t.app, { method: "POST", url: `/api/v1/communities/${id}/join-requests`, cookie: me.cookie, body: { unitLabel: "C-12", note: "Moved in last month." } });
    expect(asked.statusCode, asked.body).toBe(201);
    expect(asked.json()).toEqual({ community: { id, name: "Approval Village" }, status: "pending" });

    const mine = await call(t.app, { url: "/api/v1/me/join-requests", cookie: me.cookie });
    expect(mine.json().data).toMatchObject([{ communityId: id, communityName: "Approval Village", unitLabel: "C-12" }]);
    expect((await call(t.app, { url: "/api/v1/me", cookie: me.cookie })).json().tenants).toEqual([]); // not a member yet
    expect((await call(t.app, { url: "/api/v1/me", cookie: me.cookie, headers: { "x-tenant-id": id } })).statusCode).toBe(403);

    const dup = await call(t.app, { method: "POST", url: `/api/v1/communities/${id}/join-requests`, cookie: me.cookie, body: { unitLabel: "C-12" } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("request_pending");

    const pending = await call(t.app, { url: `/api/v1/communities/${id}/members?status=pending`, ...adminCtx(admin, id) });
    expect(pending.json().data).toMatchObject([{ userId: me.userId, displayName: "Resident asker", unitLabel: "C-12", requestNote: "Moved in last month.", status: "pending", roles: [] }]);

    const approved = await call(t.app, { method: "PATCH", url: `/api/v1/communities/${id}/members/${me.userId}`, body: { action: "approve" }, ...adminCtx(admin, id) });
    expect(approved.json()).toEqual({ userId: me.userId, status: "active" });
    const after = await call(t.app, { url: "/api/v1/me", cookie: me.cookie });
    expect(after.json().tenants).toEqual([{ id, name: "Approval Village", type: "community", status: "active", roles: ["parent_guardian", "resident"] }]);
    expect((await call(t.app, { url: "/api/v1/me/join-requests", cookie: me.cookie })).json().data).toEqual([]);
  });

  it("supports rejecting and withdrawing a request", async () => {
    const id = await activeCommunity("Reject Village");
    const admin = await makeMember(t, email("radm"), id, ["community_admin"]);
    const [a, b] = [await verifiedResident("rej"), await verifiedResident("wd")];
    for (const r of [a, b]) await call(t.app, { method: "POST", url: `/api/v1/communities/${id}/join-requests`, cookie: r.cookie, body: { unitLabel: "D-1" } });

    await call(t.app, { method: "PATCH", url: `/api/v1/communities/${id}/members/${a.userId}`, body: { action: "reject", note: "Not a resident." }, ...adminCtx(admin, id) });
    expect((await call(t.app, { url: "/api/v1/me", cookie: a.cookie })).json().tenants).toEqual([]);
    expect((await t.db.admin.query("SELECT status FROM memberships WHERE user_id = $1", [a.userId])).rows[0].status).toBe("removed");
    const again = await call(t.app, { method: "POST", url: `/api/v1/communities/${id}/join-requests`, cookie: a.cookie, body: { unitLabel: "D-1" } });
    expect(again.json().error.code).toBe("contact_admin"); // a rejected person is not silently re-admitted

    expect((await call(t.app, { method: "DELETE", url: `/api/v1/me/join-requests/${id}`, cookie: b.cookie })).statusCode).toBe(204);
    expect((await call(t.app, { method: "DELETE", url: `/api/v1/me/join-requests/${id}`, cookie: b.cookie })).statusCode).toBe(404);
    expect((await call(t.app, { url: "/api/v1/me/join-requests", cookie: b.cookie })).json().data).toEqual([]);
    expect((await call(t.app, { method: "DELETE", url: `/api/v1/me/join-requests/${id}`, cookie: (await verifiedResident("nobody")).cookie })).statusCode).toBe(404);
  });

  it("respects a community that only accepts invite codes, and communities that are not in the directory", async () => {
    const closed = await activeCommunity("Closed Village", "invite_code_only");
    const draft = randomUUID();
    await t.db.admin.query("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'community', 'Secret Draft', 'draft')", [draft]);
    const me = await verifiedResident("shut");
    const closedRes = await call(t.app, { method: "POST", url: `/api/v1/communities/${closed}/join-requests`, cookie: me.cookie, body: { unitLabel: "A-1" } });
    expect(closedRes.statusCode).toBe(403);
    expect(closedRes.json().error.code).toBe("join_requires_invite");
    for (const id of [draft, randomUUID()]) {
      expect((await call(t.app, { method: "POST", url: `/api/v1/communities/${id}/join-requests`, cookie: me.cookie, body: { unitLabel: "A-1" } })).statusCode).toBe(404);
    }
    expect((await t.db.admin.query("SELECT 1 FROM memberships WHERE user_id = $1", [me.userId])).rowCount).toBe(0);
  });

  it("validates a request and requires a verified email", async () => {
    const id = await activeCommunity("Validate Village");
    const me = await verifiedResident("val");
    for (const bad of [{}, { unitLabel: "" }, { unitLabel: "x".repeat(61) }, { unitLabel: "A-1", note: "n".repeat(501) }, { unitLabel: "A-1", status: "active" }]) {
      expect((await call(t.app, { method: "POST", url: `/api/v1/communities/${id}/join-requests`, cookie: me.cookie, body: bad })).statusCode, JSON.stringify(bad)).toBe(400);
    }
    const unverified = await register(t.app, email("unver2"));
    expect((await call(t.app, { method: "POST", url: `/api/v1/communities/${id}/join-requests`, cookie: unverified.cookie, body: { unitLabel: "A-1" } })).statusCode).toBe(403);
  });
});

describe("managing members", () => {
  async function setup(name: string) {
    const id = await activeCommunity(name);
    const admin = await makeMember(t, email("madm"), id, ["community_admin"]);
    const { code } = await newCode(admin, id, { maxUses: 20 });
    const joined = async (prefix: string) => {
      const r = await verifiedResident(prefix);
      expect((await join(r.cookie, code)).statusCode).toBe(201);
      return r;
    };
    return { id, admin, joined };
  }
  const act = (admin: { cookie: string }, id: string, userId: string, action: string) =>
    call(t.app, { method: "PATCH", url: `/api/v1/communities/${id}/members/${userId}`, body: { action }, ...adminCtx(admin, id) });

  it("suspends and reinstates a member, with access lost and restored immediately", async () => {
    const { id, admin, joined } = await setup("Suspend Village");
    const m = await joined("susp");
    const ctx = { cookie: m.cookie, headers: { "x-tenant-id": id } };
    expect((await call(t.app, { url: "/api/v1/me", ...ctx })).statusCode).toBe(200);
    expect((await act(admin, id, m.userId, "suspend")).json().status).toBe("suspended");
    expect((await call(t.app, { url: "/api/v1/me", ...ctx })).statusCode).toBe(403);
    expect((await act(admin, id, m.userId, "suspend")).statusCode).toBe(409); // already suspended
    expect((await act(admin, id, m.userId, "reinstate")).json().status).toBe("active");
    expect((await call(t.app, { url: "/api/v1/me", ...ctx })).statusCode).toBe(200);
  });

  it("removes a member and their resident roles", async () => {
    const { id, admin, joined } = await setup("Remove Village");
    const m = await joined("gone");
    expect((await act(admin, id, m.userId, "remove")).json().status).toBe("removed");
    expect((await t.db.admin.query("SELECT 1 FROM role_assignments WHERE tenant_id = $1 AND user_id = $2", [id, m.userId])).rowCount).toBe(0);
    expect((await call(t.app, { url: "/api/v1/me", cookie: m.cookie })).json().tenants).toEqual([]);
    expect((await act(admin, id, m.userId, "approve")).statusCode).toBe(409);
  });

  it("will not let administrators act on themselves or on each other, but platform operations can", async () => {
    const { id, admin } = await setup("Admin Rules");
    const other = await makeMember(t, email("oadm"), id, ["community_admin"]);
    expect((await act(admin, id, admin.userId, "suspend")).json().error.code).toBe("cannot_act_on_self");
    expect((await act(admin, id, other.userId, "suspend")).statusCode).toBe(403);
    const byOps = await call(t.app, { method: "PATCH", url: `/api/v1/communities/${id}/members/${other.userId}`, body: { action: "suspend" }, cookie: ops.cookie, headers: PLATFORM_SCOPE });
    expect(byOps.statusCode).toBe(200);
    expect((await t.db.admin.query("SELECT status FROM memberships WHERE user_id = $1 AND tenant_id = $2", [other.userId, id])).rows[0].status).toBe("suspended");
  });

  it("lists members with filters and pagination, and shows nothing to residents or other communities", async () => {
    const { id, admin, joined } = await setup("List Village");
    const people = [];
    for (let i = 0; i < 5; i++) people.push(await joined(`list${i}`));
    const seen: string[] = [];
    let url = `/api/v1/communities/${id}/members?status=active&limit=2`;
    for (let guard = 0; guard < 10; guard++) {
      const r = await call(t.app, { url, ...adminCtx(admin, id) });
      expect(r.statusCode).toBe(200);
      for (const row of r.json().data) seen.push(row.userId);
      const next = r.json().page.nextCursor as string | null;
      if (!next) break;
      url = `/api/v1/communities/${id}/members?status=active&limit=2&cursor=${encodeURIComponent(next)}`;
    }
    expect(new Set(seen).size).toBe(seen.length);
    for (const p of people) expect(seen).toContain(p.userId);

    expect((await call(t.app, { url: `/api/v1/communities/${id}/members?status=bogus`, ...adminCtx(admin, id) })).statusCode).toBe(400);
    expect((await call(t.app, { url: `/api/v1/communities/${id}/members`, cookie: people[0]?.cookie ?? "", headers: { "x-tenant-id": id } })).statusCode).toBe(403);

    const otherCommunity = await activeCommunity("Other Village");
    const otherAdmin = await makeMember(t, email("oc"), otherCommunity, ["community_admin"]);
    expect((await call(t.app, { url: `/api/v1/communities/${id}/members`, ...adminCtx(otherAdmin, otherCommunity) })).statusCode).toBe(404);
    // The other community's administrator, acting in their OWN community, addressing this community's member: not found.
    const cross = await call(t.app, { method: "PATCH", url: `/api/v1/communities/${id}/members/${people[0]?.userId}`, body: { action: "remove" }, ...adminCtx(otherAdmin, otherCommunity) });
    expect(cross.statusCode).toBe(404);
    expect((await t.db.admin.query("SELECT status FROM memberships WHERE tenant_id = $1 AND user_id = $2", [id, people[0]?.userId])).rows[0].status).toBe("active");
  });

  it("returns 404 for a person who is not in this community", async () => {
    const { id, admin } = await setup("Missing Village");
    const stranger = await verifiedResident("stranger");
    expect((await act(admin, id, stranger.userId, "approve")).statusCode).toBe(404);
    expect((await act(admin, id, randomUUID(), "approve")).statusCode).toBe(404);
    expect((await call(t.app, { method: "PATCH", url: `/api/v1/communities/${id}/members/${stranger.userId}`, body: { action: "make_admin" }, ...adminCtx(admin, id) })).statusCode).toBe(400);
  });
});
