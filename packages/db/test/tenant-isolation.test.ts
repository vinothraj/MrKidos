import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withContext } from "../src/context";
import { createTestDb, type TestDb } from "../src/testing";

/**
 * Tenant isolation suite. A table that carries tenant data MUST appear in TENANT_TABLES with a
 * cross-tenant insert probe. The completeness test below fails CI when a new table with a
 * `tenant_id` column is added without a fixture, so isolation cannot be forgotten.
 */

/** Tables intentionally without row-level security: global reference data. */
const GLOBAL_TABLES = new Set(["permissions", "schema_migrations"]);

interface Ids {
  orgA: string;
  orgB: string;
  alice: string; // member of A
  bob: string; // member of B
  carol: string; // platform staff
  mallory: string; // not in platform_staff, tries to claim platform scope
}

interface TenantTable {
  /** SQL that inserts a row owned by tenant `$1` (used to prove cross-tenant inserts fail). */
  insertForTenant: string;
  /** Whether the app role may UPDATE/DELETE rows (audit_log is append-only). */
  mutable: boolean;
  /** Whether the app role has UPDATE rights at all (role_assignments are insert/delete only). */
  updatable?: boolean;
  /** Whether the app role has DELETE rights at all (community_private is never deleted by the app). */
  deletable?: boolean;
}

const TENANT_TABLES: Record<string, TenantTable> = {
  vendor_profiles: { insertForTenant: `INSERT INTO vendor_profiles (tenant_id) VALUES ($1)`, mutable: true, deletable: false },
  vendor_private: { insertForTenant: `INSERT INTO vendor_private (tenant_id) VALUES ($1)`, mutable: true, deletable: false },
  vendor_internal_notes: { insertForTenant: `INSERT INTO vendor_internal_notes (tenant_id, notes) VALUES ($1, 'probe')`, mutable: true, updatable: false, deletable: false },
  vendor_status_history: { insertForTenant: `INSERT INTO vendor_status_history (tenant_id, to_status) VALUES ($1, 'draft')`, mutable: false },
  vendor_categories: {
    insertForTenant: `INSERT INTO vendor_categories (tenant_id, category_id) VALUES ($1, (SELECT id FROM categories WHERE key = 'magic_shows'))`,
    mutable: true,
    updatable: false,
  },
  vendor_service_areas: { insertForTenant: `INSERT INTO vendor_service_areas (tenant_id, city) VALUES ($1, 'Probe City')`, mutable: true },
  vendor_documents: { insertForTenant: `INSERT INTO vendor_documents (tenant_id, requirement_key, title) VALUES ($1, 'identity_proof', 'Probe')`, mutable: true },
  requests: {
    insertForTenant: `INSERT INTO requests (tenant_id, requester_id, request_type_id, schema_version, title) VALUES ($1, $2, (SELECT id FROM request_types ORDER BY key LIMIT 1), 1, 'Probe request')`,
    mutable: true,
    updatable: false,
    deletable: false,
  },
  request_status_history: { insertForTenant: `INSERT INTO request_status_history (tenant_id, request_id, to_status) VALUES ($1, (SELECT id FROM requests LIMIT 1), 'submitted')`, mutable: false },
  request_comments: { insertForTenant: `INSERT INTO request_comments (tenant_id, request_id, author_id, visibility, body) VALUES ($1, (SELECT id FROM requests LIMIT 1), $2, 'resident', 'probe')`, mutable: false },
  request_matches: { insertForTenant: `INSERT INTO request_matches (tenant_id, request_id, vendor_id, score, source) VALUES ($1, gen_random_uuid(), $1, 50, 'auto')`, mutable: true, updatable: false },
  inquiries: { insertForTenant: `INSERT INTO inquiries (tenant_id, request_id, vendor_id, snapshot) VALUES ($1, gen_random_uuid(), $1, '{}'::jsonb)`, mutable: true, updatable: false, deletable: false },
  quotes: { insertForTenant: `INSERT INTO quotes (tenant_id, request_id, inquiry_id, vendor_id, total_minor) VALUES ($1, gen_random_uuid(), gen_random_uuid(), $1, 100)`, mutable: true, updatable: false, deletable: false },
  quote_line_items: { insertForTenant: `INSERT INTO quote_line_items (tenant_id, quote_id, description, unit_minor) VALUES ($1, gen_random_uuid(), 'Probe', 1)`, mutable: false },
  bookings: { insertForTenant: `INSERT INTO bookings (tenant_id, request_id, quote_id, vendor_id, agreed_total_minor) VALUES ($1, gen_random_uuid(), gen_random_uuid(), $1, 100)`, mutable: true, updatable: false, deletable: false },
  request_stage_flags: { insertForTenant: `INSERT INTO request_stage_flags (request_id, tenant_id, closed) VALUES (gen_random_uuid(), $1, false)`, mutable: true, updatable: false, deletable: false },
  booking_payments: { insertForTenant: `INSERT INTO booking_payments (tenant_id, booking_id, kind, amount_minor, method, paid_on) VALUES ($1, gen_random_uuid(), 'family_to_vendor', 100, 'cash', current_date)`, mutable: false },
  reviews: { insertForTenant: `INSERT INTO reviews (tenant_id, booking_id, vendor_id, requester_id, rating) VALUES ($1, gen_random_uuid(), $1, $2, 5)`, mutable: true, updatable: false, deletable: false },
  vendor_vetting_summary: { insertForTenant: `INSERT INTO vendor_vetting_summary (tenant_id, complete) VALUES ($1, true)`, mutable: true, updatable: false, deletable: false },
  vendor_availability_rules: { insertForTenant: `INSERT INTO vendor_availability_rules (tenant_id, weekday, start_time, end_time) VALUES ($1, 1, '09:00', '10:00')`, mutable: true },
  vendor_unavailable_blocks: { insertForTenant: `INSERT INTO vendor_unavailable_blocks (tenant_id, starts_at, ends_at) VALUES ($1, now(), now() + interval '1 hour')`, mutable: true },
  community_vendor_approvals: { insertForTenant: `INSERT INTO community_vendor_approvals (tenant_id, vendor_id, status) VALUES ($1, $1, 'approved')`, mutable: true, deletable: false },
  offerings: {
    insertForTenant: `INSERT INTO offerings (tenant_id, category_id, name, pricing_model, price_minor) VALUES ($1, (SELECT id FROM categories WHERE key = 'magic_shows'), 'Probe', 'fixed', 100)`,
    mutable: true,
    deletable: false,
  },
  concerns: {
    insertForTenant: `INSERT INTO concerns (tenant_id, reporter_id, category, subject, details) VALUES ($1, $2, 'other', 'Probe', 'Probe')`,
    mutable: true,
    updatable: false,
    deletable: false,
  },
  saved_offerings: {
    insertForTenant: `INSERT INTO saved_offerings (tenant_id, user_id, offering_id) VALUES ($1, $2, gen_random_uuid())`,
    mutable: true,
    updatable: false,
  },
  invite_codes: {
    insertForTenant: `INSERT INTO invite_codes (tenant_id, code_hash, code_hint, label, max_uses) VALUES ($1, 'probe-hash', 'abcd', 'Probe', 1)`,
    mutable: true,
    updatable: false,
    deletable: false,
  },
  community_private: {
    insertForTenant: `INSERT INTO community_private (tenant_id, address) VALUES ($1, 'X')`,
    mutable: true,
    deletable: false,
  },
  community_internal_notes: {
    // platform-only: a tenant can neither read nor write its own notes
    insertForTenant: `INSERT INTO community_internal_notes (tenant_id, notes) VALUES ($1, 'probe')`,
    mutable: true,
    updatable: false,
    deletable: false,
  },
  community_facilities: {
    insertForTenant: `INSERT INTO community_facilities (tenant_id, name, kind) VALUES ($1, 'Probe', 'hall')`,
    mutable: true,
  },
  community_policies: {
    insertForTenant: `INSERT INTO community_policies (tenant_id, key, value) VALUES ($1, 'quiet_hours', '"x"')`,
    mutable: true,
  },
  community_branding: {
    insertForTenant: `INSERT INTO community_branding (tenant_id, palette) VALUES ($1, 'ocean')`,
    mutable: true,
    updatable: false, // column-level update grant: tenant_id is not updatable at all
    deletable: false,
  },
  community_banners: {
    insertForTenant: `INSERT INTO community_banners (tenant_id, title) VALUES ($1, 'Probe')`,
    mutable: true,
    updatable: false, // column-level update grant: tenant_id is not updatable
  },
  community_status_history: {
    insertForTenant: `INSERT INTO community_status_history (tenant_id, to_status) VALUES ($1, 'draft')`,
    mutable: false,
  },
  memberships: {
    insertForTenant: `INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)`,
    mutable: true,
  },
  community_profiles: {
    insertForTenant: `INSERT INTO community_profiles (tenant_id, city) VALUES ($1, 'X')`,
    mutable: true,
  },
  roles: {
    insertForTenant: `INSERT INTO roles (tenant_id, scope_type, key, name) VALUES ($1, 'community', 'probe_role', 'Probe')`,
    mutable: true,
  },
  role_assignments: {
    insertForTenant: `INSERT INTO role_assignments (tenant_id, user_id, role_id)
                      VALUES ($1, $2, (SELECT id FROM roles WHERE key = 'resident' AND tenant_id IS NULL))`,
    mutable: true,
    updatable: false,
  },
  audit_log: {
    insertForTenant: `INSERT INTO audit_log (tenant_id, action) VALUES ($1, 'probe')`,
    mutable: false,
  },
};

