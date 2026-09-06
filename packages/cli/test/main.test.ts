import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { apiError, fakeFetch, note } from '../../core/test/helpers.js';
import { parseCliArgs, runCli, USAGE, UsageError } from '../src/main.js';
import { VERSION } from '../src/version.js';

describe('parseCliArgs', () => {
  it('parses days-expire with its options', () => {
    expect(parseCliArgs(['days-expire', '-n', '--rules', 'r.json', '--export', 'none', '--print-notes'])).toEqual({
      kind: 'days-expire',
      dryRun: true,
      envFile: '.env',
      rules: 'r.json',
      exportSource: 'none',
      printNotes: true,
      progress: true,
    });
  });

  it('parses mute/block with an optional list file', () => {
    expect(parseCliArgs(['mute-from-list'])).toMatchObject({
      kind: 'users-from-list',
      action: 'mute',
      listPath: 'mute.txt',
    });
    expect(
      parseCliArgs(['block-from-list', 'x.txt', '--dotenv', 'e', '--log-level', 'debug', '--no-progress']),
    ).toEqual({
      kind: 'users-from-list',
      action: 'block',
      listPath: 'x.txt',
      dryRun: false,
      envFile: 'e',
      logLevel: 'debug',
      progress: false,
    });
  });

  it('handles help and version', () => {
    expect(parseCliArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['-V'])).toEqual({ kind: 'version' });
  });

  it.each([[[]], [['bogus']], [['days-expire', 'extra']], [['mute-from-list', 'a', 'b']], [['days-expire', '--nope']]])(
    'rejects %j',
    (argv) => {
      expect(() => parseCliArgs(argv)).toThrow(UsageError);
    },
  );
});

describe('runCli', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith('LM_')) delete process.env[key];
    Object.assign(process.env, saved);
  });

  function io(env: Record<string, string>, fetch?: ReturnType<typeof fakeFetch>['fetch']) {
    const out = new PassThrough();
    const err = new PassThrough();
    let stdout = '';
    let stderr = '';
    out.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    err.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    const cwd = mkdtempSync(join(tmpdir(), 'lm-cli-'));
    return {
      io: { env, stdout: out, stderr: err, cwd, ...(fetch ? { fetch } : {}) },
      cwd,
      stdout: () => stdout,
      stderr: () => stderr,
    };
  }

  const env = { LM_ORIGIN: 'https://misskey.example', LM_API_TOKEN: 'tok', LM_POLL_BASE: '0', LM_LOG_TIMEZONE: 'UTC' };

  it('prints usage and version', async () => {
    const h = io(env);
    expect(await runCli(['--help'], h.io)).toBe(0);
    expect(h.stdout()).toBe(USAGE);
    const v = io(env);
    expect(await runCli(['--version'], v.io)).toBe(0);
    expect(v.stdout()).toBe(`${VERSION}\n`);
  });

  it('reports usage errors with exit code 2', async () => {
    const h = io(env);
    expect(await runCli(['bogus'], h.io)).toBe(2);
    expect(h.stderr()).toMatch(/^lm: unknown command: bogus/);
  });

  it('reports configuration errors with exit code 1', async () => {
    const h = io({});
    expect(await runCli(['days-expire', '--dotenv', join(h.cwd, 'none.env')], h.io)).toBe(1);
    expect(h.stderr()).toMatch(/LM_ORIGIN is required/);
    expect(h.stderr()).toMatch(/LM_API_TOKEN is required/);
  });

  it('runs days-expire in dry-run mode end to end', async () => {
    const now = Date.now();
    const notes = [note('pin', 400, now), note('doomed', 400, now), note('fresh', 1, now)];
    const fetch = fakeFetch((call) => {
      switch (call.endpoint) {
        case 'i':
          return { status: 200, body: { id: 'me', pinnedNoteIds: ['pin'] } };
        case 'users/notes':
          return { status: 200, body: call.body.untilId === undefined ? notes : [] };
        default:
          throw new Error(`unexpected ${call.endpoint}`);
      }
    });
    const h = io(env, fetch.fetch);
    const rules = join(h.cwd, 'rules.json');
    writeFileSync(rules, JSON.stringify([{ day: 30, pinned: true }]));
    mkdirSync(join(h.cwd, 'exported_files'));
    writeFileSync(
      join(h.cwd, 'exported_files', 'notes-2026-01-01-00-00-00.json'),
      JSON.stringify([{ id: 'gone', createdAt: '2020-01-01T00:00:00.000Z', replyId: null, renoteId: null }]),
    );

    const code = await runCli(['days-expire', '--dry-run', '--rules', rules, '--print-notes', '--no-progress'], h.io);

    expect(code).toBe(0);
    expect(h.stdout()).toContain('2 notes would be deleted (dry-run)\ngone\ndoomed\n');
    expect(JSON.parse(h.stdout().split('\n')[0] as string)).toHaveLength(4); // --print-notes (API + export)
    expect(h.stderr()).toContain('WARNING  1 notes exist only in the export');
    expect(fetch.calls.some((c) => c.endpoint === 'notes/delete')).toBe(false);
    expect(fetch.calls[0]?.init?.headers).toMatchObject({ 'User-Agent': `lm-misskeyutils/${VERSION}` });
    expect(fetch.calls[0]?.body).toEqual({ i: 'tok' });
  });

  it('runs block-from-list, reading the list file and honouring LM_BASE_URL compatibility', async () => {
    const fetch = fakeFetch((call) => {
      if (call.endpoint === 'users/show') {
        return call.body.username === 'ghost'
          ? { status: 400, body: apiError('NO_SUCH_USER') }
          : { status: 200, body: { id: `id-${call.body.username}` } };
      }
      return { status: 204 };
    });
    const h = io({ LM_BASE_URL: 'https://misskey.example/api', LM_API_TOKEN: 'tok', LM_POLL_BASE: '0' }, fetch.fetch);
    const list = join(h.cwd, 'block.txt');
    writeFileSync(list, 'alice\nghost\n@bob@remote.example\n');

    expect(await runCli(['block-from-list', list, '--no-progress'], h.io)).toBe(0);

    expect(h.stderr()).toContain('LM_BASE_URL is deprecated');
    expect(h.stderr()).toContain('done: block 2 of 2 accounts (0 already done, 1 not found)');
    expect(fetch.calls.filter((c) => c.endpoint === 'blocking/create').map((c) => c.body.userId)).toEqual([
      'id-alice',
      'id-bob',
    ]);
  });

  it('turns API errors into exit code 1', async () => {
    const fetch = fakeFetch(() => ({ status: 401, body: apiError('AUTHENTICATION_FAILED', 'bad token') }));
    const h = io(env, fetch.fetch);
    const rules = join(h.cwd, 'rules.json');
    writeFileSync(rules, '[{"day":1}]');

    expect(await runCli(['days-expire', '-n', '--rules', rules, '--export', 'none'], h.io)).toBe(1);
    expect(h.stderr()).toContain('ERROR    HTTP 401 AUTHENTICATION_FAILED: bad token');
  });

  it('reports invalid rule files', async () => {
    const h = io(env, fakeFetch(() => ({ status: 200, body: {} })).fetch);
    const rules = join(h.cwd, 'rules.json');
    writeFileSync(rules, '[{"day":1,"reactionsCount":1}]');
    expect(await runCli(['days-expire', '-n', '--rules', rules], h.io)).toBe(1);
    expect(h.stderr()).toContain('"reactionCount" (singular)');
  });
});
