import { createClient, describeError, getHttpStatus, isApiError, normalizeOrigin } from '@lm/core';
import { describe, expect, it } from 'vitest';
import { apiError, fakeDeps, fakeFetch, sequence } from './helpers.js';

describe('normalizeOrigin', () => {
  it.each([
    ['https://misskey.io', 'https://misskey.io', false],
    ['https://misskey.io/', 'https://misskey.io', true],
    ['https://misskey.io/api', 'https://misskey.io', true],
    ['https://misskey.io/api/', 'https://misskey.io', true],
    ['  https://misskey.io/api  ', 'https://misskey.io', true],
    ['https://example.org/misskey/api', 'https://example.org/misskey', true],
  ])('%s -> %s', (input, origin, changed) => {
    expect(normalizeOrigin(input)).toEqual({ origin, changed });
  });
});

describe('createClient', () => {
  it('posts JSON with the token to <origin>/api/<endpoint> using the injected fetch and headers', async () => {
    const deps = fakeDeps();
    const fetch = fakeFetch(sequence({ status: 200, body: { id: 'me', pinnedNoteIds: [] } }));
    const client = createClient({
      origin: 'https://misskey.example/api/',
      token: 'tok',
      fetch: fetch.fetch,
      headers: { 'User-Agent': 'lm-test/1' },
      retry: { pollBase: 0 },
      deps,
    });

    const me = await client.request('i', {});

    expect(me.id).toBe('me');
    expect(client.origin).toBe('https://misskey.example');
    const call = fetch.calls[0];
    expect(call?.endpoint).toBe('i');
    expect(call?.body).toEqual({ i: 'tok' });
    expect(call?.init?.method).toBe('POST');
    expect(call?.init?.headers).toEqual({ 'User-Agent': 'lm-test/1', 'Content-Type': 'application/json' });
  });

  it('rejects with the API error carrying httpStatus', async () => {
    const deps = fakeDeps();
    const fetch = fakeFetch(sequence({ status: 400, body: apiError('NO_SUCH_USER', 'No such user.') }));
    const client = createClient({ origin: 'https://misskey.example', token: 'tok', fetch: fetch.fetch, deps });

    const error: unknown = await client.request('users/show', { username: 'x' }).catch((e: unknown) => e);

    expect(isApiError(error)).toBe(true);
    expect(getHttpStatus(error)).toBe(400);
    expect(describeError(error)).toBe('HTTP 400 NO_SUCH_USER: No such user.');
  });

  it('describeError handles plain errors and non-errors', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError('str')).toBe('str');
    expect(getHttpStatus(new Error('x'))).toBeUndefined();
    expect(isApiError(null)).toBe(false);
  });
});
