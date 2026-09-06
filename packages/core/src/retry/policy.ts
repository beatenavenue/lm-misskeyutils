/** Retry / pacing parameters. All durations are in seconds (like the `LM_*` settings). */
export interface RetryPolicy {
  /** Wait after every successful call. */
  pollBase: number;
  /** Wait before retrying after a 5xx response or a network error. */
  netErrorWait: number;
  /** Give up after this many consecutive 5xx / network errors for one request. */
  maxNetErrorRetries: number;
  /** First fallback wait on 429 without retry information. */
  rateLimitBase: number;
  /** Upper bound for the fallback back-off. */
  rateLimitMax: number;
  /** Per-endpoint override of `pollBase` (e.g. `{ 'users/show': 0 }`). */
  pollBaseOverrides?: Readonly<Record<string, number>>;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  pollBase: 3,
  netErrorWait: 300,
  maxNetErrorRetries: 5,
  rateLimitBase: 600,
  rateLimitMax: 43200,
  // user name resolution ran with wait=0 in the Python version
  pollBaseOverrides: { 'users/show': 0 },
};

export function pollBaseFor(policy: RetryPolicy, endpoint: string): number {
  return policy.pollBaseOverrides?.[endpoint] ?? policy.pollBase;
}

/** Retry information extracted from a 429 response. */
export interface RateLimitInfo {
  /** `Retry-After` header value (seconds or HTTP date), if any. */
  retryAfter?: string | null;
  /** `error.info` from the response body, if any. */
  info?: unknown;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Seconds to wait according to the server's retry information, or `null`
 * when the response carries none (caller falls back to exponential back-off).
 *
 * Precedence: `Retry-After` header, `info.resetSec`, `info.resetMs`, `info.reset`.
 * `info.reset` is interpreted heuristically because its unit differs between
 * Misskey versions (plan §8 #1): values above 1e12 are epoch milliseconds,
 * above 1e9 epoch seconds, anything else relative seconds.
 */
export function rateLimitWaitSeconds(info: RateLimitInfo, nowMs: number): number | null {
  const header = info.retryAfter;
  if (header != null && header.trim() !== '') {
    const seconds = asNumber(header);
    if (seconds !== null) return Math.max(0, seconds);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, (date - nowMs) / 1000);
  }

  const body = typeof info.info === 'object' && info.info !== null ? (info.info as Record<string, unknown>) : {};
  const resetSec = asNumber(body.resetSec);
  if (resetSec !== null) return Math.max(0, resetSec);
  const resetMs = asNumber(body.resetMs);
  if (resetMs !== null) return Math.max(0, resetMs / 1000);
  const reset = asNumber(body.reset);
  if (reset !== null) {
    if (reset > 1e12) return Math.max(0, (reset - nowMs) / 1000);
    if (reset > 1e9) return Math.max(0, reset - nowMs / 1000);
    return Math.max(0, reset);
  }
  return null;
}

/** Fallback exponential back-off: `rateLimitBase`, then doubling, capped at `rateLimitMax`. */
export function nextBackoff(previous: number, policy: RetryPolicy): number {
  const next = previous > 0 ? previous * 2 : policy.rateLimitBase;
  return Math.min(next, policy.rateLimitMax);
}
