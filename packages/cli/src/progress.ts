import type { Progress } from '@lm/core';

export interface ProgressReporter {
  progress: Progress;
  /** Erase the countdown line if one is showing. */
  clear(): void;
}

/** Show `wait t/N` on one stderr line during waits, like the Python `sleepseconds` (plan §3.5). */
export function createProgressReporter(stream: NodeJS.WritableStream, enabled = true): ProgressReporter {
  let shown = 0;
  const clear = () => {
    if (shown > 0) {
      stream.write(`\r${' '.repeat(shown)}\r`);
      shown = 0;
    }
  };
  const progress: Progress = (event) => {
    if (!enabled) return;
    if (event.kind === 'wait') {
      const text = `wait ${event.elapsedSeconds + 1}/${event.totalSeconds}`;
      stream.write(`\r${text.padEnd(shown)}`);
      shown = Math.max(shown, text.length);
    } else if (event.kind === 'wait-end') {
      clear();
    }
  };
  return { progress, clear };
}