let db: TestDb;
let ids: Ids;

/** What the public directory should show right now: the ACTIVE communities, whatever other tests have added. */
async function activeCommunityNames(): Promise<string[]> {
  const { rows } = await db.admin.query<{ name: string }>("SELECT name FROM organizations WHERE type = 'community' AND status = 'active' ORDER BY name");
  return rows.map((r) => r.name).sort();
}

async function arrange(): Promise<Ids> {
  const i: Ids = {
    orgA: randomUUID(),
    orgB: randomUUID(),
    alice: randomUUID(),
    bob: randomUUID(),
    carol: randomUUID(),
    mallory: randomUUID(),
  };
  const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params); // superuser: bypasses RLS
  await q(
    `INSERT INTO organizations (id, type, name, status) VALUES
       ($1, 'community', 'Community A', 'draft'), ($2, 'community', 'Community B', 'draft')`,
    [i.orgA, i.orgB],
  );
  await q(
    `INSERT INTO users (id, email, display_name) VALUES
       ($1, 'alice@example.test', 'Alice'), ($2, 'bob@example.test', 'Bob'),
       ($3, 'carol@example.test', 'Carol'), ($4, 'mallory@example.test', 'Mallory')`,
    [i.alice, i.bob, i.carol, i.mallory],
  );
  await q(`INSERT INTO platform_staff (user_id) VALUES ($1)`, [i.carol]);
  await q(
    `INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2), ($3, $4)`,
    [i.orgA, i.alice, i.orgB, i.bob],
  );
  await q(`INSERT INTO community_profiles (tenant_id, city) VALUES ($1, 'CityA'), ($2, 'CityB')`, [
    i.orgA,
    i.orgB,
  ]);
  await q(`INSERT INTO community_private (tenant_id, address) VALUES ($1, 'A street'), ($2, 'B street')`, [i.orgA, i.orgB]);
  await q(`INSERT INTO community_internal_notes (tenant_id, notes) VALUES ($1, 'A note'), ($2, 'B note')`, [i.orgA, i.orgB]);
  await q(`INSERT INTO invite_codes (tenant_id, code_hash, code_hint, label, max_uses) VALUES ($1, 'seed-a', 'aaaa', 'A', 5), ($2, 'seed-b', 'bbbb', 'B', 5)`, [i.orgA, i.orgB]);
  await q(`INSERT INTO community_facilities (tenant_id, name, kind) VALUES ($1, 'A hall', 'hall'), ($2, 'B hall', 'hall')`, [i.orgA, i.orgB]);
  await q(`INSERT INTO community_policies (tenant_id, key, value) VALUES ($1, 'quiet_hours', '"a"'), ($2, 'quiet_hours', '"b"')`, [i.orgA, i.orgB]);
  await q(`INSERT INTO community_status_history (tenant_id, to_status) VALUES ($1, 'draft'), ($2, 'draft')`, [i.orgA, i.orgB]);
  await q(`INSERT INTO community_branding (tenant_id, palette) VALUES ($1, 'forest'), ($2, 'ocean')`, [i.orgA, i.orgB]);
  await q(`INSERT INTO community_banners (tenant_id, title) VALUES ($1, 'A news'), ($2, 'B news')`, [i.orgA, i.orgB]);
  const mk = (sql: string, params: unknown[]) => q(sql, params);
  await mk(`INSERT INTO vendor_profiles (tenant_id) VALUES ($1), ($2)`, [i.orgA, i.orgB]);
  await mk(`INSERT INTO vendor_private (tenant_id, contact_name) VALUES ($1, 'A'), ($2, 'B')`, [i.orgA, i.orgB]);
  await mk(`INSERT INTO vendor_internal_notes (tenant_id, notes) VALUES ($1, 'a'), ($2, 'b')`, [i.orgA, i.orgB]);
  await mk(`INSERT INTO vendor_status_history (tenant_id, to_status) VALUES ($1, 'draft'), ($2, 'draft')`, [i.orgA, i.orgB]);
  await mk(`INSERT INTO vendor_categories (tenant_id, category_id) SELECT t, (SELECT id FROM categories WHERE key = 'coding') FROM unnest($1::uuid[]) t`, [[i.orgA, i.orgB]]);
  await mk(`INSERT INTO vendor_service_areas (tenant_id, city) VALUES ($1, 'CityA'), ($2, 'CityB')`, [i.orgA, i.orgB]);
  await mk(`INSERT INTO vendor_documents (tenant_id, requirement_key, title) VALUES ($1, 'identity_proof', 'A doc'), ($2, 'identity_proof', 'B doc')`, [i.orgA, i.orgB]);
  await mk(`INSERT INTO vendor_vetting_summary (tenant_id, complete) VALUES ($1, true), ($2, true)`, [i.orgA, i.orgB]);
  await mk(
    `INSERT INTO requests (tenant_id, requester_id, request_type_id, schema_version, title)
     SELECT t, u, (SELECT id FROM request_types ORDER BY key LIMIT 1), 1, 'Fixture request' FROM (VALUES ($1::uuid, $2::uuid), ($3::uuid, $4::uuid)) AS v (t, u)`,
    [i.orgA, i.alice, i.orgB, i.bob],
  );
  for (const org of [i.orgA, i.orgB]) {
    const req = `(SELECT id FROM requests WHERE tenant_id = $1 LIMIT 1)`;
    await mk(`INSERT INTO request_matches (tenant_id, request_id, vendor_id, score, source) VALUES ($1, ${req}, $1, 60, 'auto')`, [org]);
    await mk(`INSERT INTO inquiries (tenant_id, request_id, vendor_id, snapshot) VALUES ($1, ${req}, $1, '{}'::jsonb)`, [org]);
    await mk(`INSERT INTO quotes (tenant_id, request_id, inquiry_id, vendor_id, total_minor) VALUES ($1, ${req}, (SELECT id FROM inquiries WHERE tenant_id = $1 LIMIT 1), $1, 1000)`, [org]);
    await mk(`INSERT INTO quote_line_items (tenant_id, quote_id, description, unit_minor) VALUES ($1, (SELECT id FROM quotes WHERE tenant_id = $1 LIMIT 1), 'Fixture', 1000)`, [org]);
    await mk(`INSERT INTO bookings (tenant_id, request_id, quote_id, vendor_id, agreed_total_minor) VALUES ($1, ${req}, (SELECT id FROM quotes WHERE tenant_id = $1 LIMIT 1), $1, 1000)`, [org]);
    await mk(`INSERT INTO booking_payments (tenant_id, booking_id, kind, amount_minor, method, paid_on) VALUES ($1, (SELECT id FROM bookings WHERE tenant_id = $1 LIMIT 1), 'family_to_vendor', 500, 'cash', current_date)`, [org]);
  }
  await mk(`INSERT INTO reviews (tenant_id, booking_id, vendor_id, requester_id, rating) SELECT b.tenant_id, b.id, b.vendor_id, CASE WHEN b.tenant_id = $1 THEN $2::uuid ELSE $4::uuid END, 4 FROM bookings b WHERE b.tenant_id = ANY(ARRAY[$1, $3]::uuid[])`, [i.orgA, i.alice, i.orgB, i.bob]);
  await mk(`INSERT INTO vendor_availability_rules (tenant_id, weekday, start_time, end_time) VALUES ($1, 1, '09:00', '12:00'), ($2, 1, '09:00', '12:00')`, [i.orgA, i.orgB]);
  await mk(`INSERT INTO vendor_unavailable_blocks (tenant_id, starts_at, ends_at) VALUES ($1, now(), now() + interval '1 day'), ($2, now(), now() + interval '1 day')`, [i.orgA, i.orgB]);
  await mk(`INSERT INTO community_vendor_approvals (tenant_id, vendor_id, status) VALUES ($1, $2, 'approved'), ($2, $1, 'approved')`, [i.orgA, i.orgB]);
  await mk(`INSERT INTO offerings (tenant_id, category_id, name, pricing_model, price_minor) SELECT t, (SELECT id FROM categories WHERE key = 'coding'), 'Class', 'fixed', 100 FROM unnest($1::uuid[]) t`, [[i.orgA, i.orgB]]);
  await mk(
    `INSERT INTO concerns (tenant_id, reporter_id, category, subject, details)
       SELECT $1::uuid, $2::uuid, 'other', 'Fixture', 'Fixture' UNION ALL SELECT $3::uuid, $4::uuid, 'other', 'Fixture', 'Fixture'`,
    [i.orgA, i.alice, i.orgB, i.bob],
  );
  await mk(
    `INSERT INTO saved_offerings (tenant_id, user_id, offering_id)
       SELECT $1::uuid, $2::uuid, (SELECT id FROM offerings WHERE tenant_id = $1::uuid LIMIT 1)
       UNION ALL SELECT $3::uuid, $4::uuid, (SELECT id FROM offerings WHERE tenant_id = $3::uuid LIMIT 1)`,
    [i.orgA, i.alice, i.orgB, i.bob],
  );
  await q(
    `INSERT INTO roles (tenant_id, scope_type, key, name) VALUES
       ($1, 'community', 'a_custom', 'A custom'), ($2, 'community', 'b_custom', 'B custom')`,
    [i.orgA, i.orgB],
  );
  await q(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id)
       SELECT $1::uuid, $2::uuid, id FROM roles WHERE key = 'resident' AND tenant_id IS NULL
       UNION ALL SELECT $3::uuid, $4::uuid, id FROM roles WHERE key = 'resident' AND tenant_id IS NULL`,
    [i.orgA, i.alice, i.orgB, i.bob],
  );
  await q(
    `INSERT INTO audit_log (tenant_id, action) VALUES ($1, 'a_event'), ($2, 'b_event'), (NULL, 'platform_event')`,
    [i.orgA, i.orgB],
  );
  return i;
}

beforeAll(async () => {
  db = await createTestDb();
  ids = await arrange();
});
afterAll(async () => {
  await db.close();
});

describe("database role safety", () => {
  it("the application role cannot bypass RLS and is not a superuser", async () => {
    const { rows } = await db.app.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("the application role owns no tables", async () => {
    const { rows } = await db.admin.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner LIKE 'kidos_app%'`,
    );
    expect(rows[0].n).toBe(0);
  });
});

