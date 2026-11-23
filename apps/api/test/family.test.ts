import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageBand } from "../src/routes/family";
import { call, createTestApp, makeMember, makeStaff, markEmailVerified, PLATFORM_SCOPE, register, type TestApp } from "./helpers";

let t: TestApp;
let seq = 0;
const email = (p: string) => `${p}${++seq}@example.test`;
const YEAR = new Date().getFullYear();

async function guardian(prefix = "parent") {
  const u = await register(t.app, email(prefix), `Parent ${prefix}`);
  await markEmailVerified(t.db, u.userId);
  return u;
}
const addChild = (cookie: string, body: Record<string, unknown>) => call(t.app, { method: "POST", url: "/api/v1/me/family/children", cookie, body });
const OK = { nickname: "Aarav", birthYear: YEAR - 7, interests: ["magic", "science"], consentAccepted: true };

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

describe("age bands", () => {
  it("shows a coarse band, never an exact age", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    expect([2026, 2024, 2023, 2020, 2018, 2017, 2014, 2013, 2009].map((y) => ageBand(y, now))).toEqual(["0-2", "0-2", "3-5", "6-8", "6-8", "9-12", "9-12", "13-17", "13-17"]);
  });
});

describe("access", () => {
  it("requires a signed-in guardian with a verified email", async () => {
    expect((await call(t.app, { url: "/api/v1/me/family" })).statusCode).toBe(401);
    const unverified = await register(t.app, email("unver"));
    const res = await addChild(unverified.cookie, OK);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("email_verification_required");
    expect((await t.db.admin.query("SELECT 1 FROM children")).rowCount).toBe(0);
  });

  it("offers the list of interests to signed-in users", async () => {
    const p = await guardian();
    const res = await call(t.app, { url: "/api/v1/interests", cookie: p.cookie });
    expect(res.json().data.length).toBeGreaterThanOrEqual(15);
    expect(res.json().data[0]).toEqual({ key: "magic", label: "Magic and entertainment" });
    expect((await call(t.app, { url: "/api/v1/interests" })).statusCode).toBe(401);
  });
});

describe("consent and adding children", () => {
  it("asks for the guardian's agreement first, records it with a version, and asks only once", async () => {
    const p = await guardian("consent");
    const refused = await addChild(p.cookie, { ...OK, consentAccepted: undefined });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe("consent_required");
    expect((await t.db.admin.query("SELECT 1 FROM children")).rowCount).toBe(0);
    expect((await t.db.admin.query("SELECT 1 FROM consents WHERE user_id = $1", [p.userId])).rowCount).toBe(0);
    expect((await addChild(p.cookie, { ...OK, consentAccepted: false })).statusCode).toBe(422);

    const first = await addChild(p.cookie, OK);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ nickname: "Aarav", birthYear: YEAR - 7, interests: ["magic", "science"], ageBand: "6-8" });
    const consent = await t.db.admin.query("SELECT version, withdrawn_at FROM consents WHERE user_id = $1", [p.userId]);
    expect(consent.rows).toEqual([{ version: "2026-11-v1", withdrawn_at: null }]);

    const second = await addChild(p.cookie, { nickname: "Diya", birthYear: YEAR - 3, consentAccepted: undefined });
    expect(second.statusCode).toBe(201);
    expect(second.json().interests).toEqual([]);
    expect((await t.db.admin.query("SELECT 1 FROM consents WHERE user_id = $1", [p.userId])).rowCount).toBe(1);

    const family = (await call(t.app, { url: "/api/v1/me/family", cookie: p.cookie })).json();
    expect(family.children.map((c: { nickname: string }) => c.nickname)).toEqual(["Aarav", "Diya"]);
    expect(family.consent.version).toBe("2026-11-v1");
  });

  it("validates every field, and refuses extra data (no photos, schools or contact details)", async () => {
    const p = await guardian("validate");
    const bad: Record<string, unknown>[] = [
      { nickname: "" },
      { nickname: "x".repeat(41) },
      { nickname: "mail me at a@b.com" },
      { nickname: "call 9876543210" },
      { nickname: "9876 54321" },
      { birthYear: YEAR + 1 },
      { birthYear: YEAR - 18 },
      { birthYear: 2015.5 },
      { birthYear: "2015" },
      { interests: ["magic", "magic"] },
      { interests: ["not_a_real_interest"] },
      { interests: Array.from({ length: 11 }, (_, i) => `x${"a".repeat(i)}`) },
      { photo: "data:image/png;base64,xx" },
      { school: "Springfield Elementary" },
      { surname: "Patel" },
      { phone: "9876543210" },
    ];
    for (const over of bad) {
      const res = await addChild(p.cookie, { ...OK, ...over });
      expect(res.statusCode, JSON.stringify(over)).toBe(400);
    }
    // Nothing was stored for this guardian, not even a family record or consent.
    expect((await t.db.admin.query("SELECT 1 FROM families WHERE owner_user_id = $1", [p.userId])).rowCount).toBe(0);
    expect((await t.db.admin.query("SELECT 1 FROM consents WHERE user_id = $1", [p.userId])).rowCount).toBe(0);
  });

  it("caps the number of children", async () => {
    const p = await guardian("cap");
    for (let i = 0; i < 10; i++) expect((await addChild(p.cookie, { ...OK, nickname: `Kid ${i}` })).statusCode).toBe(201);
    const res = await addChild(p.cookie, { ...OK, nickname: "One more" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("limit_reached");
  });
});

