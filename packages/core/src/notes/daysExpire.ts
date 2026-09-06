import type { api } from 'misskey-js';
import { describeError, isApiError, throwIfAborted } from '../errors.js';
import { type ExportedNote, mergeNotes } from '../export/index.js';
import type { CoreDeps } from '../ports.js';
import { evaluateRules, type NoteLike } from '../rules/evaluate.js';
import type { Rule } from '../rules/schema.js';
import { listAllNotes } from './list.js';

export interface DaysExpireOptions extends CoreDeps {
  rules: readonly Rule[];
  /** Notes from a Misskey export to merge with the API listing (plan §2.5). */
  exportedNotes?: readonly ExportedNote[];
  /** Evaluate only; never call `notes/delete`. */
  dryRun?: boolean;
  /** Page size for `users/notes`. */
  pageSize?: number;
  /** Called with the full note list before anything is deleted (for `--print-notes`). */
  onNotesListed?: (notes: readonly NoteLike[]) => void;
}

export interface DaysExpireResult {
  userId: string;
  pinnedIds: string[];
  /** Notes returned by the API. */
  apiNoteCount: number;
  /** Notes only present in the export file. */
  exportOnlyIds: string[];
  /** Notes evaluated (API + export). */
  noteCount: number;
  /** Deletion candidates in evaluation order. */
  deleteIds: string[];
  deleted: number;
  /** Deletions the server refused (e.g. 400 for an already deleted note). */
  failed: number;
  dryRun: boolean;
}

/**
 * The days-expire pipeline: `i` -> `users/notes` -> export merge -> rules -> `notes/delete`.
 * Every API call goes through the retrying client.
 */
export async function runDaysExpire(client: api.APIClient, opts: DaysExpireOptions): Promise<DaysExpireResult> {
  const { logger } = opts;
  const dryRun = opts.dryRun ?? false;

  logger.info('step 1 get pinned notes');
  const me = await client.request('i', {});
  const pinnedIds = me.pinnedNoteIds ?? me.pinnedNotes?.map((note) => note.id) ?? [];
  logger.info(`pinned notes: ${pinnedIds.length}`);

  logger.info('step 2 list all my notes');
  const apiNotes: NoteLike[] = [];
  for await (const page of listAllNotes(client, me.id, {
    ...(opts.pageSize === undefined ? {} : { limit: opts.pageSize }),
    ...(opts.signal ? { signal: opts.signal } : {}),
    logger,
  })) {
    apiNotes.push(...page);
    opts.progress?.({ kind: 'step', label: 'list notes', current: apiNotes.length, total: apiNotes.length });
  }
  logger.info(`all notes: ${apiNotes.length}`);

  let notes: NoteLike[] = apiNotes;
  let exportOnlyIds: string[] = [];
  if (opts.exportedNotes !== undefined) {
    logger.info(`step 2.2 merge ${opts.exportedNotes.length} exported notes`);
    const merged = mergeNotes(apiNotes, opts.exportedNotes);
    notes = merged.notes;
    exportOnlyIds = merged.exportOnlyIds;
    logger.info(`merged notes count: ${notes.length}`);
    if (exportOnlyIds.length > 0) {
      logger.warn(
        `${exportOnlyIds.length} notes exist only in the export and carry no counts; ` +
          'they are judged by day / pinned / renote / reply / inChannel only',
      );
    }
  }
  opts.onNotesListed?.(notes);

  logger.info('step 3 list delete target');
  const deleteIds = evaluateRules(notes, pinnedIds, opts.rules, opts.clock.now(), logger);
  logger.info(`delete targets: ${deleteIds.length}`);

  const result: DaysExpireResult = {
    userId: me.id,
    pinnedIds,
    apiNoteCount: apiNotes.length,
    exportOnlyIds,
    noteCount: notes.length,
    deleteIds,
    deleted: 0,
    failed: 0,
    dryRun,
  };

  if (dryRun) {
    logger.info(`step 4 (dry-run) would delete ${deleteIds.length} notes`);
    for (const id of deleteIds) logger.info(`would delete: ${id}`);
    return result;
  }

  logger.info('step 4 delete notes');
  for (const [index, id] of deleteIds.entries()) {
    throwIfAborted(opts.signal);
    opts.progress?.({ kind: 'step', label: `delete ${id}`, current: index + 1, total: deleteIds.length });
    logger.info(`delete: ${id} (${index + 1}/${deleteIds.length})`);
    try {
      await client.request('notes/delete', { noteId: id });
      result.deleted++;
    } catch (error) {
      // API errors (400 for an already deleted note, ...) are logged per note and the run
      // continues, as in the Python version; retry exhaustion and aborts stop the run.
      if (!isApiError(error)) throw error;
      logger.error(`Error deleting ${id}: ${describeError(error)}`);
      result.failed++;
    }
  }
  logger.info(`delete complete: ${result.deleted}, of ${deleteIds.length} targets`);
  return result;
}
