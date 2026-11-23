import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withContext } from "../src/context";
import { createTestDb, type TestDb } from "../src/testing";

/** Appearance (migration 0018): personal display preferences and a community's palette, attacked as a hostile client would. */
let db: TestDb;
const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
let community: string;
let other: string;
let alice: string; // resident of community
let admin: string; // administrator of community (has communities.update)
let bob: string; // someone else

async function user(name: string): Promise<string> {
  const id = randomUUID();
  await q("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)", [id, `${name}@appearance.test`, name]);
  return id;
}

beforeAll(async () => {
  db = await createTestDb();
  community = randomUUID();
  other = randomUUID();
  await q("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'community', 'Appearance A', 'active'), ($2, 'community', 'Appearance B', 'active')", [community, other]);
  alice = await user("alice");
  admin = await user("admin");
  bob = await user("bob");
  await q("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2), ($1, $3), ($4, $5)", [community, alice, admin, other, bob]);
  await q("INSERT INTO user_preferences (user_id, theme_mode, palette) VALUES ($1, 'dark', 'ocean')", [bob]);
});
afterAll(async () => {
  await db.close();
});

describe("user_preferences", () => {
  it("a person can create and change their own preferences", async () => {
    await withContext(db.app, { userId: alice }, async (c) => {
      await c.query("INSERT INTO user_preferences (user_id, theme_mode) VALUES ($1, 'light')", [alice]);
      await c.query("UPDATE user_preferences SET palette = 'forest' WHERE user_id = $1", [alice]);
    });
    const { rows } = await q("SELECT theme_mode, palette FROM user_preferences WHERE user_id = $1", [alice]);
    expect(rows[0]).toEqual({ theme_mode: "light", palette: "forest" });
  });

  it("nobody reads or changes another person's preferences, platform scope included", async () => {
    const seen = await withContext(db.app, { userId: alice, tenantId: community }, async (c) => (await c.query("SELECT 1 FROM user_preferences WHERE user_id = $1", [bob])).rowCount);
    expect(seen).toBe(0);
    const changed = await withContext(db.app, { userId: alice }, async (c) => (await c.query("UPDATE user_preferences SET theme_mode = 'light' WHERE user_id = $1", [bob])).rowCount);
    expect(changed).toBe(0);
    await expect(withContext(db.app, { userId: alice }, (c) => c.query("INSERT INTO user_preferences (user_id) VALUES ($1)", [randomUUID()]))).rejects.toMatchObject({ code: "42501" });
  });

  it("only known palettes and modes are stored", async () => {
    await expect(withContext(db.app, { userId: alice }, (c) => c.query("UPDATE user_preferences SET palette = 'neon' WHERE user_id = $1", [alice]))).rejects.toMatchObject({ code: "23514" });
    await expect(withContext(db.app, { userId: alice }, (c) => c.query("UPDATE user_preferences SET theme_mode = 'sepia' WHERE user_id = $1", [alice]))).rejects.toMatchObject({ code: "23514" });
  });

  it("the user id of a row cannot be changed", async () => {
    await expect(withContext(db.app, { userId: alice }, (c) => c.query("UPDATE user_preferences SET user_id = $2 WHERE user_id = $1", [alice, bob]))).rejects.toMatchObject({ code: "42501" });
  });
});

describe("community_branding", () => {
  const asAdmin = () => ({ userId: admin, tenantId: community, permissions: ["communities.read", "communities.update"] });
  const asResident = () => ({ userId: alice, tenantId: community, permissions: ["catalog.read"] });

  it("an administrator with communities.update sets the palette; members read it", async () => {
    await withContext(db.app, asAdmin(), (c) => c.query("INSERT INTO community_branding (tenant_id, palette, updated_by) VALUES ($1, 'ocean', $2)", [community, admin]));
    const read = await withContext(db.app, asResident(), async (c) => (await c.query("SELECT palette FROM community_branding WHERE tenant_id = $1", [community])).rows);
    expect(read).toEqual([{ palette: "ocean" }]);
  });

  it("a member without communities.update cannot change it", async () => {
    const n = await withContext(db.app, asResident(), async (c) => (await c.query("UPDATE community_branding SET palette = 'forest' WHERE tenant_id = $1", [community])).rowCount);
    expect(n).toBe(0);
    const { rows } = await q("SELECT palette FROM community_branding WHERE tenant_id = $1", [community]);
    expect(rows[0].palette).toBe("ocean");
  });

  it("an administrator cannot set another community's palette", async () => {
    await expect(withContext(db.app, asAdmin(), (c) => c.query("INSERT INTO community_branding (tenant_id, palette) VALUES ($1, 'forest')", [other]))).rejects.toMatchObject({ code: "42501" });
  });

  it("a member of another community cannot read it", async () => {
    const n = await withContext(db.app, { userId: bob, tenantId: other, permissions: ["communities.read"] }, async (c) => (await c.query("SELECT 1 FROM community_branding WHERE tenant_id = $1", [community])).rowCount);
    expect(n).toBe(0);
  });
});
