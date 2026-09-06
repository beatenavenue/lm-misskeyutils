import {
  DEFAULT_RETRY_POLICY,
  endpointFromUrl,
  nextBackoff,
  OperationAbortedError,
  pollBaseFor,
  RetryExhaustedError,
  type RetryPolicy,
  rateLimitWaitSeconds,
  withRetry,
} from '@lm/core';
import { describe, expect, it } from 'vitest';
import { apiError, fakeDeps, fakeFetch, sequence } from './helpers.js';

const policy: RetryPolicy = {
  pollBase: 3,
  netErrorWait: 300,
  maxNetErrorRetries: 2,
  rateLimitBase: 600,
  rateLimitMax: 2000,
  pollBaseOverrides: { 'users/show': 0 },
};

const URL_NOTES = 'https://misskey.example/api/users/notes';

function run(route: Parameters<typeof fakeFetch>[0], url = URL_NOTES, overrides: Partial<RetryPolicy> = {}) {
  const deps = fakeDeps();
  const fetch = fakeFetch(route);
  const wrapped = withRetry(fetch.fetch, { ...policy, ...overrides }, deps);
  const promise = wrapped(url, { method: 'POST', body: '{"i":"t"}', headers: {} });
  return { deps, fetch, promise };
}

describe('policy helpers', () => {
  it('endpointFromUrl strips everything up to /api/', () => {
    expect(endpointFromUrl(URL_NOTES)).toBe('users/notes');
    expect(endpointFromUrl('no-api-here')).toBe('no-api-here');
  });

  it('pollBaseFor honours per-endpoint overrides', () => {
    expect(pollBaseFor(policy, 'users/notes')).toBe(3);
    expect(pollBaseFor(policy, 'users/show')).toBe(0);
    expect(DEFAULT_RETRY_POLICY.pollBaseOverrides).toEqual({ 'users/show': 0 });
  });

  it('nextBackoff starts at base, doubles and caps', () => {
    expect(nextBackoff(0, policy)).toBe(600);
    expect(nextBackoff(600, policy)).toBe(1200);
    expect(nextBackoff(1200, policy)).toBe(2000);
    expect(nextBackoff(2000, policy)).toBe(2000);
  });

  const now = Date.UTC(2026, 8, 1); // 1_788_566_400_000 ms
  it.each([
    ['Retry-After seconds', { retryAfter: '42' }, 42],
    ['Retry-After HTTP date', { retryAfter: new Date(now + 90_000).toUTCString() }, 90],
    ['resetSec (relative seconds)', { info: { resetSec: 7 } }, 7],
    ['resetMs (relative milliseconds)', { info: { resetMs: 2500 } }, 2.5],
    ['reset as epoch seconds', { info: { reset: now / 1000 + 30 } }, 30],
    ['reset as epoch milliseconds', { info: { reset: now + 45_000 } }, 45],
    ['reset as relative seconds', { info: { reset: 12 } }, 12],
    ['reset as numeric string', { info: { reset: '12' } }, 12],
    ['reset in the past clamps to 0', { info: { reset: now / 1000 - 30 } }, 0],
    ['nothing usable', { retryAfter: 'soon', info: { blocked: true } }, null],
    ['empty', {}, null],
  ])('rateLimitWaitSeconds: %s', (_label, info, expected) => {
    expect(rateLimitWaitSeconds(info, now)).toBe(expected);
  });

  it('prefers Retry-After over the body', () => {
    expect(rateLimitWaitSeconds({ retryAfter: '5', info: { resetSec: 99 } }, now)).toBe(5);
  });
});

