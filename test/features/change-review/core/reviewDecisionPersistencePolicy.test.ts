import {
  assertReviewDecisionShape,
  parseReviewDecisionPersistenceScope,
  parseReviewHistoryScopeIdentity,
} from '@features/change-review/main';
import { describe, expect, it } from 'vitest';

describe('review decision persistence policy', () => {
  it('accepts the persisted decision shape used by review history', () => {
    const value = {
      filePath: '/safe/file.ts',
      reviewKey: 'review-key',
      fileDecision: 'rejected',
      hunkDecisions: { 0: 'accepted' },
      hunkContextHashes: { 0: 'hash' },
      contentSnapshotToken: 'snapshot',
      snippets: [],
      originalFullContent: 'before',
      modifiedFullContent: null,
      isNewFile: false,
    };

    expect(() => assertReviewDecisionShape(value)).not.toThrow();
  });

  it.each([
    [{}, 'decision.filePath'],
    [
      {
        filePath: '/safe/file.ts',
        fileDecision: 'invalid',
        hunkDecisions: {},
      },
      'Invalid fileDecision',
    ],
    [
      {
        filePath: '/safe/file.ts',
        fileDecision: 'pending',
        hunkDecisions: { '-1': 'pending' },
      },
      'Invalid hunk decision',
    ],
    [
      {
        filePath: '/safe/file.ts',
        fileDecision: 'pending',
        hunkDecisions: {},
        contentSnapshotToken: 42,
      },
      'Invalid contentSnapshotToken',
    ],
  ])('rejects an invalid decision with the legacy error', (value, error) => {
    expect(() => assertReviewDecisionShape(value)).toThrow(error);
  });

  it('parses an exact task persistence scope and preserves undefined as null', () => {
    const scope = { teamName: 'safe-team', taskId: 'task-1' };

    expect(parseReviewDecisionPersistenceScope(undefined, scope)).toBeNull();
    expect(
      parseReviewDecisionPersistenceScope({ scopeKey: 'task-task-1', scopeToken: 'token' }, scope)
    ).toEqual({ scopeKey: 'task-task-1', scopeToken: 'token' });
  });

  it('rejects a persistence scope that is not authoritative for the review', () => {
    expect(() =>
      parseReviewDecisionPersistenceScope(
        { scopeKey: 'agent-worker', scopeToken: 'token' },
        { teamName: 'safe-team', taskId: 'task-1' }
      )
    ).toThrow('Decision persistence scope does not match the authoritative review');
  });

  it('parses task and agent history identities without widening accepted prefixes', () => {
    expect(parseReviewHistoryScopeIdentity('task-task-1')).toEqual({ taskId: 'task-1' });
    expect(parseReviewHistoryScopeIdentity('agent-worker')).toEqual({ memberName: 'worker' });
    expect(() => parseReviewHistoryScopeIdentity('team-safe-team')).toThrow(
      'Review decision scope cannot authorize history'
    );
  });
});
