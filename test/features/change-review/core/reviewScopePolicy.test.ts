import {
  assertExpectedAuthoritativeRename,
  assertHunkIndices,
  assertSnippetShapes,
  parseReviewFileScope,
  parseReviewRenameRecoveryExpectation,
} from '@features/change-review/core/domain/reviewScopePolicy';
import { describe, expect, it } from 'vitest';

import type { FileChangeWithContent, SnippetDiff } from '@shared/types/review';

const validators = {
  validateTeamName: (value: unknown) =>
    value === 'safe-team'
      ? { valid: true, value: 'safe-team' }
      : { valid: false, error: 'Invalid teamName' },
  validateTaskId: (value: unknown) =>
    value === 'task-1'
      ? { valid: true, value: 'task-1' }
      : { valid: false, error: 'Invalid taskId' },
};

function createRenameSnippet(): SnippetDiff {
  return {
    toolUseId: 'rename-1',
    filePath: '/sandbox/new.ts',
    toolName: 'Bash',
    type: 'shell-snapshot',
    oldString: 'before\n',
    newString: 'after\n',
    replaceAll: false,
    timestamp: '2026-07-24T00:00:00.000Z',
    isError: false,
    ledger: {
      eventId: 'event-1',
      source: 'ledger-exact',
      confidence: 'exact',
      originalFullContent: 'before\n',
      modifiedFullContent: 'after\n',
      beforeHash: 'before-hash',
      afterHash: 'after-hash',
      relation: { kind: 'rename', oldPath: '/sandbox/old.ts', newPath: '/sandbox/new.ts' },
    },
  };
}

describe('review scope policy', () => {
  it('normalizes a valid task scope through injected identity validators', () => {
    expect(
      parseReviewFileScope(
        { teamName: 'safe-team', taskId: ' task-1 ', memberName: ' worker ' },
        validators
      )
    ).toEqual({ teamName: 'safe-team', taskId: 'task-1', memberName: 'worker' });
  });

  it('preserves task validation errors and rejects malformed hunk indices', () => {
    expect(() =>
      parseReviewFileScope({ teamName: 'safe-team', taskId: 'forged' }, validators)
    ).toThrow('Invalid taskId');
    expect(() => assertHunkIndices([0, -1])).toThrow('Invalid hunkIndices');
  });

  it('validates rename recovery metadata and rejects stale authoritative evidence', () => {
    const snippet = createRenameSnippet();
    const content: FileChangeWithContent = {
      filePath: snippet.filePath,
      relativePath: 'new.ts',
      snippets: [snippet],
      linesAdded: 1,
      linesRemoved: 1,
      isNewFile: false,
      originalFullContent: 'before\n',
      modifiedFullContent: 'after\n',
      contentSource: 'ledger-exact',
    };
    const expectation = parseReviewRenameRecoveryExpectation({
      eventId: 'event-1',
      beforeHash: 'before-hash',
      afterHash: 'after-hash',
      relation: snippet.ledger?.relation,
    });

    expect(() => assertExpectedAuthoritativeRename(content, expectation)).not.toThrow();
    expect(() =>
      assertExpectedAuthoritativeRename(content, { ...expectation, eventId: 'stale-event' })
    ).toThrow('Review changes were updated; refusing stale rename recovery');
  });

  it('rejects renderer snippets with incomplete transport shapes', () => {
    expect(() => assertSnippetShapes([{ filePath: '/sandbox/file.ts' }])).toThrow(
      'Invalid review snippet toolUseId'
    );
  });
});
