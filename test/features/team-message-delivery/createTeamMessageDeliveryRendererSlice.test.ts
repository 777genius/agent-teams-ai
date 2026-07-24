import { describe, expect, it, vi } from 'vitest';

import {
  createTeamMessageDeliveryRendererSlice,
  type TeamMessageDeliveryRendererSliceDependencies,
  type TeamMessageDeliveryRendererSliceState,
} from '../../../src/features/team-message-delivery/renderer';

import type {
  CrossTeamSendRequest,
  InboxMessage,
  OpenCodeRuntimeDeliveryStatus,
  SendMessageRequest,
  SendMessageResult,
} from '../../../src/shared/types';

interface TestState extends TeamMessageDeliveryRendererSliceState {
  optimisticMessagesByTeam: Record<string, InboxMessage[]>;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function initialState(): TestState {
  return {
    sendingMessage: false,
    sendMessageError: null,
    sendMessageWarning: null,
    sendMessageDebugDetails: null,
    lastSendMessageResult: null,
    crossTeamTargets: [],
    crossTeamTargetsLoading: false,
    optimisticMessagesByTeam: {},
  };
}

function createHarness() {
  const trace: string[] = [];
  let state = initialState();
  let contextEpoch = 1;

  const send = vi.fn<(teamName: string, request: SendMessageRequest) => Promise<SendMessageResult>>(
    () =>
      Promise.resolve({
        deliveredToInbox: true,
        messageId: 'message-1',
      })
  );
  const getRuntimeDeliveryStatus = vi.fn(
    (): Promise<OpenCodeRuntimeDeliveryStatus | null> => Promise.resolve(null)
  );
  const listTargets = vi.fn(() => Promise.resolve([{ teamName: 'peer', displayName: 'Peer' }]));
  const sendCrossTeam = vi.fn(() =>
    Promise.resolve({
      messageId: 'cross-message-1',
      deliveredToInbox: true,
    })
  );
  const recordAttachment = vi.fn(() => trace.push('analytics:attachment'));
  const recordCrossTeamMessage = vi.fn(() => trace.push('analytics:cross-team'));
  const recordCrossTeamTargetsFailure = vi.fn();
  const refreshMessageHead = vi.fn((teamName: string) => {
    trace.push(`refresh:${teamName}`);
    return Promise.resolve();
  });

  const dependencies: TeamMessageDeliveryRendererSliceDependencies<TestState, number> = {
    analytics: {
      classifyError: () => 'classified',
      recordAttachment,
      recordCrossTeamMessage,
    },
    clock: {
      nowIso: () => '2026-07-23T12:00:00.000Z',
    },
    crossTeamTransport: {
      listTargets,
      send: sendCrossTeam,
    },
    diagnostics: {
      build: (result) => {
        const runtimeDelivery = result.runtimeDelivery;
        return {
          warning: runtimeDelivery?.attempted
            ? `runtime:${runtimeDelivery.reason ?? 'pending'}`
            : null,
          debugDetails: runtimeDelivery?.attempted
            ? {
                messageId: result.messageId,
                statusMessageId: runtimeDelivery.queuedBehindMessageId ?? result.messageId,
                providerId: runtimeDelivery.providerId,
                delivered: runtimeDelivery.delivered,
                responsePending: runtimeDelivery.responsePending ?? null,
                responseState: runtimeDelivery.responseState ?? null,
                ledgerStatus: runtimeDelivery.ledgerStatus ?? null,
                acceptanceUnknown: runtimeDelivery.acceptanceUnknown ?? null,
                reason: runtimeDelivery.reason ?? null,
                diagnostics: runtimeDelivery.diagnostics ?? [],
              }
            : null,
        };
      },
      isHardFailure: (runtimeDelivery) =>
        runtimeDelivery?.attempted === true && runtimeDelivery.delivered === false,
    },
    errors: {
      mapSendError: (error) => `mapped:${error instanceof Error ? error.message : String(error)}`,
    },
    log: {
      recordCrossTeamTargetsFailure,
    },
    optimisticMessages: {
      project: (current, teamName, message) => {
        trace.push('optimistic');
        return {
          optimisticMessagesByTeam: {
            ...current.optimisticMessagesByTeam,
            [teamName]: [...(current.optimisticMessagesByTeam[teamName] ?? []), message],
          },
        };
      },
    },
    refresh: {
      refreshMessageHead,
    },
    requestScope: {
      capture: () => contextEpoch,
      isCurrent: (capturedEpoch) => capturedEpoch === contextEpoch,
    },
    state: {
      getState: () => state,
      setState: (update) => {
        const patch = typeof update === 'function' ? update(state) : update;
        state = { ...state, ...patch };
      },
    },
    transport: {
      getRuntimeDeliveryStatus,
      send: async (teamName, request) => {
        trace.push(`send:${teamName}:${request.member}`);
        return send(teamName, request);
      },
    },
  };

  const slice = createTeamMessageDeliveryRendererSlice(dependencies);

  return {
    advanceContext: () => {
      contextEpoch += 1;
    },
    getRuntimeDeliveryStatus,
    getState: () => state,
    listTargets,
    patchState: (patch: Partial<TestState>) => {
      state = { ...state, ...patch };
    },
    recordAttachment,
    recordCrossTeamMessage,
    recordCrossTeamTargetsFailure,
    refreshMessageHead,
    send,
    sendCrossTeam,
    slice,
    trace,
  };
}

const crossTeamRequest: CrossTeamSendRequest = {
  fromTeam: 'source-team',
  fromMember: 'user',
  toTeam: 'target-team',
  text: 'hello',
  taskRefs: [{ taskId: 'task-1', displayId: 'TASK-1', teamName: 'source-team' }],
  replyToConversationId: 'conversation-1',
  chainDepth: 2,
};

describe('createTeamMessageDeliveryRendererSlice', () => {
  it('projects a direct send before refreshing and preserves optimistic message metadata', async () => {
    const harness = createHarness();
    const result: SendMessageResult = {
      deliveredToInbox: true,
      deliveredViaStdin: true,
      messageId: 'message-live',
    };
    harness.send.mockImplementationOnce(() => Promise.resolve(result));
    harness.refreshMessageHead.mockImplementationOnce((teamName) => {
      expect(harness.getState().lastSendMessageResult).toBe(result);
      expect(harness.getState().sendingMessage).toBe(false);
      harness.trace.push(`refresh:${teamName}`);
      return Promise.resolve();
    });

    await expect(
      harness.slice.sendTeamMessage('alpha', {
        member: 'alice',
        text: 'review this',
        to: 'team-lead',
        taskRefs: [{ taskId: 'task-1', displayId: 'TASK-1', teamName: 'alpha' }],
        attachments: [
          {
            id: 'attachment-1',
            filename: 'image.png',
            mimeType: 'image/png',
            size: 3,
            data: 'AAAA',
          },
        ],
      })
    ).resolves.toBe(result);

    expect(harness.trace).toEqual([
      'send:alpha:alice',
      'analytics:attachment',
      'optimistic',
      'refresh:alpha',
    ]);
    expect(harness.recordAttachment).toHaveBeenCalledWith({
      attachments: [
        {
          id: 'attachment-1',
          filename: 'image.png',
          mimeType: 'image/png',
          size: 3,
          data: 'AAAA',
        },
      ],
      success: true,
      errorClass: 'none',
    });
    expect(harness.getState().optimisticMessagesByTeam.alpha).toEqual([
      expect.objectContaining({
        from: 'user',
        to: 'team-lead',
        text: 'review this',
        timestamp: '2026-07-23T12:00:00.000Z',
        read: true,
        messageId: 'message-live',
        source: 'user_sent',
        taskRefs: [{ taskId: 'task-1', displayId: 'TASK-1', teamName: 'alpha' }],
      }),
    ]);
  });

  it('keeps inbox persistence optimistic but withholds the terminal result on hard runtime failure', async () => {
    const harness = createHarness();
    harness.send.mockResolvedValueOnce({
      deliveredToInbox: true,
      messageId: 'message-runtime-failed',
      runtimeDelivery: {
        providerId: 'opencode',
        attempted: true,
        delivered: false,
        reason: 'runtime_unavailable',
      },
    });

    await expect(
      harness.slice.sendTeamMessage('alpha', { member: 'alice', text: 'hello' })
    ).resolves.toMatchObject({ messageId: 'message-runtime-failed' });

    expect(harness.getState().lastSendMessageResult).toBeNull();
    expect(harness.getState().sendMessageError).toBeNull();
    expect(harness.getState().sendMessageWarning).toBe('runtime:runtime_unavailable');
    expect(harness.getState().optimisticMessagesByTeam.alpha).toHaveLength(1);
    expect(harness.refreshMessageHead).toHaveBeenCalledWith('alpha');
  });

  it('maps and rethrows direct send failures without optimistic projection or refresh', async () => {
    const harness = createHarness();
    const failure = new Error('disk failed');
    harness.send.mockRejectedValueOnce(failure);

    await expect(
      harness.slice.sendTeamMessage('alpha', {
        member: 'alice',
        text: 'hello',
        attachments: [
          {
            id: 'attachment-1',
            filename: 'image.png',
            mimeType: 'image/png',
            size: 3,
            data: 'AAAA',
          },
        ],
      })
    ).rejects.toBe(failure);

    expect(harness.getState().sendMessageError).toBe('mapped:disk failed');
    expect(harness.getState().sendingMessage).toBe(false);
    expect(harness.getState().optimisticMessagesByTeam).toEqual({});
    expect(harness.refreshMessageHead).not.toHaveBeenCalled();
    expect(harness.recordAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorClass: 'classified',
      })
    );
  });

