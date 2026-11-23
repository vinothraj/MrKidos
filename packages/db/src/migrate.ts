import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * Applies pending SQL migrations in filename order, each in its own transaction.
 * Already-applied migrations are verified by checksum: editing an applied file is an error.
 * Must be run with a role allowed to create tables and roles (never the application role).
 */
export async function migrate(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<MigrationResult> {
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    // Serialize concurrent migrators.
    await client.query("SELECT pg_advisory_lock(727274)");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);

    const files = (await readdir(dir)).filter((f) => MIGRATION_FILE.test(f)).sort();
    const { rows } = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations",
    );
    const appliedByName = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const sql = await readFile(path.join(dir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = appliedByName.get(file);
      if (existing !== undefined) {
        if (existing !== checksum) {
          throw new Error(
            `Migration ${file} was modified after being applied (checksum mismatch). Create a new migration instead.`,
          );
        }
        result.skipped.push(file);
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
          file,
          checksum,
        ]);
        await client.query("COMMIT");
        result.applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    return result;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(727274)");
    } finally {
      client.release();
    }
  }
}
