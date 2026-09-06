import { createClient, listAllNotes, type NoteLike, parseExportedNotes, parseRules, runDaysExpire } from '@lm/core';
import { describe, expect, it } from 'vitest';
import { apiError, type FakeRoute, fakeDeps, fakeFetch, note } from './helpers.js';

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

/** Serve `users/notes` pages of `size` from `all`, keyed by untilId. */
function pagedNotes(all: ReturnType<typeof note>[], size: number) {
  return (untilId: unknown) => {
    const start = untilId === undefined ? 0 : all.findIndex((n) => n.id === untilId) + 1;
    return all.slice(start, start + size);
  };
}

describe('listAllNotes', () => {
  it('pages with untilId, requests replies/renotes/channel notes and stops on an empty page', async () => {
    const all = [note('n5', 1, 0), note('n4', 2, 0), note('n3', 3, 0), note('n2', 4, 0), note('n1', 5, 0)];
    const pages = pagedNotes(all, 2);
    const { deps, fetch, client } = setup((call) => ({ status: 200, body: pages(call.body.untilId) }));

    const seen: string[] = [];
    for await (const page of listAllNotes(client, 'me', { limit: 2, logger: deps.logger })) {
      seen.push(...page.map((n) => n.id));
    }

    expect(seen).toEqual(['n5', 'n4', 'n3', 'n2', 'n1']);
    expect(fetch.calls.map((c) => c.body.untilId)).toEqual([undefined, 'n4', 'n2', 'n1']);
    expect(fetch.calls[0]?.body).toEqual({
      i: 'tok',
      userId: 'me',
      limit: 2,
      withReplies: true,
      withRenotes: true,
      withChannelNotes: true,
    });
  });
});

describe('runDaysExpire', () => {
  const now = Date.UTC(2026, 8, 1);
  const rules = parseRules([{ day: 30, pinned: true, reactionCount: 1 }]);

  function server(all: ReturnType<typeof note>[], deleteStatus: (id: unknown) => number = () => 204): FakeRoute {
    const pages = pagedNotes(all, 100);
    return (call) => {
      switch (call.endpoint) {
        case 'i':
          return { status: 200, body: { id: 'me', pinnedNoteIds: ['pin'] } };
        case 'users/notes':
          return { status: 200, body: pages(call.body.untilId) };
        case 'notes/delete': {
          const status = deleteStatus(call.body.noteId);
          return status === 204 ? { status } : { status, body: apiError('NO_SUCH_NOTE') };
        }
        default:
          throw new Error(`unexpected endpoint ${call.endpoint}`);
      }
    };
  }

  const all = [
    note('pin', 400, now),
    note('reacted', 400, now, { reactionCount: 3 }),
    note('doomed', 400, now),
    note('fresh', 1, now),
  ];

  it('deletes the candidates and reports counts', async () => {
    const { deps, fetch, client } = setup(server(all));
    const listed: NoteLike[][] = [];

    const result = await runDaysExpire(client, { ...deps, rules, onNotesListed: (n) => listed.push([...n]) });

    expect(result).toEqual({
      userId: 'me',
      pinnedIds: ['pin'],
      apiNoteCount: 4,
      exportOnlyIds: [],
      noteCount: 4,
      deleteIds: ['doomed'],
      deleted: 1,
      failed: 0,
      dryRun: false,
    });
    expect(fetch.calls.filter((c) => c.endpoint === 'notes/delete').map((c) => c.body.noteId)).toEqual(['doomed']);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.map((n) => n.id)).toEqual(['pin', 'reacted', 'doomed', 'fresh']);
  });

  it('dry-run evaluates but never deletes', async () => {
    const { deps, fetch, client } = setup(server(all));
    const result = await runDaysExpire(client, { ...deps, rules, dryRun: true });
    expect(result).toMatchObject({ deleteIds: ['doomed'], deleted: 0, dryRun: true });
    expect(fetch.calls.some((c) => c.endpoint === 'notes/delete')).toBe(false);
    expect(deps.logger.lines).toContain('info: would delete: doomed');
  });

  it('merges exported notes, warns about export-only notes and continues after a 400 on delete', async () => {
    const exported = parseExportedNotes([
      { id: 'gone', createdAt: new Date(now - 400 * 86_400_000).toISOString(), replyId: null, renoteId: null },
      { id: 'doomed', createdAt: 'ignored-because-api-wins', replyId: null, renoteId: null },
    ]);
    const { deps, fetch, client } = setup(server(all, (id) => (id === 'gone' ? 400 : 204)));

    const result = await runDaysExpire(client, { ...deps, rules, exportedNotes: exported });

    expect(result).toMatchObject({
      apiNoteCount: 4,
      noteCount: 5,
      exportOnlyIds: ['gone'],
      deleteIds: ['gone', 'doomed'], // export order first, then API-only notes (Python dict merge order)
      deleted: 1,
      failed: 1,
    });
    expect(fetch.calls.filter((c) => c.endpoint === 'notes/delete')).toHaveLength(2);
    expect(deps.logger.lines.some((l) => l.startsWith('warn: 1 notes exist only in the export'))).toBe(true);
    expect(deps.logger.lines.some((l) => l.startsWith('error: Error deleting gone: HTTP 400 NO_SUCH_NOTE'))).toBe(true);
  });

  it('falls back to pinnedNotes when pinnedNoteIds is missing', async () => {
    const route = server(all);
    const { deps, client } = setup((call, i) =>
      call.endpoint === 'i' ? { status: 200, body: { id: 'me', pinnedNotes: [{ id: 'pin' }] } } : route(call, i),
    );
    const result = await runDaysExpire(client, { ...deps, rules, dryRun: true });
    expect(result.pinnedIds).toEqual(['pin']);
  });

  it('goes through the retrying client for step 1 as well', async () => {
    const route = server(all);
    let first = true;
    const { deps, fetch, client } = setup((call, i) => {
      if (call.endpoint === 'i' && first) {
        first = false;
        return { status: 429, headers: { 'Retry-After': '1' }, body: apiError('RATE_LIMIT_EXCEEDED') };
      }
      return route(call, i);
    });
    const result = await runDaysExpire(client, { ...deps, rules, dryRun: true });
    expect(result.userId).toBe('me');
    expect(fetch.calls.filter((c) => c.endpoint === 'i')).toHaveLength(2);
    expect(deps.sleptSeconds).toBe(1);
  });
});
