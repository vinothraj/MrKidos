/** Error with a stable machine-readable code, safe to show to clients. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const unauthenticated = () => new AppError(401, "unauthenticated", "Authentication is required.");
export const forbidden = () => new AppError(403, "forbidden", "You do not have permission to do this.");

/** PostgreSQL unique_violation. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

/** PostgreSQL insufficient_privilege, which is also what a failed row-level security check raises. */
export function isRlsViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "42501";
}
