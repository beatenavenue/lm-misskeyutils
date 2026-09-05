import { z } from 'zod';

const count = z.number().int().nonnegative();

/** One entry of `deleterule.json` (REFACTORING_PLAN.md §5.2). Unknown keys are rejected. */
export const RuleSchema = z.strictObject({
  day: count,
  renoteCount: count.optional(),
  repliesCount: count.optional(),
  reactionCount: count.optional(),
  pinned: z.boolean().optional(),
  renote: z.boolean().optional(),
  reply: z.boolean().optional(),
  inChannel: z.boolean().optional(),
});

export const RulesSchema = z.array(RuleSchema);

export type Rule = z.infer<typeof RuleSchema>;

export class RuleConfigError extends Error {
  override readonly name = 'RuleConfigError';
}

/** Validate raw JSON data and return the rules sorted by `day` ascending. */
export function parseRules(input: unknown): Rule[] {
  const result = RulesSchema.safeParse(input);
  if (!result.success) {
    let message = `invalid delete rules:\n${z.prettifyError(result.error)}`;
    const legacyKey = result.error.issues.some(
      (issue) => issue.code === 'unrecognized_keys' && issue.keys.includes('reactionsCount'),
    );
    if (legacyKey) {
      message += '\nhint: the key is "reactionCount" (singular); "reactionsCount" was never honoured.';
    }
    throw new RuleConfigError(message);
  }
  return [...result.data].sort((a, b) => a.day - b.day);
}
