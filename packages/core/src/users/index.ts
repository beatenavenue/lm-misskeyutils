import { acct, type api } from 'misskey-js';
import { describeError, getHttpStatus, isApiError, throwIfAborted } from '../errors.js';
import type { CoreDeps } from '../ports.js';

export interface UserRef {
  username: string;
  host: string | null;
}

/** Parse one list line: `name`, `name@host` or `@name@host`. Blank lines give `null`. */
export function parseUserRef(line: string): UserRef | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  const parsed = acct.parse(trimmed);
  if (parsed.username === '') return null;
  return { username: parsed.username, host: parsed.host };
}

/** Parse a whole list file (one account per line, blank lines ignored). */
export function parseUserList(text: string): UserRef[] {
  return text
    .split(/\r?\n/)
    .map(parseUserRef)
    .filter((ref): ref is UserRef => ref !== null);
}

export function formatUserRef(ref: UserRef): string {
  return ref.host === null ? ref.username : `${ref.username}@${ref.host}`;
}

export interface ResolvedUser {
  ref: UserRef;
  /** `null` when the server answered 400 (no such user). */
  id: string | null;
}

/** Resolve user ids with `users/show`; unknown users (400) are kept with `id: null` (plan §2.6). */
export async function resolveUserIds(
  client: api.APIClient,
  refs: readonly UserRef[],
  deps: CoreDeps,
): Promise<ResolvedUser[]> {
  const total = refs.length;
  const resolved: ResolvedUser[] = [];
  for (const [index, ref] of refs.entries()) {
    throwIfAborted(deps.signal);
    const name = formatUserRef(ref);
    deps.progress?.({ kind: 'step', label: `resolve ${name}`, current: index + 1, total });
    deps.logger.info(`find ${name} ... (${index + 1}/${total})`);
    try {
      const user = await client.request('users/show', { username: ref.username, host: ref.host });
      deps.logger.info(`username: ${name} is ${user.id} (${index + 1}/${total})`);
      resolved.push({ ref, id: user.id });
    } catch (error) {
      if (isApiError(error) && getHttpStatus(error) === 400) {
        deps.logger.warn(`user not found: ${name} (${describeError(error)})`);
        resolved.push({ ref, id: null });
        continue;
      }
      throw error;
    }
  }
  return resolved;
}

export type UserAction = 'mute' | 'block';

export interface UserActionResult {
  action: UserAction;
  /** Users with a resolved id. */
  total: number;
  /** Requests that succeeded (or would run in dry-run mode). */
  done: number;
  /** Requests the server answered with 400 (already muted/blocked, no such user). */
  skipped: number;
  /** Users without an id, never sent to the server. */
  unresolved: number;
  dryRun: boolean;
}

export interface UserActionOptions extends CoreDeps {
  dryRun?: boolean;
}

/** Mute or block every resolved user; 400 responses count as already done (plan §2.6). */
export async function runUserAction(
  client: api.APIClient,
  action: UserAction,
  users: readonly ResolvedUser[],
  opts: UserActionOptions,
): Promise<UserActionResult> {
  const dryRun = opts.dryRun ?? false;
  const targets = users.filter((user): user is ResolvedUser & { id: string } => user.id !== null);
  const result: UserActionResult = {
    action,
    total: targets.length,
    done: 0,
    skipped: 0,
    unresolved: users.length - targets.length,
    dryRun,
  };
  opts.logger.info(`${action} users${dryRun ? ' (dry-run)' : ''}: ${targets.length}`);

  for (const [index, user] of targets.entries()) {
    throwIfAborted(opts.signal);
    const name = formatUserRef(user.ref);
    opts.progress?.({ kind: 'step', label: `${action} ${name}`, current: index + 1, total: targets.length });
    if (dryRun) {
      opts.logger.info(`would ${action}: ${name} ${user.id} (${index + 1}/${targets.length})`);
      result.done++;
      continue;
    }
    opts.logger.info(`${action}: ${name} ${user.id} (${index + 1}/${targets.length})`);
    try {
      if (action === 'mute') {
        await client.request('mute/create', { userId: user.id });
      } else {
        await client.request('blocking/create', { userId: user.id });
      }
      result.done++;
    } catch (error) {
      if (isApiError(error) && getHttpStatus(error) === 400) {
        opts.logger.info(`${action}: ${name} skipped (${describeError(error)})`);
        result.skipped++;
        continue;
      }
      throw error;
    }
  }
  return result;
}
