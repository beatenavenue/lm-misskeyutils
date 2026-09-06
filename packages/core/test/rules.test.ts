import { readFileSync } from 'node:fs';
import { evaluateRules, parseRules, type Rule, RuleConfigError, ruleKeepsNote } from '@lm/core';
import { describe, expect, it } from 'vitest';
import { recordingLogger } from './helpers.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/evaluate-rules/${name}`, import.meta.url), 'utf8'));

describe('parseRules', () => {
  it('accepts the documented keys and sorts by day', () => {
    const rules = parseRules([
      { day: 180, pinned: true },
      { day: 30, renoteCount: 1, repliesCount: 2, reactionCount: 3, renote: true, reply: true, inChannel: true },
    ]);
    expect(rules.map((r) => r.day)).toEqual([30, 180]);
    expect(rules[0]).toEqual({
      day: 30,
      renoteCount: 1,
      repliesCount: 2,
      reactionCount: 3,
      renote: true,
      reply: true,
      inChannel: true,
    });
  });

  it('accepts the repository sample deleterule.json', () => {
    const sample = JSON.parse(readFileSync(new URL('../../../deleterule.json', import.meta.url), 'utf8'));
    expect(parseRules(sample).map((r) => r.day)).toEqual([30, 60, 180]);
  });

  it.each([
    ['not a list', { day: 1 }],
    ['missing day', [{ pinned: true }]],
    ['string day', [{ day: '30' }]],
    ['negative day', [{ day: -1 }]],
    ['fractional count', [{ day: 1, renoteCount: 1.5 }]],
    ['string flag', [{ day: 1, pinned: 'yes' }]],
    ['unknown key', [{ day: 1, foo: 1 }]],
    ['list entry not an object', ['x']],
  ])('rejects %s', (_label, input) => {
    expect(() => parseRules(input)).toThrow(RuleConfigError);
  });

  it('explains the legacy reactionsCount key', () => {
    expect(() => parseRules([{ day: 1, reactionsCount: 1 }])).toThrow(/"reactionCount" \(singular\)/);
  });
});

describe('evaluateRules', () => {
  it('reproduces the Python golden data', () => {
    const notes = fixture('notes.json');
    const pinned: string[] = fixture('pinned.json');
    const rules = parseRules(fixture('rules.json'));
    const expected: { now: string; deleteIds: string[] } = fixture('expected.json');

    expect(evaluateRules(notes, pinned, rules, Date.parse(expected.now))).toEqual(expected.deleteIds);
  });

  const now = Date.UTC(2026, 8, 1);
  const at = (ageMs: number, fields: Record<string, unknown> = {}) => ({
    id: 'n',
    createdAt: new Date(now - ageMs).toISOString(),
    ...fields,
  });
  const day = 86_400_000;

  it('treats "exactly day days old" as not old enough', () => {
    const rules = parseRules([{ day: 30 }]);
    expect(evaluateRules([at(30 * day)], [], rules, now)).toEqual([]);
    expect(evaluateRules([at(30 * day + 1)], [], rules, now)).toEqual(['n']);
  });

  it('keeps notes at exactly the count threshold and deletes below it', () => {
    const rules = parseRules([{ day: 1, renoteCount: 2, repliesCount: 2, reactionCount: 2 }]);
    expect(evaluateRules([at(2 * day, { renoteCount: 2 })], [], rules, now)).toEqual([]);
    expect(evaluateRules([at(2 * day, { repliesCount: 2 })], [], rules, now)).toEqual([]);
    expect(evaluateRules([at(2 * day, { reactionCount: 2 })], [], rules, now)).toEqual([]);
    expect(evaluateRules([at(2 * day, { renoteCount: 1, repliesCount: 1, reactionCount: 1 })], [], rules, now)).toEqual(
      ['n'],
    );
  });

  it('does not protect by count when the rule has no threshold', () => {
    const rules = parseRules([{ day: 1 }]);
    expect(evaluateRules([at(2 * day, { reactionCount: 10_000 })], [], rules, now)).toEqual(['n']);
  });

  it('sorts rules itself and stops at the first matching rule', () => {
    const rules: Rule[] = [{ day: 180 }, { day: 30, pinned: true }];
    expect(evaluateRules([at(400 * day)], ['n'], rules, now)).toEqual(['n']); // rule30 keeps, rule180 deletes
    expect(evaluateRules([at(100 * day)], ['n'], rules, now)).toEqual([]);
  });

  it('accepts a Date for now and skips unparsable createdAt', () => {
    const logger = recordingLogger();
    const rules = parseRules([{ day: 1 }]);
    expect(
      evaluateRules([{ id: 'bad', createdAt: 'yesterday' }, at(2 * day)], [], rules, new Date(now), logger),
    ).toEqual(['n']);
    expect(logger.lines.some((line) => line.startsWith('warn:') && line.includes('bad'))).toBe(true);
  });
});

describe('ruleKeepsNote', () => {
  const pinned = new Set(['p']);
  it('reports the first matching keep reason in plan order', () => {
    const rule: Rule = { day: 1, pinned: true, renote: true, reply: true, inChannel: true, renoteCount: 1 };
    expect(ruleKeepsNote(rule, { id: 'p', createdAt: '', renoteId: 'x' }, pinned)).toBe('pinned');
    expect(ruleKeepsNote(rule, { id: 'n', createdAt: '', renoteId: 'x', replyId: 'y' }, pinned)).toBe('renote');
    expect(ruleKeepsNote(rule, { id: 'n', createdAt: '', replyId: 'y' }, pinned)).toBe('reply');
    expect(ruleKeepsNote(rule, { id: 'n', createdAt: '', channelId: 'c' }, pinned)).toBe('inChannel');
    expect(ruleKeepsNote(rule, { id: 'n', createdAt: '', renoteCount: 1 }, pinned)).toBe('renoteCount');
    expect(ruleKeepsNote(rule, { id: 'n', createdAt: '', renoteId: null }, pinned)).toBeNull();
  });

  it('ignores boolean conditions that are not enabled', () => {
    expect(ruleKeepsNote({ day: 1 }, { id: 'p', createdAt: '', renoteId: 'x', channelId: 'c' }, pinned)).toBeNull();
  });
});