describe('withRetry', () => {
  it('waits pollBase after a 200 and returns the response', async () => {
    const { deps, promise } = run(sequence({ status: 200, body: [] }));
    const res = await promise;
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([]);
    expect(deps.sleptSeconds).toBe(3);
    expect(deps.events.filter((e) => e.kind === 'wait')).toHaveLength(3);
    expect(deps.events.at(-1)).toEqual({ kind: 'wait-end', reason: 'poll' });
  });

  it('uses the per-endpoint pollBase override (0 for users/show)', async () => {
    const { deps, promise } = run(sequence({ status: 200, body: {} }), 'https://misskey.example/api/users/show');
    await promise;
    expect(deps.sleptSeconds).toBe(0);
  });

  it('204 counts as success', async () => {
    const { promise } = run(sequence({ status: 204 }));
    expect((await promise).status).toBe(204);
  });

  it('429 with Retry-After waits Retry-After + pollBase and retries', async () => {
    const { deps, fetch, promise } = run(
      sequence(
        { status: 429, headers: { 'Retry-After': '10' }, body: apiError('RATE_LIMIT_EXCEEDED') },
        { status: 200, body: [] },
      ),
    );
    await promise;
    expect(fetch.calls).toHaveLength(2);
    expect(deps.sleptSeconds).toBe(13 + 3);
    expect(deps.logger.lines).toContain('info: 429 rate limit on users/notes: server asks to retry in 10s');
  });

  it('429 with only error.info.reset uses the body', async () => {
    const { deps, promise } = run(
      sequence(
        { status: 429, body: apiError('RATE_LIMIT_EXCEEDED', 'limit', { info: { reset: 8 } }) },
        { status: 200, body: [] },
      ),
    );
    await promise;
    expect(deps.sleptSeconds).toBe(8 + 3 + 3);
  });

  it('429 without retry information backs off exponentially up to the cap', async () => {
    const limited = { status: 429, body: apiError('RATE_LIMIT_EXCEEDED') };
    const { deps, fetch, promise } = run(sequence(limited, limited, limited, limited, { status: 200, body: [] }));
    await promise;
    expect(fetch.calls).toHaveLength(5);
    const waits = deps.events
      .filter((e): e is Extract<typeof e, { kind: 'wait' }> => e.kind === 'wait' && e.elapsedSeconds === 0)
      .map((e) => e.totalSeconds);
    expect(waits).toEqual([600, 1200, 2000, 2000, 3]);
  });

  it('429 with an unreadable body falls back to back-off', async () => {
    const { deps, promise } = run(sequence({ status: 429 }, { status: 200, body: [] }));
    await promise;
    expect(deps.sleptSeconds).toBe(600 + 3);
  });

  it('retries 5xx after netErrorWait and gives up after maxNetErrorRetries', async () => {
    const { deps, fetch, promise } = run(sequence({ status: 502 }));
    await expect(promise).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(fetch.calls).toHaveLength(3); // 1 + maxNetErrorRetries
    expect(deps.sleptSeconds).toBe(600);
  });

  it('recovers from 5xx when the server comes back', async () => {
    const { deps, fetch, promise } = run(sequence({ status: 503 }, { status: 200, body: [] }));
    await promise;
    expect(fetch.calls).toHaveLength(2);
    expect(deps.sleptSeconds).toBe(303);
  });

  it('treats fetch exceptions like 5xx', async () => {
    const boom = new TypeError('fetch failed');
    const { deps, fetch, promise } = run(sequence(boom, boom, { status: 200, body: [] }));
    await promise;
    expect(fetch.calls).toHaveLength(3);
    expect(deps.sleptSeconds).toBe(603);
    expect(deps.logger.lines[0]).toBe('warn: network failure on users/notes: fetch failed (1/2)');
  });

  it('gives up on persistent fetch exceptions with the cause attached', async () => {
    const boom = new TypeError('fetch failed');
    const { promise } = run(sequence(boom));
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetryExhaustedError);
    expect((error as RetryExhaustedError).cause).toBe(boom);
    expect((error as RetryExhaustedError).lastStatus).toBeUndefined();
  });

  it('returns other 4xx untouched apart from the attached httpStatus', async () => {
    const { deps, fetch, promise } = run(sequence({ status: 403, body: apiError('PERMISSION_DENIED', 'nope') }));
    const res = await promise;
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: expect.objectContaining({ code: 'PERMISSION_DENIED', message: 'nope', httpStatus: 403 }),
    });
    expect(fetch.calls).toHaveLength(1);
    expect(deps.sleptSeconds).toBe(0);
  });

  it('synthesises an error body for a 4xx without JSON', async () => {
    const { promise } = run(sequence({ status: 404 }));
    await expect((await promise).json()).resolves.toEqual({
      error: expect.objectContaining({ code: 'HTTP_ERROR', message: 'HTTP 404', httpStatus: 404 }),
    });
  });

  it('never logs the request body', async () => {
    const { deps, promise } = run(sequence({ status: 200, body: [] }));
    await promise;
    expect(deps.logger.lines.join('\n')).not.toContain('"i"');
    expect(deps.logger.lines).toContain('debug: POST users/notes -> 200');
  });

  it('stops waiting when the signal aborts', async () => {
    const controller = new AbortController();
    const deps = fakeDeps({ signal: controller.signal });
    deps.sleep = async () => {
      controller.abort();
    };
    const fetch = fakeFetch(sequence({ status: 429, body: apiError('RATE_LIMIT_EXCEEDED') }));
    const wrapped = withRetry(fetch.fetch, policy, deps);
    await expect(wrapped(URL_NOTES, { method: 'POST', body: '{}', headers: {} })).rejects.toBeInstanceOf(
      OperationAbortedError,
    );
    expect(fetch.calls).toHaveLength(1);
  });

  it('does not call fetch at all when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const deps = fakeDeps({ signal: controller.signal });
    const fetch = fakeFetch(sequence({ status: 200, body: [] }));
    await expect(
      withRetry(fetch.fetch, policy, deps)(URL_NOTES, { method: 'POST', body: '{}', headers: {} }),
    ).rejects.toBeInstanceOf(OperationAbortedError);
    expect(fetch.calls).toHaveLength(0);
  });
});
