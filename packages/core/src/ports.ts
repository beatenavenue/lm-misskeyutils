/**
 * Ports through which core talks to its environment (REFACTORING_PLAN.md §3.2).
 *
 * Core never touches the console, timers, the clock or the environment
 * directly; the CLI (and later the web package) provide these implementations.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Resolve after `ms` milliseconds; reject with an abort error if `signal` fires first. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export type WaitReason = 'poll' | 'rate-limit' | 'net-error';

export type ProgressEvent =
  | { kind: 'wait'; reason: WaitReason; totalSeconds: number; elapsedSeconds: number }
  | { kind: 'wait-end'; reason: WaitReason }
  | { kind: 'step'; label: string; current: number; total: number };

export type Progress = (event: ProgressEvent) => void;

export interface CoreDeps {
  logger: Logger;
  sleep: Sleep;
  clock: Clock;
  progress?: Progress;
  signal?: AbortSignal;
}
