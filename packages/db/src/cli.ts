import { Pool } from "pg";
import { migrate } from "./migrate";

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "migrate") {
    console.error("Usage: tsx packages/db/src/cli.ts migrate");
    process.exitCode = 2;
    return;
  }
  const url =
    process.env["DATABASE_ADMIN_URL"] ?? "postgres://kidos_admin:kidos_dev@localhost:5433/kidos";
  const pool = new Pool({ connectionString: url });
  try {
    const result = await migrate(pool);
    console.log(`Applied: ${result.applied.length ? result.applied.join(", ") : "none"}`);
    console.log(`Already applied: ${result.skipped.length}`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
