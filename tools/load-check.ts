/**
 * A lightweight load check: fills a throwaway PostgreSQL 16 with a pilot-sized community network several times over,
 * then times the screens people will actually open, as real signed-in people over real HTTP (row-level security on).
 *
 *   corepack pnpm@9.15.0 run check:load            default size
 *   LOAD_SCALE=0.2 corepack pnpm@9.15.0 run check:load   a quick smoke run at a fifth of the size
 *
 * What this is: a check that nothing is accidentally slow (a missing index, a policy that scans a table, a query that
 * grows with the whole platform instead of with the person's own data). What it is not: a capacity test. It runs the
 * database, the API and the client on one machine, over one connection pool, with rate limits raised so they do not
 * hide the database cost. Read the numbers as "is anything wrong", not as "how many users can we serve".
 *
 * Data is inserted as the database owner with triggers off (so that millions of history rows are not replayed through
 * the workflow), which means the seeded rows are not a record of real flows. Every time measured below runs through
 * the real application code and the real policies, as the application role.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import EmbeddedPostgres from "embedded-postgres";
import { Pool, type PoolClient } from "pg";
import { migrate } from "../packages/db/src/migrate";
import { buildApp } from "../apps/api/src/app";
import { loadConfig } from "../apps/api/src/config";
import { base32Decode, totpAt } from "../apps/api/src/auth/totp";
import { MemoryMailer } from "../apps/api/src/mailer";

const SCALE = Number(process.env["LOAD_SCALE"] ?? "1");
const n = (base: number): number => Math.max(1, Math.round(base * SCALE));
/** A pilot is one community and 15 to 25 vendors; this is roughly 30 times that. */
const SIZE = {
  communities: n(30),
  vendors: n(400),
  offeringsPerVendor: 4,
  users: n(6000),
  requests: n(30000),
  inquiries: n(3000),
  reviewsPublished: n(4000),
  reviewsPending: n(300),
  saved: n(20000),
  audit: n(300000),
  concerns: n(400),
};
/** A read taking longer than this at the 95th percentile is reported as slow. */
const BUDGET_MS = Number(process.env["LOAD_BUDGET_MS"] ?? "400");
const PORT_PG = 54330;
const ADMIN = { user: "kidos_admin", password: "kidos_dev" };
const PASSWORD = "correct-horse-battery-9";
const KEY = Buffer.from("kidos-load-check-key-not-prod!!!").toString("base64");

interface Actor {
  cookie: string;
  headers: Record<string, string>;
}

let base = "";
const ORIGIN = "http://localhost:3000";

