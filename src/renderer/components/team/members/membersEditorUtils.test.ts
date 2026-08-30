import { describe, expect, it } from 'vitest';

import { createMemberDraftsFromInputs } from './membersEditorUtils';

describe('createMemberDraftsFromInputs', () => {
  it('derives deterministic ids from member names so rebuilt drafts keep identity', () => {
    const inputs = [
      { name: 'Alice', role: 'reviewer' },
      { name: 'bob', role: '' },
    ];

    const first = createMemberDraftsFromInputs(inputs);
    const second = createMemberDraftsFromInputs(inputs);

    expect(first.map((draft) => draft.id)).toEqual(['alice', 'bob']);
    expect(second.map((draft) => draft.id)).toEqual(first.map((draft) => draft.id));
  });

  it('trims and lowercases names when deriving ids', () => {
    const [draft] = createMemberDraftsFromInputs([{ name: '  Code-Reviewer  ' }]);
    expect(draft.id).toBe('code-reviewer');
  });

  it('dedupes colliding ids with -2/-3 suffixes', () => {
    const drafts = createMemberDraftsFromInputs([
      { name: 'alice' },
      { name: 'Alice ' },
      { name: 'ALICE' },
    ]);

    expect(drafts.map((draft) => draft.id)).toEqual(['alice', 'alice-2', 'alice-3']);
  });

  it('keeps blank-name ids stable across rebuilds from the same inputs', () => {
    // The launch dialog applies the roster twice per open (sync pass, then the
    // saved-request pass), so an unnamed row must not get a fresh id each time.
    const inputs = [{ name: 'alice' }, { name: '' }, { name: '   ' }];

    const first = createMemberDraftsFromInputs(inputs);
    const second = createMemberDraftsFromInputs(inputs);

    expect(first.map((draft) => draft.id)).toEqual(second.map((draft) => draft.id));
    expect(new Set(first.map((draft) => draft.id)).size).toBe(3);
    expect(first.every((draft) => Boolean(draft.id))).toBe(true);
  });

  it('does not let a blank-name fallback id collide with a real member name', () => {
    const drafts = createMemberDraftsFromInputs([{ name: 'unnamed-1' }, { name: '' }]);

    expect(drafts[0].id).toBe('unnamed-1');
    expect(drafts[1].id).not.toBe(drafts[0].id);
  });

  it('does not let removed members consume dedupe suffixes', () => {
    const drafts = createMemberDraftsFromInputs([
      { name: 'alice', removedAt: Date.now() },
      { name: 'alice' },
    ]);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].id).toBe('alice');
  });
});
