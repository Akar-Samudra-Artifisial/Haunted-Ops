export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 30_000;

/** Upper bound of the delay for an attempt: 1 s, 2 s, 4 s ... capped at 30 s. */
export function backoffCeiling(attempt: number): number {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  // 2^15 s is already past the cap; avoid huge exponents.
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(n, 15));
}

/**
 * Exponential backoff with equal jitter: a delay in [ceiling / 2, ceiling].
 * `rand` is a value in [0, 1), injectable for tests.
 */
export function nextDelay(attempt: number, rand: number = Math.random()): number {
  const ceiling = backoffCeiling(attempt);
  const r = Number.isFinite(rand) ? Math.min(Math.max(rand, 0), 1) : 0;
  return Math.round(ceiling / 2 + (r * ceiling) / 2);
}

/** Upper bound for a server-requested Retry-After, so a bad header cannot park the client forever. */
export const MAX_RETRY_AFTER_MS = 5 * 60_000;

/**
 * Delay before the next reconnect: the jittered backoff, or the server's
 * Retry-After (capped at 5 minutes) when that is longer.
 */
export function reconnectDelay(attempt: number, rand: number, retryAfterMs?: number): number {
  const backoff = nextDelay(attempt, rand);
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs)) return backoff;
  return Math.max(backoff, Math.min(Math.max(0, retryAfterMs), MAX_RETRY_AFTER_MS));
}
