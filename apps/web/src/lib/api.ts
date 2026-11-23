export interface FieldIssue {
  field: string;
  message: string;
}

/** Error returned by the API (or a network failure, status 0). `code` is stable and safe to branch on. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: FieldIssue[] = [],
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: unknown; requestId?: string };
}

function isFieldIssues(value: unknown): value is FieldIssue[] {
  return (
    Array.isArray(value) &&
    value.every((v) => typeof v === "object" && v !== null && typeof (v as FieldIssue).field === "string" && typeof (v as FieldIssue).message === "string")
  );
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

let platformMode = false;

/**
 * Platform staff can act for the whole platform instead of one organization. When on, every API call asks for platform
 * scope; the API still verifies the person is platform staff and holds the permission for each action.
 */
export function setPlatformMode(on: boolean): void {
  platformMode = on;
}

/** Calls the API through the same-origin /api proxy. Resolves to undefined for 204 responses. */
export async function api<T = undefined>(path: string, options: ApiOptions = {}): Promise<T> {
  const init: RequestInit = { method: options.method ?? "GET", credentials: "same-origin" };
  const headers: Record<string, string> = {};
  if (platformMode) headers["x-platform-scope"] = "on";
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  if (Object.keys(headers).length > 0) init.headers = headers;
  if (options.signal) init.signal = options.signal;

  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "network_error", "We could not reach the server. Check your connection and try again.");
  }

  if (res.status === 204) return undefined as T;
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    const e = (parsed as ErrorBody | undefined)?.error;
    throw new ApiError(
      res.status,
      e?.code ?? "unknown_error",
      e?.message ?? "Something went wrong. Please try again.",
      isFieldIssues(e?.details) ? e.details : [],
      e?.requestId,
    );
  }
  return parsed as T;
}

/** Splits an error into a summary message and per-field messages for form display. */
export function describeError(err: unknown): { summary: string; fields: Record<string, string> } {
  if (err instanceof ApiError) {
    const fields: Record<string, string> = {};
    for (const d of err.details) if (!(d.field in fields)) fields[d.field] = d.message;
    return { summary: err.code === "validation_failed" ? "Please check the highlighted fields." : err.message, fields };
  }
  return { summary: "Something went wrong. Please try again.", fields: {} };
}