  it('checks the original queued message after a terminal blocker and projects that result', async () => {
    const harness = createHarness();
    harness.patchState({
      sendMessageDebugDetails: {
        messageId: 'queued-message',
        statusMessageId: 'blocker-message',
        providerId: 'opencode',
        delivered: true,
        responsePending: true,
        responseState: 'pending',
        ledgerStatus: 'accepted',
        acceptanceUnknown: false,
        reason: 'queued',
        diagnostics: [],
      },
    });
    harness.getRuntimeDeliveryStatus
      .mockResolvedValueOnce({
        messageId: 'blocker-message',
        providerId: 'opencode',
        attempted: true,
        delivered: true,
        responsePending: false,
        responseState: 'responded_visible_message',
        userVisibleImpact: { state: 'none' },
      })
      .mockResolvedValueOnce({
        messageId: 'queued-message',
        providerId: 'opencode',
        attempted: true,
        delivered: false,
        responsePending: false,
        responseState: 'empty_assistant_turn',
        reason: 'empty_assistant_turn',
        userVisibleImpact: { state: 'error' },
      });

    await harness.slice.refreshSendMessageRuntimeDeliveryStatus('alpha', {
      messageId: 'queued-message',
      statusMessageId: 'blocker-message',
    });

    expect(harness.getRuntimeDeliveryStatus.mock.calls).toEqual([
      ['alpha', 'blocker-message'],
      ['alpha', 'queued-message'],
    ]);
    expect(harness.getState().sendMessageWarning).toBe('runtime:empty_assistant_turn');
    expect(harness.getState().sendMessageDebugDetails?.messageId).toBe('queued-message');
  });

