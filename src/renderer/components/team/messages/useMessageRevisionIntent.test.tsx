import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storeState = vi.hoisted(() => ({ activeContextId: 'context-a', isContextSwitching: false }));
const repairRepository = vi.hoisted(() => ({
  loadWorking: vi.fn(),
  loadRecovery: vi.fn(),
  beginAttempt: vi.fn(),
  discardRecovery: vi.fn(),
  setAttemptActive: vi.fn(),
  activeIds: new Set<string>(),
}));

vi.mock('@renderer/services/composerDraftRepository', () => ({
  composerDraftRepository: repairRepository,
}));

vi.mock('@renderer/store', () => ({
  useStore: { getState: () => storeState },
}));

vi.mock('@renderer/store/utils/contextScopedRequestEpoch', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@renderer/store/utils/contextScopedRequestEpoch')
  >()),
  captureContextScopedRequestEpoch: () => 1,
  isContextScopedRequestEpochCurrent: () => true,
}));

import { composerDraftAddressKey } from '@renderer/utils/composerDraftIdentity';

import { useMessageRevisionIntent } from './useMessageRevisionIntent';

import type { MessageRevisionDraftTarget } from './messageRevisionTarget';
import type { InboxMessage } from '@shared/types';

const preparedTarget: MessageRevisionDraftTarget = {
  addressKey: composerDraftAddressKey({
    contextId: 'context-a',
    teamName: 'team-a',
    target: { kind: 'direct', participant: 'bob' },
  }),
  loadGeneration: 1,
};

const message = {
  messageId: 'message-1',
  from: 'user',
  to: 'bob',
  source: 'user_sent',
  text: 'unfinished',
  summary: 'unfinished',
  timestamp: '2026-09-22T10:00:00.000Z',
} as InboxMessage;

type HookValue = ReturnType<typeof useMessageRevisionIntent>;
type SendRevisionNotice = Parameters<typeof useMessageRevisionIntent>[0]['sendRevisionNotice'];

const Harness = ({
  prepareRevisionTarget,
  sendRevisionNotice,
  onValue,
  isRevisionTargetCurrent,
}: {
  prepareRevisionTarget: (
    recipient: string,
    signal: AbortSignal
  ) => Promise<MessageRevisionDraftTarget | null>;
  sendRevisionNotice: SendRevisionNotice;
  onValue: (value: HookValue) => void;
  isRevisionTargetCurrent: (target: MessageRevisionDraftTarget) => boolean;
}): null => {
  onValue(
    useMessageRevisionIntent({
      teamName: 'team-a',
      conversationKey: 'team-feed',
      revisionMessageId: 'message-1',
      memberNames: new Set(['bob']),
      sendRevisionNotice,
      navigationGenerationRef: { current: 1 },
      prepareRevisionTarget,
      isRevisionTargetCurrent,
      focusComposer: vi.fn(),
    })
  );
  return null;
};

