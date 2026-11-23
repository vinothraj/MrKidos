/**
 * Backup and restore drill (local, cold physical backup).
 *
 * 1. Create a database, apply migrations, add data.
 * 2. Stop the cluster cleanly and copy its data directory (the backup).
 * 3. Destroy the original (simulated disaster).
 * 4. Restore from the copy into a new location and start it.
 * 5. Prove: identical data, migrations intact, application role still bound by row-level security,
 *    audit log still append-only. Report the measured restore time.
 *
 * Managed PostgreSQL in production uses the provider's snapshots and point-in-time recovery; that restore must be
 * drilled on the provider before go-live (see docs/DEPLOYMENT_GUIDE.md). This drill proves our data and security
 * model survive a restore and keeps the procedure honest.
 */
import { createHash } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import { migrate } from "../packages/db/src/migrate";

const PORT = 54330;
const ADMIN = { user: "kidos_admin", password: "kidos_dev" };
const APP_URL = `postgres://kidos_app_login:kidos_app_dev@127.0.0.1:${PORT}/kidos`;
const ADMIN_URL = `postgres://${ADMIN.user}:${ADMIN.password}@127.0.0.1:${PORT}/kidos`;

function cluster(dir: string): EmbeddedPostgres {
  return new EmbeddedPostgres({ databaseDir: dir, ...ADMIN, port: PORT, persistent: true, onLog: () => {}, onError: () => {} });
}

/** A fingerprint of the business data, independent of physical layout. */
async function fingerprint(pool: Pool): Promise<{ counts: Record<string, number>; digest: string }> {
  const tables = ["users", "organizations", "memberships", "role_assignments", "audit_log", "user_credentials", "permissions", "role_permissions", "roles"];
  const counts: Record<string, number> = {};
  const hash = createHash("sha256");
  for (const t of tables) {
    const { rows } = await pool.query(`SELECT * FROM ${t} ORDER BY 1, 2`);
    counts[t] = rows.length;
    hash.update(t + JSON.stringify(rows));
  }
  return { counts, digest: hash.digest("hex") };
}

function check(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"}  ${message}`);
  if (!condition) process.exitCode = 1;
}

async function main(): Promise<void> {
  const base = await mkdtemp(path.join(os.tmpdir(), "kidos-drill-"));
  const original = path.join(base, "original");
  const backup = path.join(base, "backup");
  const restored = path.join(base, "restored");
  try {
    // 1. Build and populate
    let pg = cluster(original);
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("kidos");
    let admin = new Pool({ connectionString: ADMIN_URL, max: 2 });
    await admin.query(`
      CREATE ROLE kidos_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE kidos_app_login LOGIN PASSWORD 'kidos_app_dev' NOSUPERUSER NOBYPASSRLS IN ROLE kidos_app;`);
    await migrate(admin);
    await admin.query(`
      INSERT INTO organizations (id, type, name, status) VALUES
        ('11111111-1111-4111-8111-111111111111', 'community', 'Aqualily', 'active'),
        ('22222222-2222-4222-8222-222222222222', 'community', 'Beta Heights', 'active');
      INSERT INTO users (id, email, display_name) VALUES
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a@example.test', 'A'),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b@example.test', 'B');
      INSERT INTO user_credentials (user_id, password_hash) VALUES
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '$argon2id$placeholder'), ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '$argon2id$placeholder');
      INSERT INTO memberships (tenant_id, user_id) VALUES
        ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
        ('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
      INSERT INTO audit_log (tenant_id, action) SELECT '11111111-1111-4111-8111-111111111111', 'drill.event.' || g FROM generate_series(1, 200) g;
      INSERT INTO audit_log (tenant_id, action) VALUES ('22222222-2222-4222-8222-222222222222', 'drill.other.tenant');`);
    const before = await fingerprint(admin);
    console.log("data before:", JSON.stringify(before.counts));

    // 2. Cold backup
    await admin.end();
    await pg.stop();
    await cp(original, backup, { recursive: true });
    console.log("backup taken");

    // 3. Disaster
    await rm(original, { recursive: true, force: true });
    check(true, "original data destroyed (simulated disaster)");

    // 4. Restore
    const t0 = Date.now();
    await cp(backup, restored, { recursive: true });
    pg = cluster(restored); // existing data directory: no initialise
    await pg.start();
    admin = new Pool({ connectionString: ADMIN_URL, max: 2 });
    await admin.query("SELECT 1");
    const restoreSeconds = (Date.now() - t0) / 1000;

    // 5. Prove
    const after = await fingerprint(admin);
    check(after.digest === before.digest, "restored business data is byte-for-byte identical (digest match)");
    check(JSON.stringify(after.counts) === JSON.stringify(before.counts), "row counts match for every table");

    const migrations = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM schema_migrations");
    check((migrations.rows[0]?.n ?? 0) >= 5, "migration history intact");
    const rerun = await migrate(admin);
    check(rerun.applied.length === 0, "migration runner sees nothing pending after restore");

    const app = new Pool({ connectionString: APP_URL, max: 2 });
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', '11111111-1111-4111-8111-111111111111', true), set_config('app.user_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true)");
      // Since migration 0009 reads are least-privilege: without the verified permission the trail is not readable at all...
      const withoutPermission = await client.query("SELECT count(*)::int AS n FROM audit_log");
      check(withoutPermission.rows[0].n === 0, "restored database shows the audit trail only to callers holding audit.read");
      // ...and with it, a caller sees exactly their own tenant's rows and none of another tenant's.
      await client.query("SELECT set_config('app.permissions', 'audit.read', true)");
      const visible = await client.query("SELECT count(*)::int AS n FROM audit_log");
      const other = await client.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'drill.other.tenant'");
      check(visible.rows[0].n === 200 && other.rows[0].n === 0, "restored database still isolates tenants for the application role");
      let blocked = false;
      try {
        await client.query("UPDATE audit_log SET action = 'tampered'");
      } catch {
        blocked = true;
      }
      check(blocked, "audit log is still append-only after restore");
      await client.query("ROLLBACK");
    } finally {
      client.release();
      await app.end();
    }

    console.log(`restore time (copy + start + first query): ${restoreSeconds.toFixed(1)} s`);
    await admin.end();
    await pg.stop();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
