import { api } from 'misskey-js';
import type { CoreDeps } from './ports.js';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from './retry/policy.js';
import { type RawFetch, withRetry } from './retry/withRetry.js';

export interface NormalizedOrigin {
  origin: string;
  /** `true` when a trailing `/api` or `/` was removed (the old `LM_BASE_URL` format). */
  changed: boolean;
}

/** `https://misskey.io/api/` -> `https://misskey.io` (plan §5.1 compatibility). */
export function normalizeOrigin(input: string): NormalizedOrigin {
  const trimmed = input.trim();
  const origin = trimmed
    .replace(/\/+$/, '')
    .replace(/\/api$/, '')
    .replace(/\/+$/, '');
  return { origin, changed: origin !== trimmed };
}

export interface CreateClientOptions {
  /** Server origin, e.g. `https://misskey.io` (a trailing `/api` is tolerated). */
  origin: string;
  token: string;
  retry?: Partial<RetryPolicy>;
  /** Underlying fetch; defaults to the global `fetch`. */
  fetch?: RawFetch;
  /** Extra request headers (e.g. `User-Agent`). */
  headers?: Readonly<Record<string, string>>;
  deps: CoreDeps;
}

/** Create a misskey-js `APIClient` whose fetch is wrapped with `withRetry`. */
export function createClient(opts: CreateClientOptions): api.APIClient {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...opts.retry };
  const base: RawFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const extraHeaders = opts.headers;
  const withHeaders: RawFetch =
    extraHeaders === undefined
      ? base
      : (input, init) => base(input, { ...init, headers: { ...extraHeaders, ...init?.headers } });
  return new api.APIClient({
    origin: normalizeOrigin(opts.origin).origin,
    credential: opts.token,
    fetch: withRetry(withHeaders, policy, opts.deps),
  });
}
