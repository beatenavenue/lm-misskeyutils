import { ExportFormatError, mergeNotes, parseExportedNotes } from '@lm/core';
import { describe, expect, it } from 'vitest';

const exported = [
  { id: 'a', createdAt: '2026-01-01T00:00:00.000Z', text: 'hello', replyId: null, renoteId: 'r' },
  { id: 'b', createdAt: '2026-01-02T00:00:00.000Z', text: 'world', replyId: 'p', renoteId: null },
];

describe('parseExportedNotes', () => {
  it('accepts an array', () => {
    expect(parseExportedNotes(exported)).toHaveLength(2);
    expect(parseExportedNotes(exported)[0]).toMatchObject({ id: 'a', renoteId: 'r', text: 'hello' });
  });

  it('accepts { notes: [...] }', () => {
    expect(parseExportedNotes({ notes: exported })).toHaveLength(2);
  });

  it.each([[{ foo: 1 }], ['x'], [null], [42]])('rejects unknown shapes: %j', (input) => {
    expect(() => parseExportedNotes(input)).toThrow(ExportFormatError);
  });

  it('rejects entries without id / createdAt', () => {
    expect(() => parseExportedNotes([{ id: 'a' }])).toThrow(/invalid notes/);
  });
});

describe('mergeNotes', () => {
  it('prefers API data and reports export-only notes', () => {
    const api = [{ id: 'a', createdAt: '2026-01-01T00:00:00.000Z', renoteId: null, reactionCount: 5 }];
    const result = mergeNotes(api, parseExportedNotes(exported));

    expect(result.apiCount).toBe(1);
    expect(result.exportOnlyIds).toEqual(['b']);
    expect(result.notes).toEqual([
      api[0],
      { id: 'b', createdAt: '2026-01-02T00:00:00.000Z', renoteId: null, replyId: 'p', channelId: null },
    ]);
  });

  it('keeps API notes that are not in the export', () => {
    const api = [{ id: 'z', createdAt: '2026-01-03T00:00:00.000Z' }];
    const result = mergeNotes(api, []);
    expect(result.notes).toEqual(api);
    expect(result.exportOnlyIds).toEqual([]);
  });
});