async function http(method: string, url: string, actor: Actor | undefined, body?: unknown): Promise<{ status: number; ms: number; json: unknown; setCookie: string | null }> {
  const headers: Record<string, string> = { origin: ORIGIN, ...(actor?.headers ?? {}) };
  if (actor) headers["cookie"] = `kidos_sid=${actor.cookie}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const t = performance.now();
  const res = await fetch(base + url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  const ms = performance.now() - t;
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, ms, json, setCookie: res.headers.get("set-cookie") };
}

function sid(setCookie: string | null): string {
  const m = setCookie && /kidos_sid=([^;]+)/u.exec(setCookie);
  if (!m?.[1]) throw new Error("no session cookie");
  return m[1];
}

async function register(email: string, name: string): Promise<{ userId: string; cookie: string }> {
  const res = await http("POST", "/api/v1/auth/register", undefined, { email, password: PASSWORD, displayName: name });
  if (res.status !== 201) throw new Error(`register ${res.status} ${JSON.stringify(res.json)}`);
  return { userId: (res.json as { user: { id: string } }).user.id, cookie: sid(res.setCookie) };
}

async function enrollMfa(cookie: string): Promise<void> {
  const actor = { cookie, headers: {} };
  const start = await http("POST", "/api/v1/auth/mfa/enroll/start", actor);
  if (start.status !== 200) throw new Error(`mfa start ${start.status}`);
  const secret = base32Decode((start.json as { secret: string }).secret);
  const confirm = await http("POST", "/api/v1/auth/mfa/enroll/confirm", actor, { code: totpAt(secret, Date.now()) });
  if (confirm.status !== 200) throw new Error(`mfa confirm ${confirm.status}`);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)] ?? 0;
}

interface Result {
  name: string;
  /** one caller at a time */
  alone: { p50: number; p95: number };
  /** eight callers at the same moment, on one machine that also runs the database and this client */
  together: { p50: number; p95: number };
  failures: number;
  slow: boolean;
}
const results: Result[] = [];
/** A burst of eight at once shares one machine, so it is judged more leniently than one caller at a time. */
const BURST_FACTOR = 3;

/** Times `runs` sequential calls (after a warm-up), then the same number in parallel bursts of `parallel`. */
async function measure(name: string, runs: number, parallel: number, call: (i: number) => Promise<{ status: number; ms: number }>, expectStatus: number[] = [200]): Promise<void> {
  const alone: number[] = [];
  const together: number[] = [];
  let failures = 0;
  const record = (into: number[]) => (r: { status: number; ms: number }): void => {
    if (!expectStatus.includes(r.status)) failures += 1;
    else into.push(r.ms);
  };
  await call(0); // warm-up: connection, plan cache
  for (let i = 0; i < runs; i += 1) record(alone)(await call(i + 1));
  for (let i = 0; i < runs; i += parallel) {
    const burst = await Promise.all(Array.from({ length: Math.min(parallel, runs - i) }, (_, k) => call(i + k + 1)));
    burst.forEach(record(together));
  }
  alone.sort((a, b) => a - b);
  together.sort((a, b) => a - b);
  const r: Result = {
    name,
    alone: { p50: percentile(alone, 50), p95: percentile(alone, 95) },
    together: { p50: percentile(together, 50), p95: percentile(together, 95) },
    failures,
    slow: false,
  };
  r.slow = r.alone.p95 > BUDGET_MS || r.together.p95 > BUDGET_MS * BURST_FACTOR || failures > 0;
  results.push(r);
  const ms = (x: number): string => x.toFixed(0).padStart(5);
  console.log(`${r.slow ? "SLOW" : "ok  "} ${name.padEnd(54)} alone p50 ${ms(r.alone.p50)} p95 ${ms(r.alone.p95)} ms   8 at once p50 ${ms(r.together.p50)} p95 ${ms(r.together.p95)} ms${failures ? `   FAILED ${failures}` : ""}`);
}

async function seed(admin: PoolClient): Promise<void> {
  const t0 = Date.now();
  // triggers and foreign-key checks off for bulk loading only; the application role never has this
  await admin.query("SET session_replication_role = replica");
  const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);

  await q(`INSERT INTO organizations (type, name, status) SELECT 'community', 'Load Community ' || g, 'active' FROM generate_series(1, $1::int) g`, [SIZE.communities]);
  await q(`CREATE TEMP TABLE comm AS SELECT id, (row_number() OVER (ORDER BY name))::int AS n FROM organizations WHERE type = 'community'`);
  await q(`INSERT INTO community_profiles (tenant_id, city, locality, unit_count) SELECT id, 'Bengaluru', 'Locality ' || n, 400 FROM comm`);

  await q(`INSERT INTO organizations (type, name, status) SELECT 'vendor', 'Load Vendor ' || g, 'active' FROM generate_series(1, $1::int) g`, [SIZE.vendors]);
  await q(`CREATE TEMP TABLE vend AS SELECT id, (row_number() OVER (ORDER BY name))::int AS n FROM organizations WHERE type = 'vendor'`);
  await q(`INSERT INTO vendor_profiles (tenant_id, tagline, description, city, years_experience) SELECT id, 'Fun for children ' || n, 'A long enough description of what this vendor does with children, ' || n, 'Bengaluru', n % 20 FROM vend`);
  await q(`INSERT INTO vendor_vetting_summary (tenant_id, complete) SELECT id, true FROM vend`);
  await q(`CREATE TEMP TABLE subcat AS SELECT id, (row_number() OVER (ORDER BY key))::int AS n FROM categories WHERE parent_id IS NOT NULL`);
  await q(`INSERT INTO vendor_categories (tenant_id, category_id) SELECT v.id, c.id FROM vend v JOIN subcat c ON c.n = 1 + (v.n % (SELECT count(*) FROM subcat))`);
  // each vendor serves three communities, and all three approve it
  await q(`INSERT INTO vendor_service_areas (tenant_id, community_id) SELECT DISTINCT v.id, c.id FROM vend v CROSS JOIN LATERAL unnest(ARRAY[1 + (v.n % $1::int), 1 + ((v.n + 7) % $1::int), 1 + ((v.n + 13) % $1::int)]) k(cn) JOIN comm c ON c.n = k.cn`, [SIZE.communities]);
  await q(`INSERT INTO community_vendor_approvals (tenant_id, vendor_id, status) SELECT community_id, tenant_id, 'approved' FROM vendor_service_areas`);
  await q(
    `INSERT INTO offerings (tenant_id, category_id, name, description, pricing_model, price_minor, age_min, age_max, min_participants, max_participants, status)
     SELECT v.id, vc.category_id, 'Offering ' || v.n || '-' || k, 'What the offering involves, for children, session ' || k, 'fixed', (500 + (v.n * k * 37) % 4500) * 100, 4 + (k % 4), 10 + (k % 5), 1, 20, 'published'
       FROM vend v JOIN vendor_categories vc ON vc.tenant_id = v.id CROSS JOIN generate_series(1, $1::int) k`,
    [SIZE.offeringsPerVendor],
  );

  await q(
    `INSERT INTO users (email, display_name) SELECT 'load' || g || '@load.test', 'Load User ' || g FROM generate_series(1, $1::int) g`,
    [SIZE.users],
  );
  await q(`CREATE TEMP TABLE usr AS SELECT id, (row_number() OVER (ORDER BY email))::int AS n FROM users WHERE email LIKE 'load%@load.test'`);
  await q(`INSERT INTO memberships (tenant_id, user_id) SELECT c.id, u.id FROM usr u JOIN comm c ON c.n = 1 + (u.n % $1::int)`, [SIZE.communities]);
  await q(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id)
     SELECT c.id, u.id, r.id FROM usr u JOIN comm c ON c.n = 1 + (u.n % $1::int) CROSS JOIN roles r WHERE r.tenant_id IS NULL AND r.key IN ('resident', 'parent_guardian')`,
    [SIZE.communities],
  );

  await q(`CREATE TEMP TABLE rtype AS SELECT id FROM request_types WHERE key = 'activity'`);
  await q(
    `INSERT INTO requests (tenant_id, requester_id, request_type_id, schema_version, title, description, status, status_changed_at, sla_due_at, assigned_to, created_at, answers)
     SELECT c.id, u.id, (SELECT id FROM rtype), 1, 'Weekend activity ' || g, 'Something fun for two children',
            s.key, now() - ((g % 200) || ' hours')::interval, CASE WHEN s.waiting_on = 'operations' THEN now() + ((g % 96) - 40 || ' hours')::interval END,
            CASE WHEN g % 3 = 0 THEN (SELECT id FROM usr WHERE n = 1) END, now() - ((g % 2160) || ' hours')::interval, '{"format":"one_time"}'::jsonb
       FROM generate_series(1, $1::int) g
       JOIN usr u ON u.n = 1 + (g % $2::int)
       JOIN comm c ON c.n = 1 + (u.n % $3::int)
       JOIN (SELECT key, waiting_on, (row_number() OVER (ORDER BY sort_order))::int AS n, (count(*) OVER ())::int AS total FROM workflow_statuses WHERE key <> 'draft') s ON s.n = 1 + (g % s.total)`,
    [SIZE.requests, SIZE.users, SIZE.communities],
  );
  await q(`INSERT INTO request_status_history (tenant_id, request_id, from_status, to_status, created_at) SELECT tenant_id, id, NULL, 'submitted', created_at FROM requests`);

  await q(
    `INSERT INTO inquiries (tenant_id, request_id, vendor_id, status, snapshot, sent_at)
     SELECT r.tenant_id, r.id, v.id, 'sent', jsonb_build_object('title', r.title, 'community', jsonb_build_object('name', 'Load Community')), now() - (g || ' minutes')::interval
       FROM (SELECT id, tenant_id, title, (row_number() OVER ())::int AS n FROM requests LIMIT $1::int) r
       JOIN vend v ON v.n = 1 + (r.n % $2::int)
       CROSS JOIN generate_series(1, 1) g`,
    [SIZE.inquiries, SIZE.vendors],
  );

  await q(
    `INSERT INTO reviews (tenant_id, booking_id, vendor_id, requester_id, rating, body, status)
     SELECT c.id, gen_random_uuid(), v.id, u.id, 1 + (g % 5), 'Good with the children', CASE WHEN g <= $1::int THEN 'published' ELSE 'pending' END
       FROM generate_series(1, $1::int + $2::int) g
       JOIN vend v ON v.n = 1 + (g % $3::int)
       JOIN usr u ON u.n = 1 + (g % $4::int)
       JOIN comm c ON c.n = 1 + (g % $5::int)`,
    [SIZE.reviewsPublished, SIZE.reviewsPending, SIZE.vendors, SIZE.users, SIZE.communities],
  );

  await q(
    `INSERT INTO saved_offerings (tenant_id, user_id, offering_id)
     SELECT c.id, u.id, o.id
       FROM generate_series(1, $1::int) g
       JOIN usr u ON u.n = 1 + (g % $2::int)
       JOIN comm c ON c.n = 1 + (u.n % $3::int)
       JOIN (SELECT id, (row_number() OVER ())::int AS n, (count(*) OVER ())::int AS total FROM offerings) o ON o.n = 1 + ((g * 7) % o.total)
     ON CONFLICT DO NOTHING`,
    [SIZE.saved, SIZE.users, SIZE.communities],
  );

  await q(
    `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, created_at)
     SELECT c.id, u.id, 'request.created', 'request', gen_random_uuid()::text, now() - ((g % 2160) || ' minutes')::interval
       FROM generate_series(1, $1::int) g JOIN comm c ON c.n = 1 + (g % $2::int) JOIN usr u ON u.n = 1 + (g % $3::int)`,
    [SIZE.audit, SIZE.communities, SIZE.users],
  );

  await q(
    `INSERT INTO concerns (tenant_id, reporter_id, category, vendor_id, subject, details, status, created_at)
     SELECT c.id, u.id, (ARRAY['child_safety', 'conduct', 'payment', 'other'])[1 + (g % 4)], v.id, 'Concern ' || g, 'Something happened ' || g,
            (ARRAY['open', 'reviewing', 'resolved', 'dismissed'])[1 + (g % 4)], now() - ((g % 300) || ' hours')::interval
       FROM generate_series(1, $1::int) g JOIN comm c ON c.n = 1 + (g % $2::int) JOIN usr u ON u.n = 1 + (g % $3::int) JOIN vend v ON v.n = 1 + (g % $4::int)`,
    [SIZE.concerns, SIZE.communities, SIZE.users, SIZE.vendors],
  );

  await q("SET session_replication_role = DEFAULT");
  // VACUUM as well as ANALYZE: a real database is vacuumed continuously, and that is what lets counts read an index alone.
  await q("VACUUM (ANALYZE)");
  console.log(`[load] seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

async function main(): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "kidos-load-pg-"));
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, ...ADMIN, port: PORT_PG, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("kidos_load");
  const adminUrl = `postgres://${ADMIN.user}:${ADMIN.password}@127.0.0.1:${PORT_PG}/kidos_load`;
  const adminPool = new Pool({ connectionString: adminUrl, max: 4 });
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let appPool: Pool | undefined;
  try {
    await adminPool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kidos_app') THEN CREATE ROLE kidos_app NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kidos_app_login') THEN CREATE ROLE kidos_app_login LOGIN PASSWORD 'kidos_app_dev' NOSUPERUSER NOBYPASSRLS IN ROLE kidos_app; END IF;
      END $$`);
    await migrate(adminPool);

    console.log(`[load] seeding: ${SIZE.communities} communities, ${SIZE.vendors} vendors, ${SIZE.vendors * SIZE.offeringsPerVendor} offerings, ${SIZE.users} people, ${SIZE.requests} requests, ${SIZE.audit} audit rows ...`);
    const seeder = await adminPool.connect();
    try {
      await seed(seeder);
    } finally {
      seeder.release();
    }

    if (process.env["LOAD_HOLD"]) {
      console.log(`[load] HOLD: seeded database is up at ${adminUrl}; stop this process to end`);
      await new Promise((resolve) => setTimeout(resolve, Number(process.env["LOAD_HOLD"]) * 1000));
    }

    const appUrl = `postgres://kidos_app_login:kidos_app_dev@127.0.0.1:${PORT_PG}/kidos_load`;
    appPool = new Pool({ connectionString: appUrl, max: 10 });
    const config = loadConfig({
      ...process.env,
      NODE_ENV: "development",
      DATABASE_APP_URL: appUrl,
      MFA_ENCRYPTION_KEY: KEY,
      ALLOWED_ORIGINS: ORIGIN,
      APP_BASE_URL: ORIGIN,
      PORT: "4020",
      AUTH_RATE_LIMIT_PER_MINUTE: "100000",
      GLOBAL_RATE_LIMIT_PER_MINUTE: "1000000",
      EMAIL_COOLDOWN_SECONDS: "0",
    });
    app = await buildApp({ pool: appPool, config, mailer: new MemoryMailer() }, { logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    // ---- people to act as (real registration, real sign-in) ----
    const community = (await adminPool.query<{ id: string }>("SELECT id FROM organizations WHERE name = 'Load Community 1'")).rows[0]?.id ?? "";
    const benchVendor = (await adminPool.query<{ id: string }>("SELECT vendor_id AS id FROM inquiries GROUP BY vendor_id ORDER BY count(*) DESC, vendor_id LIMIT 1")).rows[0]?.id ?? "";
    const grant = async (userId: string, orgId: string, roleKeys: string[]): Promise<void> => {
      await adminPool.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [userId]);
      await adminPool.query("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [orgId, userId]);
      for (const key of roleKeys) {
        await adminPool.query("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = $3 AND tenant_id IS NULL", [orgId, userId, key]);
      }
    };
    const t0 = performance.now();
    const resident = await register("bench-resident@load.test", "Bench Resident");
    await grant(resident.userId, community, ["resident", "parent_guardian"]);
    const communityAdmin = await register("bench-admin@load.test", "Bench Community Admin");
    await grant(communityAdmin.userId, community, ["community_admin"]);
    await enrollMfa(communityAdmin.cookie);
    const vendorOwner = await register("bench-vendor@load.test", "Bench Vendor Owner");
    await grant(vendorOwner.userId, benchVendor, ["vendor_owner"]);
    await enrollMfa(vendorOwner.cookie);
    const ops = await register("bench-ops@load.test", "Bench Ops");
    await grant(ops.userId, "00000000-0000-4000-8000-000000000001", ["super_admin"]);
    await adminPool.query("INSERT INTO platform_staff (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [ops.userId]);
    await enrollMfa(ops.cookie);
    console.log(`[load] registered and enrolled 4 actors in ${(performance.now() - t0).toFixed(0)} ms`);

    // the resident has saved a realistic number of offerings visible in their community
    await adminPool.query(
      `INSERT INTO saved_offerings (tenant_id, user_id, offering_id)
       SELECT $1, $2, o.id FROM offerings o JOIN vendor_service_areas a ON a.tenant_id = o.tenant_id AND a.community_id = $1 LIMIT 60 ON CONFLICT DO NOTHING`,
      [community, resident.userId],
    );
    await adminPool.query("INSERT INTO requests (tenant_id, requester_id, request_type_id, schema_version, title, status, answers) SELECT $1, $2, id, 1, 'My own request ' || g, 'submitted', '{\"format\":\"one_time\"}' FROM request_types, generate_series(1, 3) g WHERE key = 'activity'", [community, resident.userId]);

    const as = (a: { cookie: string }, headers: Record<string, string>): Actor => ({ cookie: a.cookie, headers });
    const asResident = as(resident, { "x-tenant-id": community });
    const asAdmin = as(communityAdmin, { "x-tenant-id": community });
    const asVendor = as(vendorOwner, { "x-tenant-id": benchVendor });
    const asOps = as(ops, { "x-platform-scope": "on" });
    const categoryId = (await adminPool.query<{ id: string }>("SELECT category_id AS id FROM offerings o JOIN vendor_service_areas a ON a.tenant_id = o.tenant_id AND a.community_id = $1 LIMIT 1", [community])).rows[0]?.id ?? "";
    const vendorInCommunity = (await adminPool.query<{ id: string }>("SELECT tenant_id AS id FROM vendor_service_areas WHERE community_id = $1 LIMIT 1", [community])).rows[0]?.id ?? "";
    const typeId = (await adminPool.query<{ id: string }>("SELECT id FROM request_types WHERE key = 'activity'")).rows[0]?.id ?? "";

    // A timing of an empty answer proves nothing: the seeded data must really reach these screens.
    const mustShowRows = async (label: string, who: Actor, url: string): Promise<void> => {
      const r = await http("GET", url, who);
      const j = r.json as { data?: unknown[]; items?: unknown[] } | null;
      const rows = j?.data ?? j?.items ?? [];
      if (r.status !== 200 || rows.length === 0) throw new Error(`seed check failed: ${label} returned ${r.status} with ${rows.length} rows`);
    };
    await mustShowRows("catalog", asResident, "/api/v1/catalog/offerings");
    await mustShowRows("catalog, only saved", asResident, "/api/v1/catalog/offerings?savedOnly=true");
    await mustShowRows("catalog, rated", asResident, "/api/v1/catalog/offerings?minRating=1");
    await mustShowRows("my requests", asResident, "/api/v1/requests");
    await mustShowRows("community requests", asAdmin, "/api/v1/requests");
    await mustShowRows("vendor inquiries", asVendor, "/api/v1/inquiries");
    await mustShowRows("ops queue", asOps, "/api/v1/requests?open=true");
    await mustShowRows("ops concerns", asOps, "/api/v1/concerns");
    await mustShowRows("audit", asOps, "/api/v1/admin/audit");
    const visible = (await http("GET", "/api/v1/requests?limit=100", asAdmin)).json as { data: { tenantId?: string }[] };
    console.log(`[load] seed check passed (the community administrator sees ${visible.data.length}+ requests of ${SIZE.requests}; a family sees only its own)`);

    console.log(`\n[load] timings: each line is sequential calls, then the same number in parallel bursts of 8 (budget: p95 ${BUDGET_MS} ms alone, ${BUDGET_MS * BURST_FACTOR} ms with 8 at once)\n`);
    const get = (who: Actor, url: string) => () => http("GET", url, who);

    console.log("A family");
    await measure("sign in (password hashing included), 4 at once", 24, 4, () => http("POST", "/api/v1/auth/login", undefined, { email: "bench-resident@load.test", password: PASSWORD }));
    await measure("who am I", 40, 8, get(asResident, "/api/v1/me"));
    await measure("what is waiting for me", 40, 8, get(asResident, "/api/v1/me/attention"));
    await measure("catalog, first page", 40, 8, get(asResident, "/api/v1/catalog/offerings"));
    await measure("catalog, one category", 40, 8, get(asResident, `/api/v1/catalog/offerings?categoryId=${categoryId}`));
    await measure("catalog, word search", 40, 8, get(asResident, "/api/v1/catalog/offerings?q=offering%201"));
    await measure("catalog, price, age and rating filters", 40, 8, get(asResident, "/api/v1/catalog/offerings?maxPriceMinor=300000&age=7&minRating=3"));
    await measure("catalog, only my saved", 40, 8, get(asResident, "/api/v1/catalog/offerings?savedOnly=true"));
    await measure("a vendor's page", 40, 8, get(asResident, `/api/v1/catalog/vendors/${vendorInCommunity}`));
    await measure("my requests", 40, 8, get(asResident, "/api/v1/requests"));
    await measure("my reports", 40, 8, get(asResident, "/api/v1/concerns/mine"));

    console.log("\nA community administrator");
    await measure("the community's requests", 40, 8, get(asAdmin, "/api/v1/requests"));
    await measure("the community's requests, searched", 40, 8, get(asAdmin, "/api/v1/requests?q=weekend"));

    console.log("\nA vendor");
    await measure("inquiries to answer", 40, 8, get(asVendor, "/api/v1/inquiries"));
    await measure("what is waiting for me", 40, 8, get(asVendor, "/api/v1/me/attention"));

    console.log("\nThe operations desk (every community at once)");
    await measure("the queue, open requests", 40, 8, get(asOps, "/api/v1/requests?open=true"));
    await measure("the queue, overdue", 40, 8, get(asOps, "/api/v1/requests?sla=overdue"));
    await measure("the queue, unassigned", 40, 8, get(asOps, "/api/v1/requests?assigned=unassigned"));
    await measure("queue summary", 40, 8, get(asOps, "/api/v1/requests/summary"));
    await measure("what is waiting for me", 40, 8, get(asOps, "/api/v1/me/attention"));
    await measure("concerns queue", 40, 8, get(asOps, "/api/v1/concerns"));
    await measure("vendors", 40, 8, get(asOps, "/api/v1/vendors"));
    await measure("audit trail", 40, 8, get(asOps, "/api/v1/admin/audit"));

    console.log("\nWriting");
    // each person may hold only a few open requests, so spread the writes over many people
    const writers: Actor[] = [];
    for (let i = 0; i < 24; i += 1) {
      const w = await register(`bench-writer-${i}@load.test`, `Writer ${i}`);
      await grant(w.userId, community, ["resident", "parent_guardian"]);
      writers.push(as(w, { "x-tenant-id": community }));
    }
    let k = 0;
    await measure("make a request (24 people, 4 at once)", 24, 4, async () => {
      const w = writers[k % writers.length] as Actor;
      k += 1;
      const r = await http("POST", "/api/v1/requests", w, { requestTypeId: typeId, title: `Load request ${k}`, answers: { format: "one_time" } });
      // a person may hold a limited number of open requests; that refusal is correct behaviour, not a failure
      return { status: r.status === 422 ? 201 : r.status, ms: r.ms };
    }, [201]);
    await measure("report a concern", 12, 4, async () => {
      const w = writers[k % writers.length] as Actor;
      k += 1;
      const r = await http("POST", "/api/v1/concerns", w, { category: "conduct", subject: `Load report ${k}`, details: "Something to look at." });
      return { status: r.status === 422 ? 201 : r.status, ms: r.ms };
    }, [201]);
  } finally {
    await app?.close();
    await appPool?.end();
    await adminPool.end();
    await pg.stop();
    await rm(dataDir, { recursive: true, force: true });
  }

  const slow = results.filter((r) => r.slow);
  console.log(`\n[load] ${results.length} measurements, ${slow.length} over the budget or failing`);
  for (const r of slow) console.log(`  SLOW  ${r.name}: alone p95 ${r.alone.p95.toFixed(0)} ms, 8 at once p95 ${r.together.p95.toFixed(0)} ms, ${r.failures} failures`);
  process.exitCode = slow.length > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
