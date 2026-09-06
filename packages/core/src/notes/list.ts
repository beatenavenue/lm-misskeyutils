import type { api, entities } from 'misskey-js';
import { throwIfAborted } from '../errors.js';
import type { Logger } from '../ports.js';

export interface ListAllNotesOptions {
  /** Page size for `users/notes` (max 100). */
  limit?: number;
  signal?: AbortSignal;
  logger?: Logger;
}

/**
 * Page through `users/notes` with `untilId` until an empty page arrives.
 * Replies, renotes and channel notes are requested explicitly (plan §2.8).
 */
export async function* listAllNotes(
  client: api.APIClient,
  userId: string,
  opts: ListAllNotesOptions = {},
): AsyncGenerator<entities.Note[], void, void> {
  const limit = opts.limit ?? 100;
  let untilId: string | undefined;
  let page = 0;
  for (;;) {
    throwIfAborted(opts.signal);
    const notes = await client.request('users/notes', {
      userId,
      limit,
      withReplies: true,
      withRenotes: true,
      withChannelNotes: true,
      ...(untilId === undefined ? {} : { untilId }),
    });
    page++;
    opts.logger?.debug(`users/notes page ${page}: ${notes.length} notes`);
    if (notes.length === 0) return;
    yield notes;
    const last = notes[notes.length - 1];
    if (last === undefined) return;
    untilId = last.id;
  }
}
