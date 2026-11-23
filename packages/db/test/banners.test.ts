import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withContext } from "../src/context";
import { createTestDb, type TestDb } from "../src/testing";

/** Community banners (migration 0020) at the database level: the policy, not the API, hides drafts from residents. */
let db: TestDb;
const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
let community: string;
let user: string;

beforeAll(async () => {
  db = await createTestDb();
  community = randomUUID();
  user = randomUUID();
  await q("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'community', 'Banner DB', 'active')", [community]);
  await q("INSERT INTO users (id, email, display_name) VALUES ($1, 'u@bannerdb.test', 'U')", [user]);
  await q(
    `INSERT INTO community_banners (tenant_id, title, active, starts_on, ends_on) VALUES
       ($1, 'Showing', true, NULL, NULL), ($1, 'Off', false, NULL, NULL),
       ($1, 'Future', true, current_date + 5, NULL), ($1, 'Past', true, NULL, current_date - 1)`,
    [community],
  );
});
afterAll(async () => {
  await db.close();
});

const titles = async (permissions: string[]) =>
  withContext(db.app, { tenantId: community, userId: user, permissions }, async (c) => (await c.query<{ title: string }>("SELECT title FROM community_banners ORDER BY title")).rows.map((r) => r.title));

describe("community_banners row-level security", () => {
  it("a member reads only banners that are on and inside their dates, even when asking for all", async () => {
    expect(await titles(["catalog.read"])).toEqual(["Showing"]);
  });

  it("communities.update reads every banner of the community", async () => {
    expect(await titles(["communities.update"])).toEqual(["Future", "Off", "Past", "Showing"]);
  });

  it("a member cannot switch a banner on, write one, or delete one", async () => {
    const n = await withContext(db.app, { tenantId: community, userId: user, permissions: ["catalog.read"] }, async (c) => ({
      upd: (await c.query("UPDATE community_banners SET active = true WHERE title = 'Showing'")).rowCount,
      del: (await c.query("DELETE FROM community_banners")).rowCount,
    }));
    expect(n).toEqual({ upd: 0, del: 0 });
    await expect(
      withContext(db.app, { tenantId: community, userId: user, permissions: ["catalog.read"] }, (c) => c.query("INSERT INTO community_banners (tenant_id, title) VALUES ($1, 'x')", [community])),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("links can only point inside the app", async () => {
    await expect(q("INSERT INTO community_banners (tenant_id, title, link_path, link_label) VALUES ($1, 'x', 'https://evil.example', 'Go')", [community])).rejects.toMatchObject({ code: "23514" });
  });
});
