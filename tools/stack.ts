/**
 * Runs PostgreSQL (embedded, no Docker needed), applies migrations, and starts the API in one process.
 *
 *   tsx tools/stack.ts dev   persistent data in .data/pg, Postgres :5433, API :4000, mail printed to the console
 *   tsx tools/stack.ts e2e   throwaway data, Postgres :54329, API :4010, mail written to $MAIL_OUTBOX_FILE
 *
 * Development and automated-test use only.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import { migrate } from "../packages/db/src/migrate";
import { buildApp } from "../apps/api/src/app";
import { loadConfig } from "../apps/api/src/config";
import { ConsoleMailer, FileMailer, type Mailer } from "../apps/api/src/mailer";
import { seedDemoFlows } from "./dev-flows";
import { seedDevData } from "./dev-seed";

const mode = process.argv[2] === "e2e" ? "e2e" : "dev";
const ports =
  mode === "e2e" ? { pg: 54329, api: 4010, web: 3010 } : { pg: 5433, api: 4000, web: 3000 };
const DEV_KEY = Buffer.from("kidos-dev-only-key-not-for-prod!").toString("base64");
const ADMIN = { user: "kidos_admin", password: "kidos_dev" };

/** Test runners kill this process abruptly, so throwaway data folders from earlier runs can be left behind. */
async function removeStaleE2eData(): Promise<void> {
  const prefix = "kidos-e2e-pg-";
  for (const name of await readdir(os.tmpdir())) {
    if (!name.startsWith(prefix)) continue;
    const full = path.join(os.tmpdir(), name);
    try {
      if (Date.now() - (await stat(full)).mtimeMs > 10 * 60_000) await rm(full, { recursive: true, force: true });
    } catch {
      // still in use or already gone: leave it
    }
  }
}

async function main(): Promise<void> {
  if (mode === "e2e") await removeStaleE2eData();
  const dataDir = mode === "e2e" ? await mkdtemp(path.join(os.tmpdir(), "kidos-e2e-pg-")) : path.resolve(".data/pg");
  await mkdir(path.dirname(dataDir), { recursive: true });

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    ...ADMIN,
    port: ports.pg,
    persistent: mode === "dev",
    onLog: () => {},
    onError: (e) => console.error("[postgres]", e),
  });
  if (!existsSync(path.join(dataDir, "PG_VERSION"))) await pg.initialise();
  await pg.start();
  try {
    await pg.createDatabase("kidos");
  } catch {
    // already exists
  }

  const adminUrl = `postgres://${ADMIN.user}:${ADMIN.password}@127.0.0.1:${ports.pg}/kidos`;
  const admin = new Pool({ connectionString: adminUrl, max: 2 });
  await admin.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kidos_app') THEN
        CREATE ROLE kidos_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kidos_app_login') THEN
        CREATE ROLE kidos_app_login LOGIN PASSWORD 'kidos_app_dev' NOSUPERUSER NOBYPASSRLS IN ROLE kidos_app;
      END IF;
    END $$`);
  const result = await migrate(admin);
  console.log(`[stack] migrations applied: ${result.applied.length}, already applied: ${result.skipped.length}`);

  if (mode === "dev") {
    await seedDevData(admin);
    console.log("[stack] dev accounts ready: open http://localhost:3000/login and use the quick sign-in panel");
  }

  const appUrl =`postgres://kidos_app_login:kidos_app_dev@127.0.0.1:${ports.pg}/kidos`;
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "development",
    DATABASE_APP_URL: appUrl,
    MFA_ENCRYPTION_KEY: process.env["MFA_ENCRYPTION_KEY"] ?? DEV_KEY,
    ALLOWED_ORIGINS: `http://localhost:${ports.web}`,
    APP_BASE_URL: `http://localhost:${ports.web}`,
    PORT: String(ports.api),
    ...(mode === "e2e" ? { AUTH_RATE_LIMIT_PER_MINUTE: "1000", GLOBAL_RATE_LIMIT_PER_MINUTE: "10000", EMAIL_COOLDOWN_SECONDS: "0" } : {}),
  });
  const pool = new Pool({ connectionString: appUrl, max: 10 });
  const outbox = process.env["MAIL_OUTBOX_FILE"];
  const mailer: Mailer = outbox ? new FileMailer(outbox) : new ConsoleMailer();
  const app = await buildApp({ pool, config, mailer }, { logger: mode === "dev", devQuickLogin: mode === "dev" });
  await app.listen({ port: ports.api, host: "127.0.0.1" });
  if (mode === "dev") {
    try {
      await seedDemoFlows(app, admin);
      console.log("[stack] demo requests ready (resident@dev.kidos.test): see /demo for a guided tour");
    } catch (err) {
      console.error("[stack] demo requests could not be created (the stack still works):", err instanceof Error ? err.message : err);
    }
  }
  console.log(`[stack] READY mode=${mode} api=http://127.0.0.1:${ports.api} postgres=127.0.0.1:${ports.pg} (admin ${ADMIN.user}/${ADMIN.password})`);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await app.close();
    await pool.end();
    await admin.end();
    await pg.stop();
    if (mode === "e2e") await rm(dataDir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
