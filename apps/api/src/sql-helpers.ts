import type { PoolClient } from "pg";

/** Maps only whitelisted API keys to columns. Anything else is ignored (schemas already reject unknown keys). */
export function columnsFrom(map: Record<string, string>, body: Record<string, unknown>): { cols: string[]; values: unknown[] } {
  const cols: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(map)) {
    if (key in body) {
      cols.push(column);
      values.push(body[key]);
    }
  }
  return { cols, values };
}

/** INSERT with a primary key plus whitelisted columns. `table` and `keyColumn` are code constants, never input. */
export async function insertRow(c: PoolClient, table: string, keyColumn: string, keyValue: string, map: Record<string, string>, body: Record<string, unknown>): Promise<void> {
  const { cols, values } = columnsFrom(map, body);
  const columns = [keyColumn, ...cols];
  await c.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`, [keyValue, ...values]);
}

/** UPDATE the whitelisted columns of one row. No-op when none were supplied. */
export async function updateRow(c: PoolClient, table: string, keyColumn: string, keyValue: string, map: Record<string, string>, body: Record<string, unknown>): Promise<void> {
  const { cols, values } = columnsFrom(map, body);
  if (cols.length === 0) return;
  await c.query(`UPDATE ${table} SET ${cols.map((col, i) => `${col} = $${i + 2}`).join(", ")} WHERE ${keyColumn} = $1`, [keyValue, ...values]);
}

/** LIKE pattern for a user-supplied search term, with the wildcard characters escaped. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/gu, (m) => `\\${m}`)}%`;
}
