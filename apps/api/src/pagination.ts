import { z } from "zod";
import { AppError } from "./errors";

/**
 * Keyset pagination over (created_at, id), newest first. The cursor carries the timestamp as text with full
 * microsecond precision: a JavaScript Date would truncate to milliseconds and silently skip rows.
 */
export interface Cursor {
  t: string;
  i: string;
}

/** SQL expression that renders a timestamptz column with microsecond precision for use in a cursor. */
export const cursorTimestamp = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export function encodeCursor(t: string, i: string): string {
  return Buffer.from(JSON.stringify({ t, i })).toString("base64url");
}

export function decodeCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor>;
    return {
      t: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u).parse(parsed.t),
      i: z.uuid().parse(parsed.i),
    };
  } catch {
    throw new AppError(400, "invalid_cursor", "The pagination cursor is not valid.");
  }
}

export const pageParams = {
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
};
