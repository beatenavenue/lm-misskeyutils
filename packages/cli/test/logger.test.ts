import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, formatLine, formatTimestamp } from '../src/logger.js';
import { createProgressReporter } from '../src/progress.js';

const T = Date.UTC(2026, 8, 1, 3, 4, 5); // 2026-09-01 03:04:05 UTC

function capture() {
  const stream = new PassThrough();
  let text = '';
  stream.on('data', (chunk: Buffer) => {
    text += chunk.toString();
  });
  return { stream, read: () => text };
}

describe('formatTimestamp / formatLine', () => {
  it('formats in the configured time zone like the Python logger', () => {
    expect(formatTimestamp(T, 'UTC')).toBe('2026-09-01 03:04:05');
    expect(formatTimestamp(T, 'Asia/Tokyo')).toBe('2026-09-01 12:04:05');
    expect(formatLine(T, 'UTC', 'warn', 'hi')).toBe('2026-09-01 03:04:05 WARNING  hi');
  });
});

describe('createLogger', () => {
  it('filters by level and writes to the console and the file', () => {
    const out = capture();
    const dir = mkdtempSync(join(tmpdir(), 'lm-log-'));
    const file = join(dir, 'test.log');
    const logger = createLogger({ level: 'info', timeZone: 'UTC', filePath: file, stream: out.stream, now: () => T });

    logger.debug('hidden');
    logger.info('shown');
    logger.error('bad');

    const expected = '2026-09-01 03:04:05 INFO     shown\n2026-09-01 03:04:05 ERROR    bad\n';
    expect(out.read()).toBe(expected);
    expect(readFileSync(file, 'utf8')).toBe(expected);
  });

  it('clears the countdown line before writing', () => {
    const out = capture();
    const reporter = createProgressReporter(out.stream);
    const logger = createLogger({
      level: 'info',
      timeZone: 'UTC',
      stream: out.stream,
      beforeConsoleWrite: reporter.clear,
      now: () => T,
    });

    reporter.progress({ kind: 'wait', reason: 'poll', totalSeconds: 3, elapsedSeconds: 0 });
    reporter.progress({ kind: 'wait', reason: 'poll', totalSeconds: 3, elapsedSeconds: 1 });
    logger.info('after');
    reporter.progress({ kind: 'wait-end', reason: 'poll' });

    expect(out.read()).toBe(`\rwait 1/3\rwait 2/3\r${' '.repeat(8)}\r2026-09-01 03:04:05 INFO     after\n`);
  });

  it('does nothing when progress is disabled', () => {
    const out = capture();
    const reporter = createProgressReporter(out.stream, false);
    reporter.progress({ kind: 'wait', reason: 'poll', totalSeconds: 3, elapsedSeconds: 0 });
    reporter.clear();
    expect(out.read()).toBe('');
  });
});
