import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, login, register, type TestApp } from "./helpers";

/** Security page: recent sign-ins and "sign out all other devices". */
let t: TestApp;
let seq = 0;
const email = (p: string) => `${p}${++seq}@signins.test`;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

describe("sign out all other devices", () => {
  it("ends every other session, keeps this one, and is audited", async () => {
    const e = email("a");
    const first = await register(t.app, e);
    const second = await login(t.app, e);
    const third = await login(t.app, e);
    const res = await call(t.app, { method: "POST", url: "/api/v1/me/sessions/revoke-others", cookie: third });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ signedOut: 2 });
    expect((await call(t.app, { url: "/api/v1/me", cookie: third })).statusCode).toBe(200);
    expect((await call(t.app, { url: "/api/v1/me", cookie: first.cookie })).statusCode).toBe(401);
    expect((await call(t.app, { url: "/api/v1/me", cookie: second })).statusCode).toBe(401);
    const audit = await t.db.admin.query("SELECT metadata FROM audit_log WHERE actor_user_id = $1 AND action = 'auth.sessions_revoked_others'", [first.userId]);
    expect(audit.rows).toEqual([{ metadata: { count: 2 } }]);
  });

  it("does not touch anyone else's sessions, and needs a signed-in caller", async () => {
    const mine = await register(t.app, email("mine"));
    const theirs = await register(t.app, email("theirs"));
    await call(t.app, { method: "POST", url: "/api/v1/me/sessions/revoke-others", cookie: mine.cookie });
    expect((await call(t.app, { url: "/api/v1/me", cookie: theirs.cookie })).statusCode).toBe(200);
    expect((await call(t.app, { method: "POST", url: "/api/v1/me/sessions/revoke-others" })).statusCode).toBe(401);
  });
});

describe("recent sign-ins", () => {
  it("lists only the person's own sign-ins, newest first, with what became of each", async () => {
    const e = email("list");
    const first = await register(t.app, e);
    const second = await login(t.app, e);
    await register(t.app, email("stranger")); // someone else's sign-in must not appear
    await call(t.app, { method: "DELETE", url: `/api/v1/me/sessions/${(await call(t.app, { url: "/api/v1/me/sessions", cookie: second })).json().data.find((s: { current: boolean }) => !s.current).id}`, cookie: second });
    const list = (await call(t.app, { url: "/api/v1/me/sign-ins", cookie: second })).json().data as { state: string; device: string | null }[];
    expect(list.map((s) => s.state)).toEqual(["this_device", "signed_out"]);
    expect(Object.keys(list[0] ?? {}).sort()).toEqual(["device", "lastSeenAt", "signedInAt", "state"]); // no ids, addresses or tokens
    expect((await call(t.app, { url: "/api/v1/me", cookie: first.cookie })).statusCode).toBe(401);
  });
});
