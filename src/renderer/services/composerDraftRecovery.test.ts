import { describe, expect, it } from 'vitest';

import { buildRestoredWorking } from './composerDraftRecovery';

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
});
