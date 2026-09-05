/**
 * Default port implementations. This is the only core file allowed to touch
 * timers and the system clock directly; everything else goes through ports.
 */
import { OperationAbortedError } from './errors.js';
import type { Clock, CoreDeps, Logger, Sleep } from './ports.js';

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OperationAbortedError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new OperationAbortedError());
    };
    // biome-ignore lint/style/noRestrictedGlobals: default Sleep implementation
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export const systemClock: Clock = {
  now: () => Date.now(),
};

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Build a full `CoreDeps` from partial overrides, using the defaults for the rest. */
export function createDefaultDeps(overrides: Partial<CoreDeps> = {}): CoreDeps {
  return {
    logger: overrides.logger ?? noopLogger,
    sleep: overrides.sleep ?? defaultSleep,
    clock: overrides.clock ?? systemClock,
    ...(overrides.progress ? { progress: overrides.progress } : {}),
    ...(overrides.signal ? { signal: overrides.signal } : {}),
  };
}
