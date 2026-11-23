import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate";
import { createTestDb, type TestDb } from "../src/testing";

describe("migration runner", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb(); // applies all migrations from an empty database
  });
  afterAll(async () => {
    await db.close();
  });

  it("applies every migration file from an empty database", async () => {
    const { rows } = await db.admin.query<{ name: string }>(
      "SELECT name FROM schema_migrations ORDER BY name",
    );
    expect(rows.map((r) => r.name)).toEqual([
      "0001_foundation.sql",
      "0002_seed_permissions_and_roles.sql",
      "0003_auth_sessions.sql",
      "0004_roles_visible_to_assignee.sql",
      "0005_mfa_tokens_verification.sql",
      "0006_communities.sql",
      "0007_membership.sql",
      "0008_families.sql",
      "0009_least_privilege_reads.sql",
      "0010_vendors.sql",
      "0011_vendor_vetting_currency.sql",
      "0012_requests.sql",
      "0013_sourcing_and_booking.sql",
      "0014_payments_reviews_stage.sql",
      "0015_saved_offerings.sql",
      "0016_concerns.sql",
      "0017_newest_first_indexes.sql",
      "0018_appearance.sql",
      "0019_security_policies.sql",
      "0020_community_banners.sql",
      "0021_banner_photos.sql",
      "0022_requests_summary_index.sql",
    ]);
  });

  it("has the newest-first indexes that keep operations' cross-community lists fast (found by the load check)", async () => {
    const { rows } = await db.admin.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('audit_log_created_idx', 'requests_created_idx') ORDER BY indexname",
    );
    expect(rows.map((r) => r.indexname)).toEqual(["audit_log_created_idx", "requests_created_idx"]);
    for (const r of rows) expect(r.indexdef).toContain("(created_at DESC, id DESC)");
  });

  it("is idempotent: a second run applies nothing", async () => {
    const result = await migrate(db.admin);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(22);
  });

  it("rejects an applied migration whose contents changed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kidos-mig-"));
    try {
      await writeFile(path.join(dir, "0001_a.sql"), "CREATE TABLE tmp_a (id int);");
      await migrate(db.admin, dir);
      await writeFile(path.join(dir, "0001_a.sql"), "CREATE TABLE tmp_a (id int, extra int);");
      await expect(migrate(db.admin, dir)).rejects.toThrow(/checksum mismatch/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rolls back a failing migration completely", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kidos-mig-"));
    try {
      await writeFile(
        path.join(dir, "0001_bad.sql"),
        "CREATE TABLE tmp_partial (id int); SELECT 1/0;",
      );
      await expect(migrate(db.admin, dir)).rejects.toThrow(/failed/);
      const { rows } = await db.admin.query("SELECT to_regclass('tmp_partial') AS t");
      expect(rows[0].t).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("seeds the permission catalog and system roles", async () => {
    const perms = await db.admin.query("SELECT count(*)::int AS n FROM permissions");
    expect(perms.rows[0].n).toBeGreaterThanOrEqual(50);
    const sa = await db.admin.query(
      `SELECT count(*)::int AS n FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id WHERE r.key = 'super_admin'`,
    );
    expect(sa.rows[0].n).toBe(perms.rows[0].n);
  });
});
