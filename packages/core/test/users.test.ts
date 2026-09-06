import {
  createClient,
  formatUserRef,
  parseUserList,
  parseUserRef,
  resolveUserIds,
  runUserAction,
  type UserRef,
} from '@lm/core';
import { describe, expect, it } from 'vitest';
import { apiError, type FakeRoute, fakeDeps, fakeFetch } from './helpers.js';

describe('parseUserRef / parseUserList', () => {
  it.each<[string, UserRef | null]>([
    ['alice', { username: 'alice', host: null }],
    ['alice@remote.example', { username: 'alice', host: 'remote.example' }],
    ['@alice@remote.example', { username: 'alice', host: 'remote.example' }],
    ['@alice', { username: 'alice', host: null }],
    ['  alice  ', { username: 'alice', host: null }],
    ['', null],
    ['   ', null],
    ['@', null],
  ])('parseUserRef(%j)', (line, expected) => {
    expect(parseUserRef(line)).toEqual(expected);
  });

  it('parses a list file, ignoring blank lines and CRLF', () => {
    expect(parseUserList('alice\r\n\r\nbob@remote.example\n@carol\n\n')).toEqual([
      { username: 'alice', host: null },
      { username: 'bob', host: 'remote.example' },
      { username: 'carol', host: null },
    ]);
  });

  it('formats refs back', () => {
    expect(formatUserRef({ username: 'a', host: null })).toBe('a');
    expect(formatUserRef({ username: 'a', host: 'h' })).toBe('a@h');
  });
});

function setup(route: FakeRoute) {
  const deps = fakeDeps();
  const fetch = fakeFetch(route);
  const client = createClient({
    origin: 'https://misskey.example',
    token: 'tok',
    fetch: fetch.fetch,
    retry: { pollBase: 0, netErrorWait: 0, rateLimitBase: 0, rateLimitMax: 0 },
    deps,
  });
  return { deps, fetch, client };
}

describe('resolveUserIds', () => {
  it('resolves ids and keeps unknown users (400) with id null', async () => {
    const { deps, fetch, client } = setup((call) =>
      call.body.username === 'ghost'
        ? { status: 400, body: apiError('NO_SUCH_USER', 'No such user.') }
        : { status: 200, body: { id: `id-${call.body.username}` } },
    );
    const refs = parseUserList('alice\nghost@remote.example\nbob');

    const resolved = await resolveUserIds(client, refs, deps);

    expect(resolved).toEqual([
      { ref: refs[0], id: 'id-alice' },
      { ref: refs[1], id: null },
      { ref: refs[2], id: 'id-bob' },
    ]);
    expect(fetch.calls.map((c) => c.body)).toEqual([
      { i: 'tok', username: 'alice', host: null },
      { i: 'tok', username: 'ghost', host: 'remote.example' },
      { i: 'tok', username: 'bob', host: null },
    ]);
    expect(deps.logger.lines).toContain(
      'warn: user not found: ghost@remote.example (HTTP 400 NO_SUCH_USER: No such user.)',
    );
    expect(deps.events.filter((e) => e.kind === 'step')).toHaveLength(3);
  });

  it('propagates other client errors', async () => {
    const { deps, client } = setup(() => ({ status: 401, body: apiError('AUTHENTICATION_FAILED') }));
    await expect(resolveUserIds(client, [{ username: 'a', host: null }], deps)).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
      httpStatus: 401,
    });
  });
});

describe('runUserAction', () => {
  const users = [
    { ref: { username: 'a', host: null }, id: 'u1' },
    { ref: { username: 'ghost', host: null }, id: null },
    { ref: { username: 'b', host: 'h' }, id: 'u2' },
  ];

  it.each([
    ['mute', 'mute/create'],
    ['block', 'blocking/create'],
  ] as const)('%s calls %s for every resolved user', async (action, endpoint) => {
    const { deps, fetch, client } = setup(() => ({ status: 204 }));

    const result = await runUserAction(client, action, users, deps);

    expect(result).toEqual({ action, total: 2, done: 2, skipped: 0, unresolved: 1, dryRun: false });
    expect(fetch.calls.map((c) => [c.endpoint, c.body.userId])).toEqual([
      [endpoint, 'u1'],
      [endpoint, 'u2'],
    ]);
  });

  it('counts 400 as skipped and continues', async () => {
    const { deps, client } = setup((call) =>
      call.body.userId === 'u1' ? { status: 400, body: apiError('ALREADY_MUTING') } : { status: 204 },
    );
    const result = await runUserAction(client, 'mute', users, deps);
    expect(result).toMatchObject({ done: 1, skipped: 1 });
  });

  it('propagates other errors', async () => {
    const { deps, client } = setup(() => ({ status: 403, body: apiError('PERMISSION_DENIED') }));
    await expect(runUserAction(client, 'block', users, deps)).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('dry-run never calls the server', async () => {
    const { deps, fetch, client } = setup(() => ({ status: 204 }));
    const result = await runUserAction(client, 'block', users, { ...deps, dryRun: true });
    expect(result).toEqual({ action: 'block', total: 2, done: 2, skipped: 0, unresolved: 1, dryRun: true });
    expect(fetch.calls).toHaveLength(0);
    expect(deps.logger.lines).toContain('info: would block: a u1 (1/2)');
  });
});