describe("one guardian's data stays theirs", () => {
  it("never shows, changes or deletes another family's children", async () => {
    const a = await guardian("famA");
    const b = await guardian("famB");
    const child = (await addChild(a.cookie, { ...OK, nickname: "Only A" })).json().id as string;

    expect((await call(t.app, { url: "/api/v1/me/family", cookie: b.cookie })).json().children).toEqual([]);
    expect((await call(t.app, { method: "PATCH", url: `/api/v1/me/family/children/${child}`, cookie: b.cookie, body: { nickname: "Stolen" } })).statusCode).toBe(404);
    expect((await call(t.app, { method: "DELETE", url: `/api/v1/me/family/children/${child}`, cookie: b.cookie })).statusCode).toBe(404);
    expect((await t.db.admin.query("SELECT nickname FROM children WHERE id = $1", [child])).rows[0].nickname).toBe("Only A");
    const exported = (await call(t.app, { url: "/api/v1/me/family/export", cookie: b.cookie })).body;
    expect(exported).not.toContain("Only A");
  });

  it("is invisible to community administrators and platform staff", async () => {
    const orgId = randomUUID();
    await t.db.admin.query("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'community', 'Family Privacy Estates', 'active')", [orgId]);
    const parent = await guardian("privparent");
    await t.db.admin.query("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [orgId, parent.userId]);
    await addChild(parent.cookie, { ...OK, nickname: "Secret Child" });
    const admin = await makeMember(t, email("privadm"), orgId, ["community_admin"]);
    const ops = await makeStaff(t, email("privops"), "super_admin");

    // The API offers no way in...
    for (const who of [{ cookie: admin.cookie, headers: { "x-tenant-id": orgId } }, { cookie: ops.cookie, headers: PLATFORM_SCOPE }]) {
      const res = await call(t.app, { url: "/api/v1/me/family", ...who });
      expect(res.json().children).toEqual([]); // each person only ever sees their own family
      expect(res.body).not.toContain("Secret Child");
    }
    // ...and neither does the database: a super administrator in platform scope reads zero rows.
    const rows = await t.db.app.connect();
    try {
      await rows.query("BEGIN");
      await rows.query("SELECT set_config('app.user_id', $1, true), set_config('app.platform_scope', 'on', true), set_config('app.tenant_id', $2, true)", [ops.userId, orgId]);
      expect((await rows.query("SELECT 1 FROM children")).rowCount).toBe(0);
      expect((await rows.query("SELECT 1 FROM families")).rowCount).toBe(0);
      expect((await rows.query("SELECT 1 FROM consents")).rowCount).toBe(0);
      await rows.query("ROLLBACK");
    } finally {
      rows.release();
    }
  });
});

describe("changing and deleting", () => {
  it("updates a child, re-validating the new values", async () => {
    const p = await guardian("edit");
    const id = (await addChild(p.cookie, OK)).json().id as string;
    const url = `/api/v1/me/family/children/${id}`;
    const ok = await call(t.app, { method: "PATCH", url, cookie: p.cookie, body: { nickname: "Aaru", interests: ["chess"] } });
    expect(ok.json()).toMatchObject({ nickname: "Aaru", interests: ["chess"], birthYear: YEAR - 7 });
    expect((await call(t.app, { method: "PATCH", url, cookie: p.cookie, body: { birthYear: YEAR + 5 } })).statusCode).toBe(400);
    expect((await call(t.app, { method: "PATCH", url, cookie: p.cookie, body: {} })).statusCode).toBe(400);
    expect((await call(t.app, { method: "PATCH", url, cookie: p.cookie, body: { school: "X" } })).statusCode).toBe(400);
    expect((await call(t.app, { method: "PATCH", url: `/api/v1/me/family/children/${randomUUID()}`, cookie: p.cookie, body: { nickname: "X" } })).statusCode).toBe(404);
    expect((await call(t.app, { method: "PATCH", url: "/api/v1/me/family/children/not-a-uuid", cookie: p.cookie, body: { nickname: "X" } })).statusCode).toBe(400);
  });

  it("deletes a child permanently", async () => {
    const p = await guardian("del");
    const id = (await addChild(p.cookie, OK)).json().id as string;
    expect((await call(t.app, { method: "DELETE", url: `/api/v1/me/family/children/${id}`, cookie: p.cookie })).statusCode).toBe(204);
    expect((await t.db.admin.query("SELECT 1 FROM children WHERE id = $1", [id])).rowCount).toBe(0); // gone, not hidden
    expect((await call(t.app, { method: "DELETE", url: `/api/v1/me/family/children/${id}`, cookie: p.cookie })).statusCode).toBe(404);
  });
});

describe("the guardian's rights: access and erasure", () => {
  it("exports everything held about the family as a file", async () => {
    const p = await guardian("export");
    await addChild(p.cookie, OK);
    await addChild(p.cookie, { nickname: "Diya", birthYear: YEAR - 4 });
    const res = await call(t.app, { url: "/api/v1/me/family/export", cookie: p.cookie });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    const body = res.json();
    expect(body.children.map((c: { nickname: string }) => c.nickname)).toEqual(["Aarav", "Diya"]);
    expect(body.consents).toMatchObject([{ kind: "guardian_child_data", version: "2026-11-v1", withdrawnAt: null }]);
  });

  it("erases every child and withdraws consent, after which consent is needed again", async () => {
    const p = await guardian("erase");
    await addChild(p.cookie, OK);
    await addChild(p.cookie, { nickname: "Diya", birthYear: YEAR - 4 });
    expect((await call(t.app, { method: "DELETE", url: "/api/v1/me/family", cookie: p.cookie })).statusCode).toBe(204);

    expect((await t.db.admin.query("SELECT 1 FROM children c JOIN families f ON f.id = c.family_id WHERE f.owner_user_id = $1", [p.userId])).rowCount).toBe(0);
    const consents = await t.db.admin.query("SELECT withdrawn_at FROM consents WHERE user_id = $1", [p.userId]);
    expect(consents.rows[0].withdrawn_at).not.toBeNull();
    const family = (await call(t.app, { url: "/api/v1/me/family", cookie: p.cookie })).json();
    expect(family).toMatchObject({ children: [], consent: null });

    const again = await addChild(p.cookie, { ...OK, consentAccepted: undefined });
    expect(again.json().error.code).toBe("consent_required");
    expect((await addChild(p.cookie, OK)).statusCode).toBe(201); // fresh, explicit consent
    expect((await t.db.admin.query("SELECT 1 FROM consents WHERE user_id = $1", [p.userId])).rowCount).toBe(2); // history kept
  });

  it("audits actions without ever storing a child's details", async () => {
    const p = await guardian("audit");
    await addChild(p.cookie, { ...OK, nickname: "Unmistakable Name" });
    await call(t.app, { method: "DELETE", url: "/api/v1/me/family", cookie: p.cookie });
    const rows = await t.db.admin.query("SELECT action, metadata, entity_id FROM audit_log WHERE actor_user_id = $1 AND action LIKE 'family.%'", [p.userId]);
    expect(rows.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["family.child_added", "family.erased"]));
    expect(JSON.stringify(rows.rows)).not.toContain("Unmistakable Name");
  });
});
