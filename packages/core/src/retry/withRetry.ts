import type { api } from 'misskey-js';
import { describeError, isAbortError, RetryExhaustedError, throwIfAborted } from '../errors.js';
import type { CoreDeps } from '../ports.js';
import { nextBackoff, pollBaseFor, type RetryPolicy, rateLimitWaitSeconds } from './policy.js';
import { waitSeconds } from './wait.js';

export type FetchLike = api.FetchLike;
export type RawFetchInit = Parameters<FetchLike>[1];

/** What the wrapper needs from the underlying fetch: status, optional headers and a JSON body. */
export interface RawResponse {
  status: number;
  headers?: { get(name: string): string | null } | undefined;
  json(): Promise<unknown>;
}

export type RawFetch = (input: string, init?: RawFetchInit) => Promise<RawResponse>;

/** `https://host/api/users/notes` -> `users/notes` */
export function endpointFromUrl(url: string): string {
  const index = url.indexOf('/api/');
  return index === -1 ? url : url.slice(index + '/api/'.length);
}

async function readJson(res: RawResponse): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * Re-attach the HTTP status to the error body so callers can distinguish 400
 * from other client errors (misskey-js only forwards `body.error`).
 */
function withHttpStatus(body: unknown, status: number): { error: Record<string, unknown> } {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const error =
    typeof record.error === 'object' && record.error !== null ? (record.error as Record<string, unknown>) : {};
  return {
    ...record,
    error: {
      id: '',
      code: 'HTTP_ERROR',
      message: `HTTP ${status}`,
      kind: 'client',
      info: {},
      ...error,
      httpStatus: status,
    },
  };
}

/**
 * Wrap a fetch implementation with Misskey-aware pacing and retries
 * (REFACTORING_PLAN.md §3.3):
 *
 * - 200 / 204: wait `pollBase` (per-endpoint override possible), return.
 * - 429: wait `Retry-After` / `error.info.reset` + `pollBase`, or fall back to
 *   exponential back-off; retry.
 * - 5xx and fetch exceptions: wait `netErrorWait`, retry up to `maxNetErrorRetries`.
 * - other 4xx: returned to `APIClient` (which rejects) with `httpStatus` attached.
 *
 * Only the method, endpoint, status and wait times are logged, never the body.
 */
export function withRetry(base: RawFetch, policy: RetryPolicy, deps: CoreDeps): FetchLike {
  const { logger } = deps;
  return async (input, init) => {
    const endpoint = endpointFromUrl(input);
    let backoff = 0;
    let netErrors = 0;
    let attempt = 0;

    for (;;) {
      attempt++;
      throwIfAborted(deps.signal);

      let res: RawResponse;
      try {
        res = await base(input, init);
      } catch (error) {
        if (isAbortError(error)) throw error;
        netErrors++;
        logger.warn(
          `network failure on ${endpoint}: ${describeError(error)} (${netErrors}/${policy.maxNetErrorRetries})`,
        );
        if (netErrors > policy.maxNetErrorRetries) {
          throw new RetryExhaustedError(endpoint, attempt, undefined, { cause: error });
        }
        await waitSeconds(policy.netErrorWait, 'net-error', deps);
        continue;
      }

      const { status } = res;
      logger.debug(`POST ${endpoint} -> ${status}`);

      if (status === 200 || status === 204) {
        await waitSeconds(pollBaseFor(policy, endpoint), 'poll', deps);
        return res;
      }

      if (status === 429) {
        const body = (await readJson(res)) as { error?: { info?: unknown } } | undefined;
        const known = rateLimitWaitSeconds(
          { retryAfter: res.headers?.get('Retry-After') ?? null, info: body?.error?.info },
          deps.clock.now(),
        );
        let wait: number;
        if (known !== null) {
          wait = known + pollBaseFor(policy, endpoint);
          logger.info(`429 rate limit on ${endpoint}: server asks to retry in ${Math.ceil(known)}s`);
        } else {
          backoff = nextBackoff(backoff, policy);
          wait = backoff;
          logger.info(`429 rate limit on ${endpoint} without retry information: backing off ${wait}s`);
        }
        await waitSeconds(wait, 'rate-limit', deps);
        continue;
      }

      if (status >= 500) {
        netErrors++;
        logger.warn(`HTTP ${status} on ${endpoint} (${netErrors}/${policy.maxNetErrorRetries})`);
        if (netErrors > policy.maxNetErrorRetries) {
          throw new RetryExhaustedError(endpoint, attempt, status);
        }
        await waitSeconds(policy.netErrorWait, 'net-error', deps);
        continue;
      }

      const body = await readJson(res);
      const decorated = withHttpStatus(body, status);
      return { status, json: async () => decorated };
    }
  };
}
