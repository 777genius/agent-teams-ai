import { describe, expect, it } from 'vitest';

import { buildRestoredWorking, isComposerRecoveryRecord } from './composerDraftRecovery';

import type { ComposerDraftAddress, ComposerRecoveryRecord } from '@renderer/types/composerDraft';

const alice: ComposerDraftAddress = {
  contextId: 'context-a',
  teamName: 'team-a',
  target: { kind: 'direct', participant: 'alice' },
};
const bob: ComposerDraftAddress = {
  contextId: 'context-a',
  teamName: 'team-a',
  target: { kind: 'direct', participant: 'bob' },
};

function recovery(reason: ComposerRecoveryRecord['reason']): ComposerRecoveryRecord {
  return {
    version: 2,
    id: 'attempt-1',
    address: alice,
    snapshot: {
      content: { text: 'message', chips: [], attachments: [], actionMode: 'ask' },
      editorContext: {
        kind: 'revision',
        originalMessageId: 'message-1',
        recipient: 'alice',
        requestId: 'revision-1',
      },
    },
    preparedRequest: null,
    reason,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('buildRestoredWorking', () => {
  it('retains the exact unknown goal request through repeated recovery without moving it', () => {
    const original: ComposerRecoveryRecord = {
      ...recovery('unconfirmed-send'),
      snapshot: {
        content: {
          text: 'message',
          chips: [],
          attachments: [],
          actionMode: 'do',
          autonomousGoal: { durationHours: 12, maxAttempts: 100 },
        },
        editorContext: { kind: 'plain' },
      },
      preparedRequest: {
        kind: 'local',
        teamName: alice.teamName,
        request: {
          member: 'alice',
          text: 'message',
          messageId: 'TEST-original',
          actionMode: 'do',
          autonomousGoal: { durationHours: 12, maxAttempts: 100 },
        },
      },
    };
    expect(isComposerRecoveryRecord(original)).toBe(true);
    const restored = buildRestoredWorking(original, alice, 'next', false);
    expect(restored.kind).toBe('working');
    if (restored.kind !== 'working') throw new Error('Expected restored original');
    expect(restored.working.content?.restoredOrigin).toEqual({
      kind: 'unconfirmed-send',
      attemptId: 'attempt-1',
      messageId: 'TEST-original',
      autonomousGoalRequest: original.preparedRequest,
    });
    const retry: ComposerRecoveryRecord = {
      ...original,
      id: 'retry-attempt',
      reason: 'not-sent',
      snapshot: { ...original.snapshot, content: restored.working.content! },
    };
    const again = buildRestoredWorking(retry, alice, 'later', false);
    expect(again.kind === 'working' && again.working.content?.restoredOrigin).toMatchObject({
      messageId: 'TEST-original',
      autonomousGoalRequest: original.preparedRequest,
    });
    expect(buildRestoredWorking(original, bob, 'moved', true)).toMatchObject({ kind: 'blocked' });
    expect(
      isComposerRecoveryRecord({
        ...original,
        snapshot: {
          ...original.snapshot,
          content: {
            ...original.snapshot.content,
            autonomousGoal: { durationHours: 12, maxAttempts: -1 },
          },
        },
      })
    ).toBe(false);
  });

  it('keeps revision context only at the original address', () => {
    const same = buildRestoredWorking(recovery('not-sent'), alice, 'next', false);
    expect(same.kind === 'working' && same.working.editorContext.kind).toBe('revision');
    expect(buildRestoredWorking(recovery('not-sent'), bob, 'next', false)).toEqual(
      expect.objectContaining({ kind: 'blocked' })
    );
  });

  it('requires explicit as-new conversion when moving a revision', () => {
    const result = buildRestoredWorking(recovery('not-sent'), bob, 'next', true);
    expect(result.kind).toBe('working');
    if (result.kind === 'working') expect(result.working.editorContext).toEqual({ kind: 'plain' });
  });

  it('marks pending and unconfirmed sends as uncertain instead of auto-sending them', () => {
    const result = buildRestoredWorking(recovery('unconfirmed-send'), alice, 'next', false);
    expect(result.kind).toBe('working');
    if (result.kind === 'working') {
      expect(result.working.content?.restoredOrigin).toEqual({
        kind: 'unconfirmed-send',
        attemptId: 'attempt-1',
      });
    }
  });

  it.each(['displaced-draft', 'legacy-draft', 'not-sent'] as const)(
    'clears stale send origin when restoring %s',
    (reason) => {
      const original = recovery(reason);
      const source = {
        ...original,
        snapshot: {
          ...original.snapshot,
          content: {
            ...original.snapshot.content,
            restoredOrigin: { kind: 'unconfirmed-send' as const, attemptId: 'earlier-attempt' },
          },
        },
      };
      const result = buildRestoredWorking(source, alice, 'next', false);
      expect(result.kind).toBe('working');
      if (result.kind === 'working') {
        expect(result.working.content?.restoredOrigin).toBeUndefined();
      }
    }
  );
});
