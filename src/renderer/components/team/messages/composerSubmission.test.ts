import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/services/composerDraftRepository', () => ({
  composerDraftRepository: {},
}));

import {
  resetComposerSubmissionForTests,
  runComposerSubmission,
} from './composerSubmission';

import type { ComposerBeginAttemptResult } from '@renderer/hooks/useComposerDraft';
import type { ComposerAttemptOutcome, ComposerDraftRepository } from '@renderer/types/composerDraft';

const address = {
  contextId: 'context-a',
  teamName: 'team-a',
  target: { kind: 'direct' as const, participant: 'alice' },
};

function prepared(attemptId: string): ComposerBeginAttemptResult {
  return {
    result: {
      kind: 'prepared',
      workingCleared: true,
      currentWorkingRevision: 'attempt-revision',
      status: 'durable',
    },
    address,
    attempt: {
      attemptId,
      snapshot: {
        content: { text: 'message', chips: [], attachments: [], actionMode: 'do' },
        editorContext: { kind: 'plain' },
      },
      preparedRequest: {
        kind: 'local',
        teamName: 'team-a',
        request: { member: 'alice', text: 'message' },
      },
      createdAt: 1,
    },
    localEditCounter: 1,
  };
}

function repositoryHarness(): {
  repository: ComposerDraftRepository;
  settleAttempt: ReturnType<typeof vi.fn>;
} {
  const settleAttempt = vi.fn(
    async (_address: unknown, _id: string, _outcome: ComposerAttemptOutcome) => 'durable' as const
  );
  return {
    settleAttempt,
    repository: {
      loadWorking: vi.fn(),
      saveWorking: vi.fn(),
      listWorkingSummaries: vi.fn(),
      discardWorking: vi.fn(),
      moveWorkingAsNew: vi.fn(),
      discardNamespace: vi.fn(),
      beginAttempt: vi.fn(),
      settleAttempt,
      stashWorking: vi.fn(),
      listRecoveries: vi.fn(),
      loadRecovery: vi.fn(),
      restoreRecovery: vi.fn(),
      reconcileRecovery: vi.fn(),
      discardRecovery: vi.fn(),
      subscribe: () => () => undefined,
      isAttemptActive: vi.fn(() => false),
      setAttemptActive: vi.fn(),
    },
  };
}

describe('runComposerSubmission', () => {
  afterEach(() => resetComposerSubmissionForTests());

  it('settles an accepted exact result without waiting for external refresh state', async () => {
    const { repository, settleAttempt } = repositoryHarness();
    const result = await runComposerSubmission({
      attemptId: 'attempt-1',
      prepare: async () => prepared('attempt-1'),
      isContextCurrent: () => true,
      transport: async () => ({ deliveredToInbox: true, messageId: 'message-1' }),
      repository,
    });
    expect(result).toEqual({ kind: 'accepted', attemptId: 'attempt-1', messageId: 'message-1' });
    expect(settleAttempt).toHaveBeenCalledWith(
      address,
      'attempt-1',
      { kind: 'accepted', messageId: 'message-1' }
    );
  });

  it('registers its latch before prepare and blocks a second Enter', async () => {
    const { repository } = repositoryHarness();
    let release!: (value: ComposerBeginAttemptResult) => void;
    const prepare = vi.fn(
      () => new Promise<ComposerBeginAttemptResult>((resolve) => (release = resolve))
    );
    const transport = vi.fn(async () => ({ deliveredToInbox: true, messageId: 'message-1' }));
    const first = runComposerSubmission({
      attemptId: 'attempt-1',
      prepare,
      isContextCurrent: () => true,
      transport,
      repository,
    });
    const second = await runComposerSubmission({
      attemptId: 'attempt-2',
      prepare: async () => prepared('attempt-2'),
      isContextCurrent: () => true,
      transport,
      repository,
    });
    release(prepared('attempt-1'));
    await first;
    expect(second.kind).toBe('blocked');
    expect(prepare).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
  });

  it('does not invoke transport after context switching begins', async () => {
    const { repository, settleAttempt } = repositoryHarness();
    const transport = vi.fn();
    const result = await runComposerSubmission({
      attemptId: 'attempt-1',
      prepare: async () => prepared('attempt-1'),
      isContextCurrent: () => false,
      transport,
      repository,
    });
    expect(result.kind).toBe('not-sent');
    expect(transport).not.toHaveBeenCalled();
    expect(settleAttempt).toHaveBeenCalledWith(
      address,
      'attempt-1',
      expect.objectContaining({ kind: 'not-sent' })
    );
  });

  it('classifies a rejected transport as unconfirmed and never retries', async () => {
    const { repository, settleAttempt } = repositoryHarness();
    const transport = vi.fn(async () => {
      throw new Error('socket closed');
    });
    const result = await runComposerSubmission({
      attemptId: 'attempt-1',
      prepare: async () => prepared('attempt-1'),
      isContextCurrent: () => true,
      transport,
      repository,
    });
    expect(result.kind).toBe('unconfirmed');
    expect(transport).toHaveBeenCalledOnce();
    expect(settleAttempt).toHaveBeenCalledWith(
      address,
      'attempt-1',
      expect.objectContaining({ kind: 'unconfirmed', detail: 'socket closed' })
    );
  });

  it.each([
    { delivered: false, userVisibleImpact: undefined },
    { delivered: true, userVisibleImpact: { state: 'error' as const, message: 'Runtime rejected the message.' } },
  ])('keeps a recovery when runtime delivery fails: %j', async (runtime) => {
    const { repository, settleAttempt } = repositoryHarness();
    const result = await runComposerSubmission({
      attemptId: 'attempt-1',
      prepare: async () => prepared('attempt-1'),
      isContextCurrent: () => true,
      transport: async () => ({
        deliveredToInbox: true,
        messageId: 'message-1',
        runtimeDelivery: { providerId: 'opencode', attempted: true, ...runtime },
      }),
      repository,
    });
    expect(result.kind).toBe('unconfirmed');
    expect(result.messageId).toBe('message-1');
    expect(settleAttempt).toHaveBeenCalledWith(
      address,
      'attempt-1',
      expect.objectContaining({ kind: 'unconfirmed', messageId: 'message-1' })
    );
  });
});
