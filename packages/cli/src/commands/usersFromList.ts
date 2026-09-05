import { readFileSync } from 'node:fs';
import {
  type APIClient,
  type CoreDeps,
  parseUserList,
  resolveUserIds,
  runUserAction,
  type UserAction,
  type UserActionResult,
} from '@lm/core';

export interface UsersFromListOptions {
  action: UserAction;
  listPath: string;
  dryRun: boolean;
}

export async function usersFromListCommand(
  client: APIClient,
  deps: CoreDeps,
  opts: UsersFromListOptions,
): Promise<UserActionResult> {
  let text: string;
  try {
    text = readFileSync(opts.listPath, 'utf8');
  } catch (error) {
    throw new Error(`cannot read user list ${opts.listPath}: ${(error as Error).message}`);
  }
  const refs = parseUserList(text);
  if (refs.length === 0) throw new Error(`${opts.listPath} contains no account names`);
  deps.logger.info(`${refs.length} accounts in ${opts.listPath}`);

  const users = await resolveUserIds(client, refs, deps);
  return runUserAction(client, opts.action, users, { ...deps, dryRun: opts.dryRun });
}
