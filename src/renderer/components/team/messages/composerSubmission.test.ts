import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/services/composerDraftRepository', () => ({
  composerDraftRepository: {},
}));

import {
  isComposerSubmissionActive,
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
const otherAddress = {
  contextId: 'context-b',
  teamName: 'team-b',
  target: { kind: 'direct' as const, participant: 'bob' },
};

function prepared(attemptId: string, destination = address): ComposerBeginAttemptResult {
  return {
    result: {
      kind: 'prepared',
      workingCleared: true,
      currentWorkingRevision: 'attempt-revision',
      status: 'durable',
    },
    address: destination,
    attempt: {
      attemptId,
      snapshot: {
        content: { text: 'message', chips: [], attachments: [], actionMode: 'do' },
        editorContext: { kind: 'plain' },
      },
      preparedRequest: {
        kind: 'local',
        teamName: destination.teamName,
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
      contextId: 'context-a',
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
      contextId: 'context-a',
      prepare,
      isContextCurrent: () => true,
      transport,
      repository,
    });
    const second = await runComposerSubmission({
      attemptId: 'attempt-2',
      contextId: 'context-a',
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

  it('allows a new context to send while an old context transport remains pending', async () => {
    const { repository, settleAttempt } = repositoryHarness();
    let resolveOld!: (result: { deliveredToInbox: boolean; messageId: string }) => void;
    const oldTransport = vi.fn(
      () => new Promise<{ deliveredToInbox: boolean; messageId: string }>((resolve) => {
        resolveOld = resolve;
      })
    );
    const old = runComposerSubmission({
      attemptId: 'attempt-old',
      contextId: 'context-a',
      prepare: async () => prepared('attempt-old'),
      isContextCurrent: () => true,
      transport: oldTransport,
      repository,
    });
    await vi.waitFor(() => expect(oldTransport).toHaveBeenCalledOnce());
    const duplicatePrepare = vi.fn(async () => prepared('attempt-duplicate'));
    const duplicate = await runComposerSubmission({
      attemptId: 'attempt-duplicate',
      contextId: 'context-a',
      prepare: duplicatePrepare,
      isContextCurrent: () => true,
      transport: vi.fn(),
      repository,
    });
    expect(duplicate.kind).toBe('blocked');
    expect(duplicatePrepare).not.toHaveBeenCalled();

    const fresh = await runComposerSubmission({
      attemptId: 'attempt-new',
      contextId: 'context-b',
      prepare: async () => prepared('attempt-new', otherAddress),
      isContextCurrent: () => true,
      transport: async () => ({ deliveredToInbox: true, messageId: 'message-new' }),
      repository,
    });
    expect(fresh.kind).toBe('accepted');
    expect(settleAttempt).toHaveBeenCalledWith(
      otherAddress, 'attempt-new', { kind: 'accepted', messageId: 'message-new' }
    );
    expect(isComposerSubmissionActive('attempt-old')).toBe(true);
    expect(isComposerSubmissionActive('attempt-new')).toBe(false);

    resolveOld({ deliveredToInbox: true, messageId: 'message-old' });
    expect((await old).kind).toBe('accepted');
    expect(isComposerSubmissionActive()).toBe(false);
  });

  it('does not dispatch when the prepared address differs from the captured context', async () => {
    const { repository, settleAttempt } = repositoryHarness();
    const transport = vi.fn();
    const result = await runComposerSubmission({
      attemptId: 'attempt-mismatched',
      contextId: 'context-a',
      prepare: async () => prepared('attempt-mismatched', otherAddress),
      isContextCurrent: () => true,
      transport,
      repository,
    });
    expect(result.kind).toBe('not-sent');
    expect(transport).not.toHaveBeenCalled();
    expect(settleAttempt).toHaveBeenCalledWith(
      otherAddress, 'attempt-mismatched', expect.objectContaining({ kind: 'not-sent' })
    );
  });

  it('does not invoke transport after context switching begins', async () => {
    const { repository, settleAttempt } = repositoryHarness();
    const transport = vi.fn();
    const result = await runComposerSubmission({
      attemptId: 'attempt-1',
      contextId: 'context-a',
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
      contextId: 'context-a',
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
      contextId: 'context-a',
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
