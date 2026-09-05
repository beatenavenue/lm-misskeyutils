import type { Logger } from '../ports.js';
import type { Rule } from './schema.js';

/** The subset of a Misskey note (or exported note) the rules look at. */
export interface NoteLike {
  id: string;
  createdAt: string;
  renoteId?: string | null;
  replyId?: string | null;
  channelId?: string | null;
  renoteCount?: number;
  repliesCount?: number;
  reactionCount?: number;
}

export type KeepReason = 'pinned' | 'renote' | 'reply' | 'inChannel' | 'renoteCount' | 'repliesCount' | 'reactionCount';

const DAY_MS = 86_400_000;

function reached(threshold: number | undefined, value: number | undefined): boolean {
  return threshold !== undefined && (value ?? 0) >= threshold;
}

/** Why `rule` keeps `note`, or `null` when the rule deletes it (plan §2.4 steps 2-8). */
export function ruleKeepsNote(rule: Rule, note: NoteLike, pinnedIds: ReadonlySet<string>): KeepReason | null {
  if (rule.pinned && pinnedIds.has(note.id)) return 'pinned';
  if (rule.renote && note.renoteId != null) return 'renote';
  if (rule.reply && note.replyId != null) return 'reply';
  if (rule.inChannel && note.channelId != null) return 'inChannel';
  if (reached(rule.renoteCount, note.renoteCount)) return 'renoteCount';
  if (reached(rule.repliesCount, note.repliesCount)) return 'repliesCount';
  if (reached(rule.reactionCount, note.reactionCount)) return 'reactionCount';
  return null;
}

/**
 * Ids of the notes to delete. Rules are evaluated in ascending `day` order;
 * the first rule whose age condition holds and whose keep conditions do not
 * marks the note (plan §2.4). Pure: `now` is epoch milliseconds or a Date.
 */
export function evaluateRules(
  notes: readonly NoteLike[],
  pinnedIds: Iterable<string>,
  rules: readonly Rule[],
  now: number | Date,
  logger?: Logger,
): string[] {
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const pinned = new Set(pinnedIds);
  const ordered = [...rules].sort((a, b) => a.day - b.day);
  const targets: string[] = [];

  for (const note of notes) {
    const createdAt = Date.parse(note.createdAt);
    if (Number.isNaN(createdAt)) {
      logger?.warn(`skip: ${note.id} has an unparsable createdAt (${note.createdAt})`);
      continue;
    }
    let matched = false;
    for (const rule of ordered) {
      if (!(createdAt + rule.day * DAY_MS < nowMs)) continue;
      const reason = ruleKeepsNote(rule, note, pinned);
      if (reason !== null) {
        logger?.debug(`skip: ${note.id} kept by ${reason} at rule${rule.day}`);
        continue;
      }
      logger?.debug(`add target ${note.id} at rule${rule.day}`);
      targets.push(note.id);
      matched = true;
      break;
    }
    if (!matched) logger?.debug(`skip: ${note.id} does not match any deletion rule`);
  }
  return targets;
}
