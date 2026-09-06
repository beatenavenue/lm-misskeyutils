import { throwIfAborted } from '../errors.js';
import type { CoreDeps, WaitReason } from '../ports.js';

/**
 * Wait `seconds`, one second at a time, reporting progress after each tick so
 * the CLI can show a countdown and the wait can be aborted promptly.
 */
export async function waitSeconds(seconds: number, reason: WaitReason, deps: CoreDeps): Promise<void> {
  const total = Math.ceil(seconds);
  if (total <= 0) return;
  deps.logger.info(`sleep ${total}sec (${reason})`);
  for (let elapsed = 0; elapsed < total; elapsed++) {
    throwIfAborted(deps.signal);
    deps.progress?.({ kind: 'wait', reason, totalSeconds: total, elapsedSeconds: elapsed });
    await deps.sleep(1000, deps.signal);
  }
  deps.progress?.({ kind: 'wait-end', reason });
}
