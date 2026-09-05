import type { CoreDeps, Logger, ProgressEvent, RawFetch, RawFetchInit } from '@lm/core';
import { OperationAbortedError } from '@lm/core';

export interface RecordingLogger extends Logger {
  lines: string[];
}

export function recordingLogger(): RecordingLogger {
  const lines: string[] = [];
  const push = (level: string) => (message: string) => {
    lines.push(`${level}: ${message}`);
  };
  return { lines, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
}

export interface FakeDeps extends CoreDeps {
  logger: RecordingLogger;
  /** Milliseconds passed to sleep, in order. */
  sleeps: number[];
  /** Total seconds slept. */
  readonly sleptSeconds: number;
  events: ProgressEvent[];
  nowMs: number;
}

export function fakeDeps(overrides: Partial<Pick<FakeDeps, 'nowMs' | 'signal'>> = {}): FakeDeps {
  const sleeps: number[] = [];
  const events: ProgressEvent[] = [];
  const deps: FakeDeps = {
    logger: recordingLogger(),
    sleeps,
    get sleptSeconds() {
      return sleeps.reduce((sum, ms) => sum + ms, 0) / 1000;
    },
    events,
    nowMs: overrides.nowMs ?? Date.UTC(2026, 8, 1),
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw new OperationAbortedError();
      sleeps.push(ms);
    },
    clock: { now: () => deps.nowMs },
    progress: (event) => {
      events.push(event);
    },
    ...(overrides.signal ? { signal: overrides.signal } : {}),
  };
  return deps;
}

export interface FakeResponseSpec {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface FakeCall {
  endpoint: string;
  body: Record<string, unknown>;
  init: RawFetchInit;
}

export type FakeRoute = (call: FakeCall, index: number) => FakeResponseSpec | Promise<FakeResponseSpec>;

export interface FakeFetch {
  fetch: RawFetch;
  calls: FakeCall[];
}

/** A fetch double: `route` decides the response per call; thrown errors simulate network failures. */
export function fakeFetch(route: FakeRoute): FakeFetch {
  const calls: FakeCall[] = [];
  const fetch: RawFetch = async (input, init) => {
    const endpoint = input.slice(input.indexOf('/api/') + '/api/'.length);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const call: FakeCall = { endpoint, body, init };
    calls.push(call);
    const spec = await route(call, calls.length - 1);
    const headers = new Map(Object.entries(spec.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: spec.status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      json: async () => {
        if (spec.body === undefined) throw new SyntaxError('empty body');
        return spec.body;
      },
    };
  };
  return { fetch, calls };
}

/** Route helper: answer calls in order, repeating the last response. */
export function sequence(...specs: Array<FakeResponseSpec | Error>): FakeRoute {
  return (_call, index) => {
    const spec = specs[Math.min(index, specs.length - 1)];
    if (spec === undefined) throw new Error('no response configured');
    if (spec instanceof Error) throw spec;
    return spec;
  };
}

export const apiError = (code: string, message = code, extra: Record<string, unknown> = {}) => ({
  error: { id: '00000000-0000-0000-0000-000000000000', code, message, kind: 'client', info: {}, ...extra },
});

export function note(id: string, ageDays: number, nowMs: number, fields: Record<string, unknown> = {}) {
  return {
    id,
    createdAt: new Date(nowMs - ageDays * 86_400_000).toISOString(),
    userId: 'me',
    renoteId: null,
    replyId: null,
    channelId: null,
    renoteCount: 0,
    repliesCount: 0,
    reactionCount: 0,
    reactions: {},
    ...fields,
  };
}
