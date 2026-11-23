import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, enrollMfa, makeMember, type TestApp } from "./helpers";

/** Community security settings (migration 0019), attacked the way a member who would rather skip them would. */
let t: TestApp;
let seq = 0;
const email = (p: string) => `${p}${++seq}@secpol.test`;

async function activeCommunity(name: string): Promise<string> {
  const id = randomUUID();
  await t.db.admin.query("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'community', $2, 'active')", [id, name]);
  await t.db.admin.query("INSERT INTO community_profiles (tenant_id, city) VALUES ($1, 'Pune')", [id]);
  return id;
}
const ctx = (who: { cookie: string }, id: string) => ({ cookie: who.cookie, headers: { "x-tenant-id": id } });
const setPolicy = (admin: { cookie: string }, id: string, key: string, value: unknown) =>
  call(t.app, { method: "PUT", url: `/api/v1/communities/${id}/policies/${key}`, body: { value }, ...ctx(admin, id) });
const catalog = (who: { cookie: string }, id: string) => call(t.app, { url: "/api/v1/catalog/offerings", ...ctx(who, id) });

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

describe("security settings are listed as their own group, with safe defaults that change nothing", () => {
  it("lists both settings under category security, defaulting to off / no limit", async () => {
    const id = await activeCommunity("Listing Lane");
    const admin = await makeMember(t, email("adm"), id, ["community_admin"]);
    const list = (await call(t.app, { url: `/api/v1/communities/${id}/policies`, ...ctx(admin, id) })).json().data as { key: string; category: string; value: unknown; isDefault: boolean }[];
    const security = list.filter((p) => p.category === "security");
    expect(security.map((p) => [p.key, p.value, p.isDefault])).toEqual([
      ["require_two_step_all_members", false, true],
      ["invite_code_max_days", "none", true],
    ]);
  });

  it("a resident cannot change a security setting", async () => {
    const id = await activeCommunity("Resident Row");
    const resident = await makeMember(t, email("res"), id, ["resident"]);
    expect((await setPolicy(resident, id, "require_two_step_all_members", true)).statusCode).toBe(403);
  });
});

describe("require_two_step_all_members", () => {
  it("blocks a member without two-step verification until they set it up, in that community only", async () => {
    const id = await activeCommunity("Two Step Towers");
    const other = await activeCommunity("Elsewhere Estate");
    const admin = await makeMember(t, email("adm2"), id, ["community_admin"]);
    const resident = await makeMember(t, email("res2"), id, ["resident"]);
    await t.db.admin.query("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [other, resident.userId]);
    await t.db.admin.query("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'resident' AND tenant_id IS NULL", [other, resident.userId]);

    expect((await catalog(resident, id)).statusCode).toBe(200);
    expect((await setPolicy(admin, id, "require_two_step_all_members", true)).statusCode).toBe(200);

    const blocked = await catalog(resident, id);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("mfa_enrollment_required");
    const me = await call(t.app, { url: "/api/v1/me", ...ctx(resident, id) });
    expect(me.json().mfaEnrollmentRequired).toBe(true);
    expect((await catalog(resident, other)).statusCode).toBe(200); // the other community did not ask for it

    await enrollMfa(t.app, resident.cookie);
    expect((await catalog(resident, id)).statusCode).toBe(200);

    const audit = await t.db.admin.query("SELECT entity_id FROM audit_log WHERE tenant_id = $1 AND action = 'community.policy_changed'", [id]);
    expect(audit.rows.map((r) => r.entity_id)).toEqual(["require_two_step_all_members"]);
  });

  it("a session verified earlier does not count once the person has no two-step credential any more", async () => {
    const id = await activeCommunity("Stale Session Street");
    const admin = await makeMember(t, email("adm3"), id, ["community_admin"]);
    const resident = await makeMember(t, email("res3"), id, ["resident"], { mfa: true });
    expect((await setPolicy(admin, id, "require_two_step_all_members", true)).statusCode).toBe(200);
    expect((await catalog(resident, id)).statusCode).toBe(200);
    await t.db.admin.query("DELETE FROM mfa_recovery_codes WHERE user_id = $1", [resident.userId]);
    await t.db.admin.query("DELETE FROM mfa_credentials WHERE user_id = $1", [resident.userId]);
    expect((await catalog(resident, id)).statusCode).toBe(403);
  });

  it("turning it off again lets residents through without two-step", async () => {
    const id = await activeCommunity("Back Off Boulevard");
    const admin = await makeMember(t, email("adm4"), id, ["community_admin"]);
    const resident = await makeMember(t, email("res4"), id, ["resident"]);
    await setPolicy(admin, id, "require_two_step_all_members", true);
    expect((await catalog(resident, id)).statusCode).toBe(403);
    await setPolicy(admin, id, "require_two_step_all_members", false);
    expect((await catalog(resident, id)).statusCode).toBe(200);
  });
});

describe("invite_code_max_days", () => {
  const days = (iso: string | null) => (iso === null ? null : Math.round((Date.parse(iso) - Date.now()) / 86_400_000));
  const newCode = (admin: { cookie: string }, id: string, extra: Record<string, unknown> = {}) =>
    call(t.app, { method: "POST", url: `/api/v1/communities/${id}/invite-codes`, body: { label: "Block A", maxUses: 5, ...extra }, ...ctx(admin, id) });

  it("caps new codes at the limit, whether a longer life or no expiry was asked for; no limit keeps the request", async () => {
    const id = await activeCommunity("Capped Court");
    const admin = await makeMember(t, email("adm5"), id, ["community_admin"]);
    expect(days((await newCode(admin, id)).json().expiresAt)).toBeNull(); // default: no limit
    expect(days((await newCode(admin, id, { expiresInDays: 60 })).json().expiresAt)).toBe(60);

    expect((await setPolicy(admin, id, "invite_code_max_days", "7")).statusCode).toBe(200);
    expect(days((await newCode(admin, id)).json().expiresAt)).toBe(7);
    expect(days((await newCode(admin, id, { expiresInDays: 60 })).json().expiresAt)).toBe(7);
    expect(days((await newCode(admin, id, { expiresInDays: 3 })).json().expiresAt)).toBe(3); // shorter is always fine
    expect((await setPolicy(admin, id, "invite_code_max_days", "365")).statusCode).toBe(400); // only the listed values
  });
});
