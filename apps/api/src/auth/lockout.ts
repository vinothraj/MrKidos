export const MAX_FAILED_ATTEMPTS = 5;

/** Lock duration after `failedAttempts` consecutive failures (>= MAX): 15 min, doubling every further 5, capped at 60. */
export function lockMinutes(failedAttempts: number): number {
  return Math.min(60, 15 * 2 ** Math.floor((failedAttempts - MAX_FAILED_ATTEMPTS) / MAX_FAILED_ATTEMPTS));
}
