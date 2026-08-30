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

  it('falls back to a generated id for blank names', () => {
    const [first] = createMemberDraftsFromInputs([{ name: '   ' }]);
    const [second] = createMemberDraftsFromInputs([{ name: '' }]);

    expect(first.id).toBeTruthy();
    expect(second.id).toBeTruthy();
    // Blank names have no stable identity — generated ids stay unique.
    expect(first.id).not.toBe(second.id);
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
