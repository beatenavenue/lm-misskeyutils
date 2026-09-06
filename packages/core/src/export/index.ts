import { z } from 'zod';
import type { NoteLike } from '../rules/evaluate.js';

/**
 * A note from a Misskey note export. Exports carry no `renoteCount` /
 * `repliesCount` / `reactionCount`, so such notes are only protected by the
 * boolean rule conditions (plan §2.5).
 */
const ExportedNoteSchema = z.looseObject({
  id: z.string(),
  createdAt: z.string(),
  renoteId: z.string().nullish(),
  replyId: z.string().nullish(),
  channelId: z.string().nullish(),
});

export type ExportedNote = z.infer<typeof ExportedNoteSchema>;

export class ExportFormatError extends Error {
  override readonly name = 'ExportFormatError';
}

/** Accept a bare array of notes or `{ notes: [...] }`; anything else is an `ExportFormatError`. */
export function parseExportedNotes(json: unknown): ExportedNote[] {
  const list = Array.isArray(json)
    ? json
    : typeof json === 'object' && json !== null && Array.isArray((json as { notes?: unknown }).notes)
      ? (json as { notes: unknown[] }).notes
      : null;
  if (list === null) {
    throw new ExportFormatError('exported json format not recognized (expected an array or { notes: [...] })');
  }
  const result = z.array(ExportedNoteSchema).safeParse(list);
  if (!result.success) {
    throw new ExportFormatError(`exported json contains invalid notes:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export interface MergeResult {
  notes: NoteLike[];
  apiCount: number;
  /** Notes that only exist in the export (missing from the API listing). */
  exportOnlyIds: string[];
}

/** Merge by id; API data wins over exported data (plan §2.5). */
export function mergeNotes(apiNotes: readonly NoteLike[], exportedNotes: readonly ExportedNote[]): MergeResult {
  const byId = new Map<string, NoteLike>();
  for (const note of exportedNotes) {
    byId.set(note.id, {
      id: note.id,
      createdAt: note.createdAt,
      renoteId: note.renoteId ?? null,
      replyId: note.replyId ?? null,
      channelId: note.channelId ?? null,
    });
  }
  const apiIds = new Set<string>();
  for (const note of apiNotes) {
    byId.set(note.id, note);
    apiIds.add(note.id);
  }
  return {
    notes: [...byId.values()],
    apiCount: apiNotes.length,
    exportOnlyIds: exportedNotes.map((note) => note.id).filter((id) => !apiIds.has(id)),
  };
}
