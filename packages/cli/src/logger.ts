import { appendFileSync } from 'node:fs';
import type { Logger, LogLevel } from '@lm/core';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL_LABEL: Record<LogLevel, string> = { debug: 'DEBUG', info: 'INFO', warn: 'WARNING', error: 'ERROR' };

export interface CliLoggerOptions {
  level: LogLevel;
  timeZone: string;
  /** Append every line to this file as well. */
  filePath?: string | null;
  /** Console output target (default `process.stderr`). */
  stream?: NodeJS.WritableStream;
  /** Called before a line is written to the console (used to clear the countdown line). */
  beforeConsoleWrite?: () => void;
  now?: () => number;
}

/** `2026-09-01 12:34:56` in the given time zone. */
export function formatTimestamp(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

export function formatLine(ms: number, timeZone: string, level: LogLevel, message: string): string {
  return `${formatTimestamp(ms, timeZone)} ${LEVEL_LABEL[level].padEnd(8)} ${message}`;
}

export function createLogger(opts: CliLoggerOptions): Logger {
  const threshold = LEVEL_ORDER[opts.level];
  const stream = opts.stream ?? process.stderr;
  const now = opts.now ?? (() => Date.now());
  const write = (level: LogLevel) => (message: string) => {
    if (LEVEL_ORDER[level] < threshold) return;
    const line = formatLine(now(), opts.timeZone, level, message);
    opts.beforeConsoleWrite?.();
    stream.write(`${line}\n`);
    if (opts.filePath) appendFileSync(opts.filePath, `${line}\n`, 'utf8');
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}