  it('does not let a late delivery status overwrite diagnostics for a newer message', async () => {
    const harness = createHarness();
    const status = deferred<OpenCodeRuntimeDeliveryStatus | null>();
    harness.patchState({
      sendMessageDebugDetails: {
        messageId: 'old-message',
        providerId: 'opencode',
        delivered: true,
        responsePending: true,
        responseState: 'pending',
        ledgerStatus: 'accepted',
        acceptanceUnknown: false,
        reason: 'pending',
        diagnostics: [],
      },
    });
    harness.getRuntimeDeliveryStatus.mockReturnValueOnce(status.promise);

    const refresh = harness.slice.refreshSendMessageRuntimeDeliveryStatus('alpha', 'old-message');
    harness.patchState({
      sendMessageWarning: 'new-warning',
      sendMessageDebugDetails: {
        messageId: 'new-message',
        providerId: 'opencode',
        delivered: true,
        responsePending: true,
        responseState: 'pending',
        ledgerStatus: 'accepted',
        acceptanceUnknown: false,
        reason: 'new',
        diagnostics: [],
      },
    });
    status.resolve({
      messageId: 'old-message',
      providerId: 'opencode',
      attempted: true,
      delivered: false,
      reason: 'old-failed',
    });
    await refresh;

    expect(harness.getState().sendMessageWarning).toBe('new-warning');
    expect(harness.getState().sendMessageDebugDetails?.messageId).toBe('new-message');
  });

  it('fences late cross-team targets by request scope without clearing the new context state', async () => {
    const harness = createHarness();
    const targets = deferred<{ teamName: string; displayName: string }[]>();
    harness.listTargets.mockReturnValueOnce(targets.promise);

    const refresh = harness.slice.fetchCrossTeamTargets();
    expect(harness.getState().crossTeamTargetsLoading).toBe(true);
    harness.advanceContext();
    harness.patchState({
      crossTeamTargets: [{ teamName: 'new-peer', displayName: 'New Peer' }],
      crossTeamTargetsLoading: false,
    });
    targets.resolve([{ teamName: 'old-peer', displayName: 'Old Peer' }]);

    await expect(refresh).resolves.toBe(false);
    expect(harness.getState().crossTeamTargets).toEqual([
      { teamName: 'new-peer', displayName: 'New Peer' },
    ]);
    expect(harness.recordCrossTeamTargetsFailure).not.toHaveBeenCalled();
  });

  it('records and refreshes a successful cross-team send after publishing result state', async () => {
    const harness = createHarness();
    harness.refreshMessageHead.mockImplementationOnce((teamName) => {
      expect(harness.getState().lastSendMessageResult).toEqual({
        messageId: 'cross-message-1',
        deliveredToInbox: true,
        deduplicated: undefined,
      });
      harness.trace.push(`refresh:${teamName}`);
      return Promise.resolve();
    });

    await harness.slice.sendCrossTeamMessage(crossTeamRequest);

    expect(harness.recordCrossTeamMessage).toHaveBeenCalledWith({
      source: 'user',
      success: true,
      hasReplyTo: true,
      conversationDepth: 2,
      hasTaskRefs: true,
      errorClass: 'none',
    });
    expect(harness.trace).toEqual(['analytics:cross-team', 'refresh:source-team']);
  });

  it('keeps cross-team send failures non-throwing while publishing mapped error state', async () => {
    const harness = createHarness();
    harness.sendCrossTeam.mockRejectedValueOnce(new Error('target offline'));

    await expect(harness.slice.sendCrossTeamMessage(crossTeamRequest)).resolves.toBeUndefined();

    expect(harness.getState().sendMessageError).toBe('mapped:target offline');
    expect(harness.getState().sendingMessage).toBe(false);
    expect(harness.refreshMessageHead).not.toHaveBeenCalled();
    expect(harness.recordCrossTeamMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorClass: 'classified',
      })
    );
  });
});
