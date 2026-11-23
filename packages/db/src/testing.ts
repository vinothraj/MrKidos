import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { migrate } from "./migrate";

const ADMIN_URL =
  process.env["TEST_DATABASE_ADMIN_URL"] ?? "postgres://kidos_admin:kidos_dev@localhost:5433/postgres";

const APP_LOGIN = "kidos_app_test_login";
const APP_PASSWORD = "kidos_app_test_pw";

export interface TestDb {
  name: string;
  /** Superuser pool: bypasses RLS. Use only to arrange fixtures. */
  admin: Pool;
  /** Restricted application pool: subject to RLS, as in production. */
  app: Pool;
  close(): Promise<void>;
}

function swapDatabase(url: string, database: string, user?: string, password?: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (user !== undefined) u.username = user;
  if (password !== undefined) u.password = password;
  return u.toString();
}

/** Creates a throwaway database, runs all migrations, and returns admin and app pools. */
export async function createTestDb(): Promise<TestDb> {
  const name = `kidos_test_${randomBytes(6).toString("hex")}`;
  const bootstrap = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    // Cluster-level roles may already exist (dev init script or a parallel test file).
    await bootstrap.query("SELECT pg_advisory_lock(727275)");
    await bootstrap.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kidos_app') THEN
          CREATE ROLE kidos_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_LOGIN}') THEN
          CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS IN ROLE kidos_app;
        END IF;
      END $$`);
    await bootstrap.query("SELECT pg_advisory_unlock(727275)");
    await bootstrap.query(`CREATE DATABASE ${name}`);
  } finally {
    await bootstrap.end();
  }

  const admin = new Pool({ connectionString: swapDatabase(ADMIN_URL, name), max: 4 });
  await migrate(admin);
  const app = new Pool({
    connectionString: swapDatabase(ADMIN_URL, name, APP_LOGIN, APP_PASSWORD),
    max: 4,
  });

  return {
    name,
    admin,
    app,
    async close() {
      await app.end();
      await admin.end();
      const cleanup = new Pool({ connectionString: ADMIN_URL, max: 1 });
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