describe("structural checks", () => {
  it("every public table has forced RLS and at least one policy, unless explicitly global", async () => {
    const { rows } = await db.admin.query<{
      table_name: string;
      rls: boolean;
      forced: boolean;
      policies: number;
    }>(`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`);
    const offenders = rows
      .filter((r) => !GLOBAL_TABLES.has(r.table_name))
      .filter((r) => !(r.rls && r.forced && r.policies > 0))
      .map((r) => r.table_name);
    expect(offenders).toEqual([]);
  });

  it("every table with a tenant_id column has an isolation fixture in this suite", async () => {
    const { rows } = await db.admin.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenant_id'`);
    const missing = rows.map((r) => r.table_name).filter((t) => !(t in TENANT_TABLES));
    expect(missing).toEqual([]);
  });
});

describe.each(Object.entries(TENANT_TABLES))("tenant isolation: %s", (table, probe) => {
  it("tenant A sees no tenant B rows", async () => {
    const rows = await withContext(db.app, { tenantId: ids.orgA, userId: ids.alice }, async (c) =>
      (await c.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1`, [ids.orgB])).rowCount,
    );
    expect(rows).toBe(0);
  });

  it("no tenant context sees no tenant-owned rows", async () => {
    const own = await withContext(db.app, {}, async (c) =>
      (await c.query(`SELECT 1 FROM ${table} WHERE tenant_id IS NOT NULL`)).rowCount,
    );
    // role_assignments and memberships are also visible to their own user; with no user either, none.
    expect(own).toBe(0);
  });

  it("tenant A cannot insert a row owned by tenant B", async () => {
    await expect(
      withContext(db.app, { tenantId: ids.orgA, userId: ids.alice }, (c) =>
        c.query(probe.insertForTenant, probe.insertForTenant.includes("$2") ? [ids.orgB, ids.alice] : [ids.orgB]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  if (probe.mutable) {
    it("tenant A cannot update or delete tenant B rows", async () => {
      const result = await withContext(
        db.app,
        { tenantId: ids.orgA, userId: ids.alice },
        async (c) => {
          let upd: number | null = 0;
          if (probe.updatable !== false) {
            upd = (
              await c.query(`UPDATE ${table} SET tenant_id = tenant_id WHERE tenant_id = $1`, [
                ids.orgB,
              ])
            ).rowCount;
          }
          const del = probe.deletable === false ? { rowCount: 0 } : await c.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [ids.orgB]);
          return { upd, del: del.rowCount };
        },
      );
      expect(result).toEqual({ upd: 0, del: 0 });
      const survived = await db.admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [
        ids.orgB,
      ]);
      expect(survived.rows[0].n).toBeGreaterThan(0);
    });
  }
});

describe("visibility specifics", () => {
  it("tenant A sees its own data (the audit trail only with the audit.read permission)", async () => {
    const plain = await withContext(db.app, { tenantId: ids.orgA, userId: ids.alice }, async (c) => ({
      profiles: (await c.query("SELECT city FROM community_profiles")).rows,
      orgs: (await c.query("SELECT name FROM organizations")).rows,
      audit: (await c.query("SELECT action FROM audit_log ORDER BY action")).rows,
    }));
    expect(plain.profiles).toEqual([{ city: "CityA" }]);
    expect(plain.orgs).toEqual([{ name: "Community A" }]);
    expect(plain.audit).toEqual([]); // being a member is not enough to read the audit trail

    const auditor = await withContext(db.app, { tenantId: ids.orgA, userId: ids.alice, permissions: ["audit.read"] }, async (c) =>
      (await c.query("SELECT action FROM audit_log ORDER BY action")).rows,
    );
    expect(auditor).toEqual([{ action: "a_event" }]); // platform-level (NULL tenant) events stay hidden from tenants
  });

  it("system roles are visible to every tenant, other tenants' custom roles are not", async () => {
    const keys = await withContext(db.app, { tenantId: ids.orgA, userId: ids.alice }, async (c) =>
      (await c.query("SELECT key FROM roles")).rows.map((r) => r.key as string),
    );
    expect(keys).toContain("resident");
    expect(keys).toContain("a_custom");
    expect(keys).not.toContain("b_custom");
  });

  it("a user sees roles assigned to them in any tenant, but not other roles of other tenants", async () => {
    await db.admin.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id)
       SELECT $1, $2, id FROM roles WHERE key = 'b_custom'`,
      [ids.orgB, ids.bob],
    );
    const bobKeys = await withContext(db.app, { userId: ids.bob }, async (c) =>
      (await c.query("SELECT key FROM roles")).rows.map((r) => r.key as string),
    );
    expect(bobKeys).toContain("b_custom"); // assigned to Bob, visible without an active tenant
    expect(bobKeys).not.toContain("a_custom"); // belongs to tenant A, not assigned to Bob
  });

  it("users are visible only to themselves and fellow members of the active tenant", async () => {
    const emails = await withContext(db.app, { tenantId: ids.orgA, userId: ids.alice }, async (c) =>
      (await c.query("SELECT email FROM users ORDER BY email")).rows.map((r) => r.email as string),
    );
    expect(emails).toEqual(["alice@example.test"]);
  });

  it("the active tenant decides which tenant data is visible, not the user's other memberships", async () => {
    // Alice belongs to A. Under tenant context B she still sees the organization row of A (she is a member),
    // but none of A's tenant-owned data.
    const out = await withContext(db.app, { tenantId: ids.orgB, userId: ids.alice }, async (c) => ({
      orgs: (await c.query("SELECT name FROM organizations ORDER BY name")).rows.map((r) => r.name as string),
      profiles: (await c.query("SELECT city FROM community_profiles")).rows,
    }));
    expect(out.orgs).toEqual(["Community A", "Community B"]);
    expect(out.profiles).toEqual([{ city: "CityB" }]);
  });

  it("KNOWN LIMITATION: the database trusts app.tenant_id; membership is validated by the application", async () => {
    // Bob is not a member of A, yet naming A as the active tenant exposes A's data. Preventing this is the job of the
    // tenant-context middleware (Milestone 2.2), which must verify an active membership before calling withContext.
    // This test documents the boundary so it is not mistaken for a database guarantee.
    const profiles = await withContext(db.app, { tenantId: ids.orgA, userId: ids.bob }, async (c) =>
      (await c.query("SELECT city FROM community_profiles")).rows,
    );
    expect(profiles).toEqual([{ city: "CityA" }]);
  });

  it("the audit log is append-only for the application role", async () => {
    await expect(
      withContext(db.app, { tenantId: ids.orgA, userId: ids.alice }, (c) =>
        c.query("UPDATE audit_log SET action = 'tampered'"),
      ),
    ).rejects.toThrow();
    await expect(
      withContext(db.app, { tenantId: ids.orgA, userId: ids.alice }, (c) => c.query("DELETE FROM audit_log")),
    ).rejects.toThrow();
  });

  it("only the application can append to the audit log within its own tenant", async () => {
    await withContext(db.app, { tenantId: ids.orgA, userId: ids.alice }, (c) =>
      c.query("INSERT INTO audit_log (tenant_id, actor_user_id, action) VALUES ($1, $2, 'ok')", [ids.orgA, ids.alice]),
    );
    const n = await db.admin.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'ok'");
    expect(n.rows[0].n).toBe(1);
  });
});

describe("credentials and sessions", () => {
  it("a user can see only their own credentials and sessions", async () => {
    await db.admin.query(
      `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, 'h1'), ($2, 'h2')`,
      [ids.alice, ids.bob],
    );
    await db.admin.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES
         ($1, 'hash-alice', now() + interval '1 day'), ($2, 'hash-bob', now() + interval '1 day')`,
      [ids.alice, ids.bob],
    );
    const out = await withContext(db.app, { userId: ids.alice }, async (c) => ({
      creds: (await c.query("SELECT user_id FROM user_credentials")).rows,
      sessions: (await c.query("SELECT token_hash FROM sessions")).rows,
    }));
    expect(out.creds).toEqual([{ user_id: ids.alice }]);
    expect(out.sessions).toEqual([{ token_hash: "hash-alice" }]);
  });

  it("without an identity nothing in credentials or sessions is visible", async () => {
    const out = await withContext(db.app, {}, async (c) => ({
      creds: (await c.query("SELECT 1 FROM user_credentials")).rowCount,
      sessions: (await c.query("SELECT 1 FROM sessions")).rowCount,
    }));
    expect(out).toEqual({ creds: 0, sessions: 0 });
  });

  it("a session is found by its token hash alone, and only that one", async () => {
    const rows = await withContext(db.app, { sessionTokenHash: "hash-bob" }, async (c) =>
      (await c.query("SELECT user_id FROM sessions")).rows,
    );
    expect(rows).toEqual([{ user_id: ids.bob }]);
  });

  it("a user is found by login email alone, and only that one", async () => {
    const rows = await withContext(db.app, { loginEmail: "Bob@Example.test" }, async (c) =>
      (await c.query("SELECT id FROM users")).rows,
    );
    expect(rows).toEqual([{ id: ids.bob }]);
  });

  it("a user cannot change another user's credentials or hijack their session", async () => {
    const out = await withContext(db.app, { userId: ids.alice }, async (c) => ({
      creds: (await c.query("UPDATE user_credentials SET failed_attempts = 99 WHERE user_id = $1", [ids.bob])).rowCount,
      sess: (await c.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1", [ids.bob])).rowCount,
    }));
    expect(out).toEqual({ creds: 0, sess: 0 });
  });

  it("the application role cannot rewrite session ownership or the token hash", async () => {
    await expect(
      withContext(db.app, { userId: ids.alice }, (c) =>
        c.query("UPDATE sessions SET user_id = $1 WHERE user_id = $2", [ids.bob, ids.alice]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("a session cannot be created for someone else", async () => {
    await expect(
      withContext(db.app, { userId: ids.alice }, (c) =>
        c.query("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, 'x', now() + interval '1 day')", [ids.bob]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("MFA, one-time tokens and column grants", () => {
  it("MFA secrets and recovery codes are visible only to their owner", async () => {
    await db.admin.query(`INSERT INTO mfa_credentials (user_id, secret_encrypted) VALUES ($1, 'enc-a'), ($2, 'enc-b')`, [
      ids.alice,
      ids.bob,
    ]);
    await db.admin.query(`INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, 'ra'), ($2, 'rb')`, [ids.alice, ids.bob]);
    const out = await withContext(db.app, { userId: ids.alice }, async (c) => ({
      creds: (await c.query("SELECT user_id FROM mfa_credentials")).rows,
      codes: (await c.query("SELECT code_hash FROM mfa_recovery_codes")).rows,
      steal: (await c.query("UPDATE mfa_credentials SET failed_attempts = 0 WHERE user_id = $1", [ids.bob])).rowCount,
    }));
    expect(out.creds).toEqual([{ user_id: ids.alice }]);
    expect(out.codes).toEqual([{ code_hash: "ra" }]);
    expect(out.steal).toBe(0);
    const anon = await withContext(db.app, {}, async (c) => (await c.query("SELECT 1 FROM mfa_credentials")).rowCount);
    expect(anon).toBe(0);
  });

  it("a one-time token is visible by its hash alone, and its owner can only mark it used", async () => {
    await db.admin.query(
      `INSERT INTO one_time_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, 'password_reset', 'tok-alice', now() + interval '1 hour')`,
      [ids.alice],
    );
    const byHash = await withContext(db.app, { tokenHash: "tok-alice" }, async (c) =>
      (await c.query("SELECT user_id FROM one_time_tokens")).rows,
    );
    expect(byHash).toEqual([{ user_id: ids.alice }]);
    const other = await withContext(db.app, { userId: ids.bob }, async (c) =>
      (await c.query("SELECT 1 FROM one_time_tokens")).rowCount,
    );
    expect(other).toBe(0);
    await expect(
      withContext(db.app, { userId: ids.alice }, (c) => c.query("UPDATE one_time_tokens SET expires_at = now() + interval '10 years'")),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("the application role cannot rewrite a user's email, status or id", async () => {
    for (const col of ["email = 'x@example.test'", "status = 'active'", "id = id"]) {
      await expect(
        withContext(db.app, { userId: ids.alice }, (c) => c.query(`UPDATE users SET ${col} WHERE id = $1`, [ids.alice])),
      ).rejects.toMatchObject({ code: "42501" });
    }
    await withContext(db.app, { userId: ids.alice }, (c) =>
      c.query("UPDATE users SET display_name = 'Alice B', email_verified_at = now() WHERE id = $1", [ids.alice]),
    );
  });

  it("MFA-requiring roles are flagged as data", async () => {
    const { rows } = await db.admin.query<{ key: string; requires_mfa: boolean }>(
      "SELECT key, requires_mfa FROM roles WHERE tenant_id IS NULL",
    );
    const flag = (k: string) => rows.find((r) => r.key === k)?.requires_mfa;
    // vendor owners and administrators were added in migration 0011 (they handle vetting documents about people)
    for (const k of ["super_admin", "platform_admin", "business_operations", "finance", "community_admin", "vendor_owner", "vendor_admin"]) {
      expect(flag(k), k).toBe(true);
    }
    for (const k of ["resident", "parent_guardian", "vendor_staff", "vendor_service_provider"]) expect(flag(k), k).toBe(false);
  });
});

describe("community directory", () => {
  let activeOrg: string;
  beforeAll(async () => {
    activeOrg = randomUUID();
    await db.admin.query("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'community', 'Open Community', 'active')", [activeOrg]);
    await db.admin.query("INSERT INTO community_profiles (tenant_id, city, locality) VALUES ($1, 'Pune', 'Baner')", [activeOrg]);
    await db.admin.query("INSERT INTO community_private (tenant_id, address, contact_email) VALUES ($1, '12 Secret Lane', 'admin@open.test')", [activeOrg]);
  });

  it("any signed-in user sees ACTIVE communities and their public profile, but not draft ones", async () => {
    const out = await withContext(db.app, { userId: ids.bob }, async (c) => ({
      orgs: (await c.query("SELECT name FROM organizations WHERE type = 'community' ORDER BY name")).rows.map((r) => r.name as string),
      profile: (await c.query("SELECT city FROM community_profiles WHERE tenant_id = $1", [activeOrg])).rows,
    }));
    expect(out.orgs).toContain("Open Community");
    expect(out.orgs).not.toContain("Community A");
    expect(out.profile).toEqual([{ city: "Pune" }]);
  });

  it("the directory never exposes private details, facilities, policies or history", async () => {
    const out = await withContext(db.app, { userId: ids.bob }, async (c) => ({
      priv: (await c.query("SELECT 1 FROM community_private WHERE tenant_id = $1", [activeOrg])).rowCount,
      fac: (await c.query("SELECT 1 FROM community_facilities WHERE tenant_id = $1", [activeOrg])).rowCount,
    }));
    expect(out).toEqual({ priv: 0, fac: 0 });
  });

  it("anonymous (no user) sees no communities at all", async () => {
    const n = await withContext(db.app, {}, async (c) => (await c.query("SELECT 1 FROM organizations WHERE type = 'community'")).rowCount);
    expect(n).toBe(0);
  });

  it("a suspended community disappears from the directory", async () => {
    await db.admin.query("UPDATE organizations SET status = 'suspended' WHERE id = $1", [activeOrg]);
    const n = await withContext(db.app, { userId: ids.bob }, async (c) =>
      (await c.query("SELECT 1 FROM organizations WHERE id = $1", [activeOrg])).rowCount,
    );
    expect(n).toBe(0);
    await db.admin.query("UPDATE organizations SET status = 'active' WHERE id = $1", [activeOrg]);
  });

  it("policy definitions are readable by signed-in users only, and cannot be changed by the app role", async () => {
    const anon = await withContext(db.app, {}, async (c) => (await c.query("SELECT 1 FROM policy_definitions")).rowCount);
    expect(anon).toBe(0);
    const keys = await withContext(db.app, { userId: ids.bob }, async (c) => (await c.query("SELECT key FROM policy_definitions")).rows.map((r) => r.key as string));
    expect(keys).toContain("resident_join_mode");
    await expect(
      withContext(db.app, { userId: ids.bob }, (c) => c.query("UPDATE policy_definitions SET default_value = 'false'::jsonb")),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("membership rules enforced by the database", () => {
  let active: string; // an ACTIVE community
  let admin: string; // holds community_admin (memberships.approve) in it
  let resident: string; // plain member
  let outsider: string; // not a member
  let other: string; // another user
  const roleId = async (key: string) => (await db.admin.query<{ id: string }>("SELECT id FROM roles WHERE key = $1 AND tenant_id IS NULL", [key])).rows[0]?.id as string;
  // The community administrator's verified permissions, as the API would supply them.
  const ADMIN_PERMS = ["memberships.approve", "communities.read", "communities.update"];
  const ctx = (userId: string, tokenHash?: string) => ({ tenantId: active, userId, tokenHash, permissions: userId === admin ? ADMIN_PERMS : undefined });
  const insertMembership = (c: PoolClient, userId: string, status: string, method: string) =>
    c.query("INSERT INTO memberships (tenant_id, user_id, status, join_method) VALUES ($1, $2, $3, $4)", [active, userId, status, method]);
  const mkCode = async (hash: string, over: Partial<{ max: number; uses: number; expires: string | null; revoked: boolean; tenant: string }> = {}) =>
    db.admin.query(
      `INSERT INTO invite_codes (tenant_id, code_hash, code_hint, label, max_uses, uses, expires_at, revoked_at)
       VALUES ($1, $2, 'wxyz', 'Test', $3, $4, $5, $6)`,
      [over.tenant ?? active, hash, over.max ?? 5, over.uses ?? 0, over.expires ?? null, over.revoked ? new Date() : null],
    );

  beforeAll(async () => {
    active = randomUUID();
    await db.admin.query("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'community', 'Joinable', 'active')", [active]);
    [admin, resident, outsider, other] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const [id, n] of [[admin, "adm"], [resident, "res"], [outsider, "out"], [other, "oth"]] as const) {
      await db.admin.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)", [id, `${n}@member-rules.test`, n]);
    }
    await db.admin.query("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2), ($1, $3)", [active, admin, resident]);
    await db.admin.query("INSERT INTO role_assignments (tenant_id, user_id, role_id) VALUES ($1, $2, $3), ($1, $4, $5)", [active, admin, await roleId("community_admin"), resident, await roleId("resident")]);
  });

  it("a stranger cannot make themselves a member, active or otherwise, without a valid invite code", async () => {
    for (const [status, method] of [["active", "invite_code"], ["active", "admin_approval"], ["active", "admin_added"], ["pending", "admin_added"]] as const) {
      await expect(withContext(db.app, ctx(outsider), (c) => insertMembership(c, outsider, status, method)), `${status}/${method}`).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("a stranger can ask to join an active community, but only as themselves and only as pending", async () => {
    await withContext(db.app, ctx(outsider), (c) => insertMembership(c, outsider, "pending", "admin_approval"));
    await expect(withContext(db.app, ctx(outsider), (c) => insertMembership(c, other, "pending", "admin_approval"))).rejects.toMatchObject({ code: "42501" });
    await db.admin.query("DELETE FROM memberships WHERE tenant_id = $1 AND user_id = $2", [active, outsider]);
  });

  it("nobody can join a community that is not active, even asking nicely", async () => {
    await expect(
      withContext(db.app, { tenantId: ids.orgA, userId: outsider }, (c) => c.query("INSERT INTO memberships (tenant_id, user_id, status, join_method) VALUES ($1, $2, 'pending', 'admin_approval')", [ids.orgA, outsider])),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("an invite code admits only while valid, only for its own community, and only for the person presenting it", async () => {
    await mkCode("good-code");
    await mkCode("expired-code", { expires: "2000-01-01T00:00:00Z" });
    await mkCode("revoked-code", { revoked: true });
    await mkCode("used-up-code", { max: 1, uses: 1 });
    await mkCode("other-tenant-code", { tenant: ids.orgA });

    for (const bad of ["expired-code", "revoked-code", "used-up-code", "other-tenant-code", "no-such-code"]) {
      await expect(withContext(db.app, ctx(outsider, bad), (c) => insertMembership(c, outsider, "active", "invite_code")), bad).rejects.toMatchObject({ code: "42501" });
    }
    await expect(withContext(db.app, ctx(outsider, "good-code"), (c) => insertMembership(c, other, "active", "invite_code"))).rejects.toMatchObject({ code: "42501" });
    await withContext(db.app, ctx(outsider, "good-code"), (c) => insertMembership(c, outsider, "active", "invite_code"));
    await db.admin.query("DELETE FROM memberships WHERE tenant_id = $1 AND user_id = $2", [active, outsider]);
  });

  it("a code holder may use up a valid code but cannot un-revoke it, resurrect an expired one, or edit its limits", async () => {
    const used = await withContext(db.app, ctx(outsider, "good-code"), async (c) =>
      (await c.query("UPDATE invite_codes SET uses = uses + 1 WHERE code_hash = 'good-code'")).rowCount,
    );
    expect(used).toBe(1);
    for (const hash of ["revoked-code", "expired-code"]) {
      const n = await withContext(db.app, ctx(outsider, hash), async (c) => (await c.query("UPDATE invite_codes SET revoked_at = NULL, uses = 0 WHERE code_hash = $1", [hash])).rowCount);
      expect(n, hash).toBe(0);
    }
    await expect(
      withContext(db.app, ctx(outsider, "good-code"), (c) => c.query("UPDATE invite_codes SET max_uses = 10000 WHERE code_hash = 'good-code'")),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("a pending member cannot approve themselves, but can withdraw", async () => {
    await db.admin.query("INSERT INTO memberships (tenant_id, user_id, status, join_method) VALUES ($1, $2, 'pending', 'admin_approval')", [active, other]);
    await expect(
      withContext(db.app, ctx(other), (c) => c.query("UPDATE memberships SET status = 'active' WHERE tenant_id = $1 AND user_id = $2", [active, other])),
    ).rejects.toMatchObject({ code: "42501" });
    await withContext(db.app, ctx(other), (c) => c.query("UPDATE memberships SET status = 'removed' WHERE tenant_id = $1 AND user_id = $2", [active, other]));
    await db.admin.query("UPDATE memberships SET status = 'pending' WHERE tenant_id = $1 AND user_id = $2", [active, other]);
  });

  it("a community administrator can approve members and grant resident roles, but not admin-level roles", async () => {
    await withContext(db.app, ctx(admin), async (c) => {
      const ok = await c.query("UPDATE memberships SET status = 'active', decided_by = $3 WHERE tenant_id = $1 AND user_id = $2", [active, other, admin]);
      expect(ok.rowCount).toBe(1);
      await c.query("INSERT INTO role_assignments (tenant_id, user_id, role_id) VALUES ($1, $2, $3)", [active, other, await roleId("resident")]);
    });
    for (const key of ["community_admin", "business_operations", "super_admin"]) {
      await expect(
        withContext(db.app, ctx(admin), async (c) => c.query("INSERT INTO role_assignments (tenant_id, user_id, role_id) VALUES ($1, $2, $3)", [active, other, await roleId(key)])),
        key,
      ).rejects.toMatchObject({ code: "42501" });
    }
    // removing resident-level roles is allowed; removing an admin's role is not
    const removed = await withContext(db.app, ctx(admin), async (c) =>
      (await c.query("DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2 AND role_id = $3", [active, other, await roleId("resident")])).rowCount,
    );
    expect(removed).toBe(1);
    const adminRoleRemoved = await withContext(db.app, ctx(admin), async (c) =>
      (await c.query("DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2", [active, admin])).rowCount,
    );
    expect(adminRoleRemoved).toBe(0);
  });

  it("an ordinary member cannot add members, approve anyone, or give themselves or others admin roles", async () => {
    await expect(withContext(db.app, ctx(resident), (c) => insertMembership(c, outsider, "active", "admin_added"))).rejects.toMatchObject({ code: "42501" });
    await expect(withContext(db.app, ctx(resident), async (c) => c.query("INSERT INTO role_assignments (tenant_id, user_id, role_id) VALUES ($1, $2, $3)", [active, resident, await roleId("community_admin")]))).rejects.toMatchObject({ code: "42501" });
    await expect(withContext(db.app, ctx(resident), async (c) => c.query("INSERT INTO role_assignments (tenant_id, user_id, role_id) VALUES ($1, $2, $3)", [active, other, await roleId("resident")]))).rejects.toMatchObject({ code: "42501" });
  });

  it("a person may give themselves resident-level roles only for a membership that is already active", async () => {
    await db.admin.query("UPDATE memberships SET status = 'pending' WHERE tenant_id = $1 AND user_id = $2", [active, other]);
    await expect(withContext(db.app, ctx(other), async (c) => c.query("INSERT INTO role_assignments (tenant_id, user_id, role_id) VALUES ($1, $2, $3)", [active, other, await roleId("resident")]))).rejects.toMatchObject({ code: "42501" });
    await db.admin.query("UPDATE memberships SET status = 'active' WHERE tenant_id = $1 AND user_id = $2", [active, other]);
    await withContext(db.app, ctx(other), async (c) => c.query("INSERT INTO role_assignments (tenant_id, user_id, role_id) VALUES ($1, $2, $3)", [active, other, await roleId("parent_guardian")]));
  });

  it("only staff can create or list invite codes, and a stranger sees none", async () => {
    await withContext(db.app, ctx(admin), (c) => c.query("INSERT INTO invite_codes (tenant_id, code_hash, code_hint, label, max_uses) VALUES ($1, 'admin-made', 'abcd', 'Made', 3)", [active]));
    await expect(withContext(db.app, ctx(resident), (c) => c.query("INSERT INTO invite_codes (tenant_id, code_hash, code_hint, label, max_uses) VALUES ($1, 'res-made', 'abcd', 'Made', 3)", [active]))).rejects.toMatchObject({ code: "42501" });
    const seen = await withContext(db.app, { userId: outsider }, async (c) => (await c.query("SELECT 1 FROM invite_codes")).rowCount);
    expect(seen).toBe(0);
  });
});

describe("least-privilege reads", () => {
  let community: string;
  let staff: string; // community administrator
  let neighbour: string; // ordinary resident
  let me: string; // ordinary resident under test
  const STAFF_PERMS = ["memberships.approve", "communities.read", "audit.read"];

  beforeAll(async () => {
    community = randomUUID();
    [staff, neighbour, me] = [randomUUID(), randomUUID(), randomUUID()];
    await db.admin.query("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'community', 'Privacy Park', 'active')", [community]);
    for (const [id, n] of [[staff, "pstaff"], [neighbour, "pneighbour"], [me, "pme"]] as const) {
      await db.admin.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)", [id, `${n}@least-privilege.test`, n]);
      await db.admin.query("INSERT INTO memberships (tenant_id, user_id, unit_label) VALUES ($1, $2, $3)", [community, id, `unit-${n}`]);
    }
    const role = async (key: string) => (await db.admin.query<{ id: string }>("SELECT id FROM roles WHERE key = $1 AND tenant_id IS NULL", [key])).rows[0]?.id;
    await db.admin.query("INSERT INTO role_assignments (tenant_id, user_id, role_id) VALUES ($1, $2, $3), ($1, $4, $5), ($1, $6, $5)", [community, staff, await role("community_admin"), neighbour, await role("resident"), me]);
    await db.admin.query("INSERT INTO community_private (tenant_id, address, contact_phone) VALUES ($1, '1 Secret Road', '+91 99999 00000')", [community]);
    await db.admin.query("INSERT INTO community_status_history (tenant_id, to_status) VALUES ($1, 'draft')", [community]);
    await db.admin.query("INSERT INTO community_internal_notes (tenant_id, notes) VALUES ($1, 'ops-only note')", [community]);
    await db.admin.query("INSERT INTO invite_codes (tenant_id, code_hash, code_hint, label, max_uses) VALUES ($1, 'lp-code', 'zzzz', 'Block Z', 5)", [community]);
    await db.admin.query("INSERT INTO audit_log (tenant_id, action) VALUES ($1, 'lp.event')", [community]);
  });

  const read = (userId: string, permissions?: string[]) =>
    withContext(db.app, { tenantId: community, userId, permissions }, async (c) => ({
      users: (await c.query("SELECT display_name FROM users ORDER BY display_name")).rows.map((r) => r.display_name as string),
      memberships: (await c.query("SELECT unit_label FROM memberships ORDER BY unit_label")).rows.map((r) => r.unit_label as string),
      roles: (await c.query("SELECT count(*)::int AS n FROM role_assignments")).rows[0].n as number,
      privateRows: (await c.query("SELECT 1 FROM community_private")).rowCount,
      history: (await c.query("SELECT 1 FROM community_status_history")).rowCount,
      codes: (await c.query("SELECT 1 FROM invite_codes")).rowCount,
      audit: (await c.query("SELECT 1 FROM audit_log")).rowCount,
      notes: (await c.query("SELECT 1 FROM community_internal_notes")).rowCount,
    }));

  it("an ordinary resident sees only themselves: no neighbours, no member list, no roles, no private details", async () => {
    // even with the API-supplied permissions of an ordinary resident
    const out = await read(me, ["catalog.read", "requests.create_own"]);
    expect(out).toEqual({ users: ["pme"], memberships: ["unit-pme"], roles: 1, privateRows: 0, history: 0, codes: 0, audit: 0, notes: 0 });
  });

  it("a context built WITHOUT permissions gets the least access by default, even for an administrator's own user", async () => {
    const out = await read(staff);
    expect(out).toEqual({ users: ["pstaff"], memberships: ["unit-pstaff"], roles: 1, privateRows: 0, history: 0, codes: 0, audit: 0, notes: 0 });
  });

  it("an administrator with the permissions sees the community's people, rules and records, but never the platform's notes", async () => {
    const out = await read(staff, STAFF_PERMS);
    expect(out.users).toEqual(["pme", "pneighbour", "pstaff"]);
    expect(out.memberships).toEqual(["unit-pme", "unit-pneighbour", "unit-pstaff"]);
    expect(out.roles).toBe(3);
    expect(out).toMatchObject({ privateRows: 1, history: 1, codes: 1, audit: 1, notes: 0 });
  });

  it("invite codes are listed only to people allowed to approve members", async () => {
    const out = await read(staff, ["memberships.approve"]);
    expect(out.codes).toBe(1);
    expect((await read(staff, ["communities.read"])).codes).toBe(0);
  });

  it("the platform's internal notes are visible to platform staff in platform scope and nobody else", async () => {
    const platformStaffUser = randomUUID();
    await db.admin.query("INSERT INTO users (id, email, display_name) VALUES ($1, 'pstaffer@least-privilege.test', 'pstaffer')", [platformStaffUser]);
    await db.admin.query("INSERT INTO platform_staff (user_id) VALUES ($1)", [platformStaffUser]);
    const seen = await withContext(db.app, { tenantId: community, userId: platformStaffUser, platformScope: true }, async (c) =>
      (await c.query("SELECT notes FROM community_internal_notes")).rows.map((r) => r.notes as string),
    );
    expect(seen).toContain("ops-only note");
    expect(seen.length).toBeGreaterThan(1); // platform scope sees every community's notes, not just one
    await expect(
      withContext(db.app, { tenantId: community, userId: staff, permissions: ["communities.update", "communities.read"] }, (c) =>
        c.query("INSERT INTO community_internal_notes (tenant_id, notes) VALUES ($1, 'sneaky')", [randomUUID()]),
      ),
    ).rejects.toThrow();
  });

  it("refuses a permission list that tries to smuggle in extra permissions", async () => {
    await expect(withContext(db.app, { userId: me, permissions: ["audit.read,memberships.approve"] }, (c) => c.query("SELECT 1"))).rejects.toThrow(/Invalid permission/);
    await expect(withContext(db.app, { userId: me, permissions: ["NOT VALID"] }, (c) => c.query("SELECT 1"))).rejects.toThrow(/Invalid permission/);
  });
});

describe("vendor visibility rules enforced by the database", () => {
  let community: string; // active community C, vendor approval required (the default)
  let otherCommunity: string; // active community D
  let resident: string; // member of C
  let stranger: string; // NOT a member of C
  let approver: string; // C's administrator
  const v: Record<string, string> = {};
  const offering: Record<string, string> = {};
  const catId = async (key: string) => (await db.admin.query<{ id: string }>("SELECT id FROM categories WHERE key = $1", [key])).rows[0]?.id as string;
  const asResident = (userId: string, ctxCommunity: string, perms: string[] = ["catalog.read"]) => ({ tenantId: ctxCommunity, userId, permissions: perms });

  const vendorNames = (c: PoolClient) => c.query("SELECT name FROM organizations WHERE type = 'vendor' ORDER BY name").then((r) => r.rows.map((x) => x.name as string));
  const offeringNames = (c: PoolClient) => c.query("SELECT name FROM offerings ORDER BY name").then((r) => r.rows.map((x) => x.name as string));

  beforeAll(async () => {
    [community, otherCommunity, resident, stranger, approver] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await db.admin.query("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'community', 'Catalog Community', 'active'), ($2, 'community', 'Other Community', 'active')", [community, otherCommunity]);
    for (const [id, n] of [[resident, "vres"], [stranger, "vstr"], [approver, "vapp"]] as const) {
      await db.admin.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)", [id, `${n}@vendor-visibility.test`, n]);
    }
    await db.admin.query("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2), ($1, $3)", [community, resident, approver]);

    // vendors: name -> (status, serves, approved)
    const spec: [string, string, string | null, boolean][] = [
      ["V1 approved and serving", "active", community, true],
      ["V2 active serving, not approved", "active", community, false],
      ["V3 active, serves elsewhere", "active", otherCommunity, true],
      ["V4 suspended, serving, approved", "suspended", community, true],
      ["V5 draft, serving, approved", "draft", community, true],
      ["V6 revoked", "active", community, false],
    ];
    const cat = await catId("magic_shows");
    for (const [name, status, serves, approved] of spec) {
      const id = randomUUID();
      v[name.slice(0, 2)] = id;
      await db.admin.query("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'vendor', $2, $3)", [id, name, status]);
      await db.admin.query("INSERT INTO vendor_profiles (tenant_id, tagline) VALUES ($1, $2)", [id, `tag ${name}`]);
      await db.admin.query("INSERT INTO vendor_private (tenant_id, contact_phone) VALUES ($1, '+91 11111 22222')", [id]);
      await db.admin.query("INSERT INTO vendor_vetting_summary (tenant_id, complete) VALUES ($1, true)", [id]); // fully vetted unless a test says otherwise
      if (serves) await db.admin.query("INSERT INTO vendor_service_areas (tenant_id, community_id) VALUES ($1, $2)", [id, serves]);
      if (approved && serves) await db.admin.query("INSERT INTO community_vendor_approvals (tenant_id, vendor_id, status) VALUES ($1, $2, 'approved')", [serves, id]);
      await db.admin.query("INSERT INTO offerings (tenant_id, category_id, name, pricing_model, price_minor, status) VALUES ($1, $2, $3, 'fixed', 500000, 'published'), ($1, $2, $4, 'fixed', 100, 'draft'), ($1, $2, $5, 'fixed', 100, 'archived')", [id, cat, `${name} / published`, `${name} / draft`, `${name} / archived`]);
    }
    await db.admin.query("INSERT INTO community_vendor_approvals (tenant_id, vendor_id, status) VALUES ($1, $2, 'revoked')", [community, v["V6"]]);
    await db.admin.query("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'community_admin' AND tenant_id IS NULL", [community, approver]);
    void offering;
  });

  it("a resident sees only vendors that are active, serve their community and are approved by it, and only published offerings", async () => {
    const out = await withContext(db.app, asResident(resident, community), async (c) => ({
      vendors: await vendorNames(c),
      offerings: await offeringNames(c),
      profiles: (await c.query("SELECT count(*)::int AS n FROM vendor_profiles")).rows[0].n as number,
    }));
    expect(out.vendors).toEqual(["V1 approved and serving"]);
    expect(out.offerings).toEqual(["V1 approved and serving / published"]); // not drafts, archived, unapproved, suspended, other community
    expect(out.profiles).toBe(1);
  });

  it("a resident never sees a vendor's private details, documents, notes or availability", async () => {
    const out = await withContext(db.app, asResident(resident, community, ["catalog.read", "vendors.read"]), async (c) => ({
      priv: (await c.query("SELECT 1 FROM vendor_private")).rowCount,
      notes: (await c.query("SELECT 1 FROM vendor_internal_notes")).rowCount,
      docs: (await c.query("SELECT 1 FROM vendor_documents")).rowCount,
      history: (await c.query("SELECT 1 FROM vendor_status_history")).rowCount,
      rules: (await c.query("SELECT 1 FROM vendor_availability_rules")).rowCount,
    }));
    expect(out).toEqual({ priv: 0, notes: 0, docs: 0, history: 0, rules: 0 });
  });

  it("revoking an approval hides the vendor immediately, and re-approving brings it back", async () => {
    await db.admin.query("UPDATE community_vendor_approvals SET status = 'revoked' WHERE tenant_id = $1 AND vendor_id = $2", [community, v["V1"]]);
    expect(await withContext(db.app, asResident(resident, community), vendorNames)).toEqual([]);
    await db.admin.query("UPDATE community_vendor_approvals SET status = 'approved' WHERE tenant_id = $1 AND vendor_id = $2", [community, v["V1"]]);
    expect(await withContext(db.app, asResident(resident, community), vendorNames)).toEqual(["V1 approved and serving"]);
  });

  it("a vendor whose vetting has lapsed, or was never recorded, is hidden from residents (the catalog fails closed)", async () => {
    const setSummary = (sql: string) => db.admin.query(sql, [v["V1"]]);
    const visible = async () => (await withContext(db.app, asResident(resident, community), vendorNames)).includes("V1 approved and serving");
    expect(await visible()).toBe(true);

    await setSummary("UPDATE vendor_vetting_summary SET complete = false WHERE tenant_id = $1");
    expect(await visible()).toBe(false); // a required document is missing
    await setSummary("UPDATE vendor_vetting_summary SET complete = true, valid_until = current_date - 1 WHERE tenant_id = $1");
    expect(await visible()).toBe(false); // it has expired
    await setSummary("UPDATE vendor_vetting_summary SET valid_until = current_date WHERE tenant_id = $1");
    expect(await visible()).toBe(true); // valid through the day it expires
    await setSummary("UPDATE vendor_vetting_summary SET valid_until = NULL WHERE tenant_id = $1");
    expect(await visible()).toBe(true); // nothing that expires

    await setSummary("DELETE FROM vendor_vetting_summary WHERE tenant_id = $1");
    expect(await visible()).toBe(false); // no record at all: not shown
    await setSummary("INSERT INTO vendor_vetting_summary (tenant_id, complete) VALUES ($1, true)");
    expect(await visible()).toBe(true);
    // its offerings go with it
    await setSummary("UPDATE vendor_vetting_summary SET complete = false WHERE tenant_id = $1");
    expect(await withContext(db.app, asResident(resident, community), offeringNames)).toEqual([]);
    await setSummary("UPDATE vendor_vetting_summary SET complete = true WHERE tenant_id = $1");
  });

  it("when a community turns the approval policy off, every active vendor serving it is visible, and still none that do not", async () => {
    await db.admin.query("INSERT INTO community_policies (tenant_id, key, value) VALUES ($1, 'vendor_approval_required', 'false'::jsonb)", [community]);
    const names = await withContext(db.app, asResident(resident, community), vendorNames);
    expect(names).toEqual(["V1 approved and serving", "V2 active serving, not approved", "V6 revoked"]);
    await db.admin.query("DELETE FROM community_policies WHERE tenant_id = $1 AND key = 'vendor_approval_required'", [community]);
    expect(await withContext(db.app, asResident(resident, community), vendorNames)).toEqual(["V1 approved and serving"]); // back to the safe default
  });

  it("naming a community you do not belong to reveals no vendors, even with the right-looking context", async () => {
    expect(await withContext(db.app, asResident(stranger, community), vendorNames)).toEqual([]);
    expect(await withContext(db.app, asResident(stranger, community), offeringNames)).toEqual([]);
    expect(await withContext(db.app, asResident(resident, otherCommunity), vendorNames)).toEqual([]); // member of C acting "as" D
  });

  it("a person with no community context sees no vendors at all", async () => {
    expect(await withContext(db.app, { userId: resident }, vendorNames)).toEqual([]);
  });

  it("a community approver sees every active vendor that serves the community (to decide about them), nothing else", async () => {
    const names = await withContext(db.app, { tenantId: community, userId: approver, permissions: ["community.approve_vendor"] }, vendorNames);
    expect(names).toEqual(["V1 approved and serving", "V2 active serving, not approved", "V6 revoked"]);
  });

  it("an approver can approve and revoke for their own community only, and a resident cannot decide", async () => {
    await withContext(db.app, { tenantId: community, userId: approver, permissions: ["community.approve_vendor"] }, (c) =>
      c.query("UPDATE community_vendor_approvals SET status = 'revoked' WHERE vendor_id = $1", [v["V1"]]),
    );
    await db.admin.query("UPDATE community_vendor_approvals SET status = 'approved' WHERE vendor_id = $1 AND tenant_id = $2", [v["V1"], community]);
    await expect(
      withContext(db.app, asResident(resident, community), (c) =>
        c.query("INSERT INTO community_vendor_approvals (tenant_id, vendor_id, status) VALUES ($1, $2, 'approved')", [community, v["V2"]]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withContext(db.app, { tenantId: otherCommunity, userId: approver, permissions: ["community.approve_vendor"] }, (c) =>
        c.query("INSERT INTO community_vendor_approvals (tenant_id, vendor_id, status) VALUES ($1, $2, 'approved')", [community, v["V2"]]),
      ),
    ).rejects.toMatchObject({ code: "42501" }); // another community's context cannot approve on this community's behalf
  });

  it("a vendor's own staff see their own drafts, but not another vendor's published offerings", async () => {
    const staff = randomUUID();
    await db.admin.query("INSERT INTO users (id, email, display_name) VALUES ($1, 'vstaff@vendor-visibility.test', 'vstaff')", [staff]);
    await db.admin.query("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [v["V2"], staff]);
    const names = await withContext(db.app, { tenantId: v["V2"], userId: staff, permissions: ["offerings.manage"] }, offeringNames);
    expect(names).toEqual(["V2 active serving, not approved / archived", "V2 active serving, not approved / draft", "V2 active serving, not approved / published"]);
    expect(names.some((n) => n.startsWith("V1"))).toBe(false);
  });

  it("vendor staff can submit documents but can never mark them verified; the platform can", async () => {
    const staff = randomUUID();
    await db.admin.query("INSERT INTO users (id, email, display_name) VALUES ($1, 'vdocs@vendor-visibility.test', 'vdocs')", [staff]);
    await db.admin.query("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [v["V2"], staff]);
    await db.admin.query("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'vendor_owner' AND tenant_id IS NULL", [v["V2"], staff]);
    const ctx = { tenantId: v["V2"], userId: staff, permissions: ["vendor_documents.manage", "vendors.read"] };
    const doc = await withContext(db.app, ctx, async (c) =>
      (await c.query("INSERT INTO vendor_documents (tenant_id, requirement_key, title) VALUES ($1, 'identity_proof', 'My ID') RETURNING id", [v["V2"]])).rows[0].id as string,
    );
    await expect(
      withContext(db.app, ctx, (c) => c.query("INSERT INTO vendor_documents (tenant_id, requirement_key, title, status) VALUES ($1, 'identity_proof', 'Self-verified', 'verified')", [v["V2"]])),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(withContext(db.app, ctx, (c) => c.query("UPDATE vendor_documents SET status = 'verified' WHERE id = $1", [doc]))).rejects.toMatchObject({ code: "42501" });
    expect((await db.admin.query("SELECT status FROM vendor_documents WHERE id = $1", [doc])).rows[0].status).toBe("submitted");

    const platformUser = randomUUID();
    await db.admin.query("INSERT INTO users (id, email, display_name) VALUES ($1, 'vplat@vendor-visibility.test', 'vplat')", [platformUser]);
    await db.admin.query("INSERT INTO platform_staff (user_id) VALUES ($1)", [platformUser]);
    await withContext(db.app, { tenantId: v["V2"], userId: platformUser, platformScope: true }, (c) =>
      c.query("UPDATE vendor_documents SET status = 'verified', reviewed_by = $2, reviewed_at = now() WHERE id = $1", [doc, platformUser]),
    );
    expect((await db.admin.query("SELECT status FROM vendor_documents WHERE id = $1", [doc])).rows[0].status).toBe("verified");
    // once verified it is locked against vendor edits
    await expect(withContext(db.app, ctx, (c) => c.query("UPDATE vendor_documents SET title = 'changed' WHERE id = $1", [doc]))).resolves.toBeDefined();
    expect((await db.admin.query("SELECT title FROM vendor_documents WHERE id = $1", [doc])).rows[0].title).toBe("My ID");
  });

  it("vendor staff managers can add staff to their own vendor with vendor roles only, never owners or community roles", async () => {
    const owner = randomUUID();
    const hire = randomUUID();
    for (const [id, n] of [[owner, "vowner"], [hire, "vhire"]] as const) {
      await db.admin.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)", [id, `${n}@vendor-visibility.test`, n]);
    }
    await db.admin.query("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [v["V1"], owner]);
    await db.admin.query("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'vendor_owner' AND tenant_id IS NULL", [v["V1"], owner]);
    const ctx = { tenantId: v["V1"], userId: owner, permissions: ["vendor_staff.manage", "vendors.read"] };
    const roleId = async (key: string) => (await db.admin.query<{ id: string }>("SELECT id FROM roles WHERE key = $1 AND tenant_id IS NULL", [key])).rows[0]?.id as string;

    await withContext(db.app, ctx, async (c) => {
      await c.query("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [v["V1"], hire]);
      await c.query("INSERT INTO role_assignments (tenant_id, user_id, role_id) VALUES ($1, $2, $3)", [v["V1"], hire, await roleId("vendor_staff")]);
    });
    for (const key of ["vendor_owner", "community_admin", "super_admin", "business_operations"]) {
      await expect(
        withContext(db.app, ctx, async (c) => c.query("INSERT INTO role_assignments (tenant_id, user_id, role_id) VALUES ($1, $2, $3)", [v["V1"], hire, await roleId(key)])),
        key,
      ).rejects.toMatchObject({ code: "42501" });
    }
    // ...and cannot reach into any other organization
    await expect(withContext(db.app, ctx, (c) => c.query("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [v["V2"], hire]))).rejects.toMatchObject({ code: "42501" });
    await expect(withContext(db.app, ctx, (c) => c.query("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [community, hire]))).rejects.toMatchObject({ code: "42501" });
  });

  it("the vetting summary follows the documents: complete only when every required requirement has a verified document, and it tracks the earliest expiry", async () => {
    const vendor = randomUUID();
    await db.admin.query("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'vendor', 'Summary Vendor', 'active')", [vendor]);
    const summary = async () => (await db.admin.query("SELECT complete, valid_until::text AS until FROM vendor_vetting_summary WHERE tenant_id = $1", [vendor])).rows[0];
    const doc = async (key: string, status: string, expires: string | null) =>
      (await db.admin.query<{ id: string }>("INSERT INTO vendor_documents (tenant_id, requirement_key, title, status, expires_on) VALUES ($1, $2, 'd', $3, $4) RETURNING id", [vendor, key, status, expires])).rows[0]?.id as string;

    expect(await summary()).toBeUndefined(); // nothing verified yet: no row, so not shown
    await doc("identity_proof", "verified", null);
    await doc("background_check", "submitted", null); // submitted documents never count
    expect(await summary()).toMatchObject({ complete: false });
    const safety = await doc("child_safety_training", "verified", "2099-06-30");
    expect(await summary()).toMatchObject({ complete: false }); // background check still missing
    const background = await doc("background_check", "verified", "2098-01-15");
    expect(await summary()).toEqual({ complete: true, until: "2098-01-15" }); // the earliest expiry among those that count
    // a second, longer-lived background check extends it; an expired one does not matter while a newer exists
    await doc("background_check", "verified", "2099-12-31");
    expect(await summary()).toEqual({ complete: true, until: "2099-06-30" });
    // rejecting or removing a verified document is picked up
    await db.admin.query("UPDATE vendor_documents SET status = 'rejected' WHERE id = $1", [safety]);
    expect(await summary()).toMatchObject({ complete: false });
    await db.admin.query("UPDATE vendor_documents SET status = 'verified' WHERE id = $1", [safety]);
    await db.admin.query("DELETE FROM vendor_documents WHERE id = $1", [background]);
    expect(await summary()).toEqual({ complete: true, until: "2099-06-30" });

    // the vendor's own people can read their summary but never write it (that would let a vendor vouch for itself)
    const staff = randomUUID();
    await db.admin.query("INSERT INTO users (id, email, display_name) VALUES ($1, 'vsum@vendor-visibility.test', 'vsum')", [staff]);
    await db.admin.query("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [vendor, staff]);
    await db.admin.query("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'vendor_owner' AND tenant_id IS NULL", [vendor, staff]);
    const ctx = { tenantId: vendor, userId: staff, permissions: ["vendors.read", "vendor_documents.manage", "vendors.update"] };
    expect(await withContext(db.app, ctx, async (c) => (await c.query("SELECT 1 FROM vendor_vetting_summary")).rowCount)).toBe(1);
    await expect(withContext(db.app, ctx, (c) => c.query("UPDATE vendor_vetting_summary SET complete = true"))).resolves.toMatchObject({ rowCount: 0 });
    await expect(withContext(db.app, ctx, (c) => c.query("INSERT INTO vendor_vetting_summary (tenant_id, complete) VALUES ($1, true) ON CONFLICT (tenant_id) DO UPDATE SET complete = true", [vendor]))).rejects.toMatchObject({ code: "42501" });
    // submitting and withdrawing an unreviewed document does not touch the summary
    const before = await summary();
    await withContext(db.app, ctx, async (c) => {
      const id = (await c.query("INSERT INTO vendor_documents (tenant_id, requirement_key, title) VALUES ($1, 'insurance', 'x') RETURNING id", [vendor])).rows[0].id as string;
      await c.query("DELETE FROM vendor_documents WHERE id = $1", [id]);
    });
    expect(await summary()).toEqual(before);
  });

  it("categories can be read by any signed-in user but changed only by the platform", async () => {
    expect((await withContext(db.app, { userId: resident }, async (c) => (await c.query("SELECT count(*)::int AS n FROM categories")).rows[0].n as number))).toBeGreaterThan(25);
    expect(await withContext(db.app, {}, async (c) => (await c.query("SELECT 1 FROM categories")).rowCount)).toBe(0);
    await expect(withContext(db.app, { userId: resident }, (c) => c.query("INSERT INTO categories (key, name) VALUES ('rogue', 'Rogue')"))).rejects.toMatchObject({ code: "42501" });
    await expect(withContext(db.app, { userId: resident }, (c) => c.query("UPDATE categories SET name = 'x'"))).resolves.toMatchObject({ rowCount: 0 });
  });
});

describe("platform scope", () => {
  it("requesting platform scope without being platform staff grants nothing beyond the public directory", async () => {
    const names = await withContext(
      db.app,
      { userId: ids.mallory, platformScope: true },
      async (c) => (await c.query("SELECT name FROM organizations")).rows.map((r) => r.name as string),
    );
    // Only ACTIVE communities (the public directory); drafts and the platform organization stay hidden.
    expect(names.sort()).toEqual(await activeCommunityNames());
  });

  it("platform staff with platform scope see all tenants", async () => {
    const n = await withContext(db.app, { userId: ids.carol, platformScope: true }, async (c) =>
      (await c.query("SELECT 1 FROM organizations")).rowCount,
    );
    expect(n).toBeGreaterThanOrEqual(5); // at least: A, B (drafts), the platform organization, and the active communities
    const names = await withContext(db.app, { userId: ids.carol, platformScope: true }, async (c) =>
      (await c.query("SELECT name FROM organizations")).rows.map((r) => r.name as string),
    );
    for (const expected of ["Community A", "Community B", "Platform", "Open Community"]) expect(names).toContain(expected);
  });

  it("platform staff without requesting platform scope are limited like everyone else", async () => {
    const names = await withContext(db.app, { userId: ids.carol }, async (c) =>
      (await c.query("SELECT name FROM organizations")).rows.map((r) => r.name as string),
    );
    expect(names.sort()).toEqual(await activeCommunityNames());
  });

  it("only platform staff can create organizations", async () => {
    await expect(
      withContext(db.app, { tenantId: ids.orgA, userId: ids.alice }, (c) =>
        c.query("INSERT INTO organizations (type, name) VALUES ('community', 'Rogue')"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    const created = await withContext(db.app, { userId: ids.carol, platformScope: true }, (c) =>
      c.query("INSERT INTO organizations (type, name) VALUES ('community', 'Legit') RETURNING id"),
    );
    expect(created.rowCount).toBe(1);
  });

  it("the application role cannot grant itself platform staff", async () => {
    await expect(
      withContext(db.app, { userId: ids.mallory, platformScope: true }, (c) =>
        c.query("INSERT INTO platform_staff (user_id) VALUES ($1)", [ids.mallory]),
      ),
    ).rejects.toThrow();
  });
});

describe("context hygiene", () => {
  it("context does not leak between pooled connections", async () => {
    await withContext(db.app, { tenantId: ids.orgA, userId: ids.alice }, (c) => c.query("SELECT 1"));
    const n = await db.app.query("SELECT current_setting('app.tenant_id', true) AS t");
    expect(n.rows[0].t === null || n.rows[0].t === "").toBe(true);
  });

  it("rejects malformed identifiers before touching the database", async () => {
    await expect(
      withContext(db.app, { tenantId: "x'; DROP TABLE users;--" }, (c) => c.query("SELECT 1")),
    ).rejects.toThrow(/Invalid tenantId/);
  });
});