describe('useMessageRevisionIntent', () => {
  beforeEach(() => {
    storeState.activeContextId = 'context-a';
    storeState.isContextSwitching = false;
    repairRepository.loadWorking.mockResolvedValue({
      working: { workingRevision: 'working-1' },
      status: 'durable',
    });
    repairRepository.beginAttempt.mockResolvedValue({
      kind: 'prepared',
      status: 'durable',
      workingCleared: false,
      currentWorkingRevision: 'working-1',
    });
    repairRepository.discardRecovery.mockResolvedValue('discarded');
    repairRepository.activeIds.clear();
    repairRepository.setAttemptActive.mockImplementation((id: string, enabled: boolean) => {
      repairRepository.activeIds[enabled ? 'add' : 'delete'](id);
    });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function renderHarness(
    prepareRevisionTarget: (
      recipient: string,
      signal: AbortSignal
    ) => Promise<MessageRevisionDraftTarget | null>,
    sendRevisionNotice: SendRevisionNotice = vi.fn(async () => ({ deliveredToInbox: true, messageId: 'notice-1' })),
    isRevisionTargetCurrent: (_target: MessageRevisionDraftTarget) => boolean = () => true
  ) {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let value: HookValue | null = null;
    const render = (isCurrent = isRevisionTargetCurrent): void => {
      root.render(
        <Harness
          prepareRevisionTarget={prepareRevisionTarget}
          sendRevisionNotice={sendRevisionNotice}
          isRevisionTargetCurrent={isCurrent}
          onValue={(next) => (value = next)}
        />
      );
    };
    act(() => render());
    return { root, render, sendRevisionNotice, value: () => value! };
  }

  it('does not send a notice when the prepared recipient already has a draft', async () => {
    const prepare = vi.fn(async () => null);
    const harness = renderHarness(prepare);
    await act(async () => harness.value().handleReviseMessage(message));
    expect(prepare).toHaveBeenCalledWith('bob', expect.any(AbortSignal));
    expect(harness.sendRevisionNotice).not.toHaveBeenCalled();
    expect(harness.value().revisionRequest).toBeNull();
    act(() => harness.root.unmount());
  });

  it('applies only the newest intent when preparations resolve out of order', async () => {
    const resolvers: ((target: MessageRevisionDraftTarget | null) => void)[] = [];
    const prepare = vi.fn(
      () => new Promise<MessageRevisionDraftTarget | null>((resolve) => resolvers.push(resolve))
    );
    const harness = renderHarness(prepare);
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = harness.value().handleReviseMessage(message);
      second = harness.value().handleReviseMessage(message);
    });
    await act(async () => resolvers[1](preparedTarget));
    await second;
    await act(async () => resolvers[0](preparedTarget));
    await first;
    expect(harness.sendRevisionNotice).toHaveBeenCalledOnce();
    expect(harness.value().revisionRequest?.originalMessageId).toBe('message-1');
    expect(repairRepository.beginAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ contextId: 'context-a', teamName: 'team-a' }),
      expect.stringContaining('working-1\0revision-repair:'),
      expect.objectContaining({
        recoveryReason: 'displaced-draft',
        snapshot: expect.objectContaining({
          content: expect.objectContaining({ text: 'unfinished' }),
          editorContext: expect.objectContaining({ kind: 'revision' }),
        }),
      })
    );
    act(() => harness.root.unmount());
  });

  it('does not send a notice when correction recovery cannot be persisted durably', async () => {
    repairRepository.beginAttempt.mockResolvedValueOnce({
      kind: 'prepared',
      status: 'memory-only',
      workingCleared: false,
      currentWorkingRevision: 'working-1',
    });
    const harness = renderHarness(vi.fn(async () => preparedTarget));
    await act(async () => harness.value().handleReviseMessage(message));
    expect(harness.sendRevisionNotice).not.toHaveBeenCalled();
    expect(harness.value().revisionRequest).toBeNull();
    expect(harness.value().revisionPreparation).toBeNull();
    expect(repairRepository.discardRecovery).toHaveBeenCalledWith(
      'context-a', 'team-a', expect.stringMatching(/^revision-repair:/)
    );
    act(() => harness.root.unmount());
  });

  it('does not send when the repair unexpectedly clears a working draft', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    repairRepository.beginAttempt.mockResolvedValueOnce({
      kind: 'prepared',
      status: 'durable',
      workingCleared: true,
      currentWorkingRevision: 'attempt-revision',
    });
    const harness = renderHarness(vi.fn(async () => preparedTarget));
    await act(async () => harness.value().handleReviseMessage(message));
    expect(harness.sendRevisionNotice).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('Revision repair unexpectedly cleared the working draft');
    expect(repairRepository.discardRecovery).not.toHaveBeenCalled();
    act(() => harness.root.unmount());
  });

  it('clears only the older unsent repair when a second Edit wins during persistence', async () => {
    let releaseOlder!: (result: unknown) => void;
    repairRepository.beginAttempt.mockImplementationOnce(
      () => new Promise<unknown>((resolve) => (releaseOlder = resolve))
    );
    const harness = renderHarness(vi.fn(async () => preparedTarget));
    let older!: Promise<void>;
    let newer!: Promise<void>;
    act(() => {
      older = harness.value().handleReviseMessage(message);
    });
    await act(async () => undefined);
    act(() => {
      newer = harness.value().handleReviseMessage(message);
    });
    await act(async () => undefined);
    await newer;
    await act(async () => releaseOlder({
      kind: 'prepared', status: 'durable', workingCleared: false, currentWorkingRevision: 'working-1',
    }));
    await older;

    const olderId = repairRepository.beginAttempt.mock.calls[0]?.[2]?.attemptId;
    const newerId = repairRepository.beginAttempt.mock.calls[1]?.[2]?.attemptId;
    expect(olderId).toMatch(/^revision-repair:/);
    expect(newerId).toMatch(/^revision-repair:/);
    expect(olderId).not.toBe(newerId);
    expect(harness.sendRevisionNotice).toHaveBeenCalledOnce();
    expect(repairRepository.discardRecovery).toHaveBeenCalledWith('context-a', 'team-a', olderId);
    expect(repairRepository.discardRecovery).not.toHaveBeenCalledWith('context-a', 'team-a', newerId);
    act(() => harness.root.unmount());
  });

  it('aborts target preparation on Cancel without leaving a pending intent', async () => {
    let observedSignal: AbortSignal | null = null;
    const prepare = vi.fn(
      (_recipient: string, signal: AbortSignal) =>
        new Promise<MessageRevisionDraftTarget | null>((resolve) => {
          observedSignal = signal;
          signal.addEventListener('abort', () => resolve(null), { once: true });
        })
    );
    const harness = renderHarness(prepare);
    let pending!: Promise<void>;
    act(() => {
      pending = harness.value().handleReviseMessage(message);
    });
    act(() => harness.value().cancelRevision());
    await pending;
    expect((observedSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(harness.sendRevisionNotice).not.toHaveBeenCalled();
    act(() => harness.root.unmount());
  });

  it('invalidates a late Edit notice when the group selector changes draft address', async () => {
    let resolveNotice!: (result: unknown) => void;
    const sendRevisionNotice = vi.fn<SendRevisionNotice>()
      .mockImplementationOnce(() => new Promise<unknown>((resolve) => (resolveNotice = resolve)))
      .mockResolvedValueOnce({ deliveredToInbox: true, messageId: 'cancel-1' });
    const harness = renderHarness(vi.fn(async () => preparedTarget), sendRevisionNotice, () => true);
    let pending!: Promise<void>;
    act(() => {
      pending = harness.value().handleReviseMessage(message);
    });
    await act(async () => undefined);
    expect(sendRevisionNotice).toHaveBeenCalledOnce();

    act(() => harness.render(() => false));
    await act(async () => resolveNotice({ deliveredToInbox: true, messageId: 'notice-1' }));
    await pending;

    expect(harness.value().revisionRequest).toBeNull();
    expect(sendRevisionNotice).toHaveBeenCalledTimes(2);
    expect(sendRevisionNotice.mock.calls[1]?.[1]?.text).toContain('Revision notice MessageId: notice-1');
    act(() => harness.root.unmount());
  });

  it('sends a cancellation notice if Cancel wins while the original notice is in flight', async () => {
    let resolveNotice!: (result: unknown) => void;
    let resolveCancellation!: (result: unknown) => void;
    const sendRevisionNotice = vi.fn<SendRevisionNotice>()
      .mockImplementationOnce(() => new Promise<unknown>((resolve) => (resolveNotice = resolve)))
      .mockImplementationOnce(
        () => new Promise<unknown>((resolve) => (resolveCancellation = resolve))
      );
    const harness = renderHarness(vi.fn(async () => preparedTarget), sendRevisionNotice);
    let pending!: Promise<void>;
    act(() => {
      pending = harness.value().handleReviseMessage(message);
    });
    await act(async () => undefined);
    const repairId = repairRepository.beginAttempt.mock.calls[0]?.[2]?.attemptId as string;
    expect(repairRepository.activeIds.has(repairId)).toBe(true);
    act(() => {
      harness.value().cancelRevision();
      harness.value().cancelRevision();
    });
    await act(async () => resolveNotice({ deliveredToInbox: true, messageId: 'notice-1' }));
    expect(repairRepository.activeIds.has(repairId)).toBe(true);
    await act(async () => resolveCancellation({ deliveredToInbox: true, messageId: 'cancel-1' }));
    await pending;

    expect(harness.value().revisionRequest).toBeNull();
    expect(harness.value().revisionPreparation).toBeNull();
    expect(sendRevisionNotice).toHaveBeenCalledTimes(2);
    expect(repairRepository.activeIds.has(repairId)).toBe(false);
    expect(repairRepository.discardRecovery).toHaveBeenCalledWith(
      'context-a',
      'team-a',
      expect.stringMatching(/^revision-repair:/)
    );
    expect(sendRevisionNotice.mock.calls[1]?.[1]).toMatchObject({
      member: 'bob',
      summary: 'Revision notice for MessageId: message-1 - cancelled',
    });
    act(() => harness.root.unmount());
  });

  it.each([
    ['negative result', { deliveredToInbox: false, messageId: 'cancel-1' }],
    ['rejection', new Error('cancel transport failed')],
  ])('restores the correction editor when cancellation has a %s', async (_label, outcome) => {
    let resolveNotice!: (result: unknown) => void;
    const sendRevisionNotice = vi.fn<SendRevisionNotice>()
      .mockImplementationOnce(() => new Promise<unknown>((resolve) => (resolveNotice = resolve)))
      .mockImplementationOnce(() =>
        outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)
      );
    const harness = renderHarness(vi.fn(async () => preparedTarget), sendRevisionNotice);
    let pending!: Promise<void>;
    act(() => {
      pending = harness.value().handleReviseMessage(message);
    });
    await act(async () => undefined);
    act(() => harness.value().cancelRevision());
    await act(async () => resolveNotice({ deliveredToInbox: true, messageId: 'notice-1' }));
    await pending;

    expect(harness.value().revisionRequest?.originalMessageId).toBe('message-1');
    expect(sendRevisionNotice).toHaveBeenCalledTimes(2);
    expect(repairRepository.discardRecovery).not.toHaveBeenCalled();
    act(() => harness.root.unmount());
  });

  it('cancels only the older notice when a newer edit of the same message succeeds', async () => {
    const resolvers: ((result: unknown) => void)[] = [];
    const sendRevisionNotice = vi.fn<SendRevisionNotice>()
      .mockImplementationOnce(() => new Promise<unknown>((resolve) => resolvers.push(resolve)))
      .mockImplementationOnce(() => new Promise<unknown>((resolve) => resolvers.push(resolve)))
      .mockResolvedValueOnce({ deliveredToInbox: true, messageId: 'cancel-1' });
    const harness = renderHarness(vi.fn(async () => preparedTarget), sendRevisionNotice);
    let older!: Promise<void>;
    let newer!: Promise<void>;
    act(() => {
      older = harness.value().handleReviseMessage(message);
    });
    await act(async () => undefined);
    act(() => {
      newer = harness.value().handleReviseMessage(message);
    });
    await act(async () => undefined);
    await act(async () => resolvers[1]({ deliveredToInbox: true, messageId: 'notice-new' }));
    await newer;
    await act(async () => resolvers[0]({ deliveredToInbox: true, messageId: 'notice-old' }));
    await older;

    expect(harness.value().revisionRequest?.originalMessageId).toBe('message-1');
    expect(sendRevisionNotice).toHaveBeenCalledTimes(3);
    const compensation = sendRevisionNotice.mock.calls[2]?.[1]?.text;
    expect(compensation).toContain('Revision notice MessageId: notice-old');
    expect(compensation).not.toContain('notice-new');
    expect(compensation).toContain('Any later revision notice');
    act(() => harness.root.unmount());
  });

  it('does not send compensation to a different active context', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let resolveNotice!: (result: unknown) => void;
    const sendRevisionNotice = vi.fn<SendRevisionNotice>()
      .mockImplementationOnce(() => new Promise<unknown>((resolve) => (resolveNotice = resolve)));
    const harness = renderHarness(vi.fn(async () => preparedTarget), sendRevisionNotice);
    let pending!: Promise<void>;
    act(() => {
      pending = harness.value().handleReviseMessage(message);
    });
    await act(async () => undefined);
    storeState.activeContextId = 'context-b';
    await act(async () => resolveNotice({ deliveredToInbox: true, messageId: 'notice-1' }));
    await pending;

    expect(sendRevisionNotice).toHaveBeenCalledOnce();
    expect(harness.value().revisionRequest).toBeNull();
    expect(repairRepository.discardRecovery).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('Revision cancellation requires repair in the original context');
    act(() => harness.root.unmount());
  });

  it.each([
    ['rejected', () => Promise.reject(new Error('send failed'))],
    ['negative', () => Promise.resolve({ deliveredToInbox: false, deliveredViaStdin: false, messageId: '' })],
  ])('clears preparation after a %s notice result', async (_label, send) => {
    const harness = renderHarness(vi.fn(async () => preparedTarget), vi.fn(send));
    await act(async () => harness.value().handleReviseMessage(message));
    expect(harness.value().revisionPreparation).toBeNull();
    expect(harness.value().revisionRequest).toBeNull();
    expect(repairRepository.discardRecovery).not.toHaveBeenCalled();
    act(() => harness.root.unmount());
  });

  it('clears durable repair after the corrected message is accepted', async () => {
    const harness = renderHarness(vi.fn(async () => preparedTarget));
    await act(async () => harness.value().handleReviseMessage(message));
    const requestId = harness.value().revisionRequest?.requestId;
    expect(requestId).toMatch(/^revision-repair:/);
    act(() => harness.value().completeRevision(requestId!));
    expect(harness.value().revisionRequest).toBeNull();
    expect(repairRepository.discardRecovery).toHaveBeenCalledWith('context-a', 'team-a', requestId);
    act(() => harness.root.unmount());
  });

  it('clears a restored repair by validating its persisted address and editor request', async () => {
    const submittedAddress = {
      contextId: 'context-a', teamName: 'team-a',
      target: { kind: 'direct' as const, participant: 'bob' },
    };
    const first = renderHarness(vi.fn(async () => preparedTarget));
    await act(async () => first.value().handleReviseMessage(message));
    const requestId = first.value().revisionRequest?.requestId;
    expect(requestId).toMatch(/^revision-repair:/);
    act(() => first.root.unmount());
    repairRepository.loadRecovery.mockResolvedValueOnce({
      address: submittedAddress,
      snapshot: { editorContext: { kind: 'revision', requestId } },
    });
    const restored = renderHarness(vi.fn(async () => preparedTarget));
    storeState.activeContextId = 'context-b';
    await act(async () => restored.value().completeRevision(requestId!, submittedAddress));
    expect(repairRepository.loadRecovery).toHaveBeenCalledWith('context-a', 'team-a', requestId);
    expect(repairRepository.discardRecovery).toHaveBeenCalledWith('context-a', 'team-a', requestId);
    act(() => restored.root.unmount());
  });

  it('does not clear a restored repair whose persisted address belongs to another team', async () => {
    const requestId = 'revision-repair:restored';
    const submittedAddress = {
      contextId: 'context-a', teamName: 'team-a',
      target: { kind: 'direct' as const, participant: 'bob' },
    };
    repairRepository.loadRecovery.mockResolvedValueOnce({
      address: { contextId: 'context-a', teamName: 'another-team' },
      snapshot: { editorContext: { kind: 'revision', requestId } },
    });
    const harness = renderHarness(vi.fn(async () => preparedTarget));
    await act(async () => harness.value().completeRevision(requestId, submittedAddress));
    expect(repairRepository.discardRecovery).not.toHaveBeenCalled();
    act(() => harness.root.unmount());
  });
});
