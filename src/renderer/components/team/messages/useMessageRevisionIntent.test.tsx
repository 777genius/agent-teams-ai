import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storeState = vi.hoisted(() => ({ activeContextId: 'context-a', isContextSwitching: false }));

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

import { useMessageRevisionIntent } from './useMessageRevisionIntent';

import type { MessageRevisionDraftTarget } from './messageRevisionTarget';
import type { InboxMessage } from '@shared/types';

const preparedTarget: MessageRevisionDraftTarget = {
  addressKey: 'composer:bob',
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
  sendRevisionNotice: (...args: Parameters<Parameters<typeof useMessageRevisionIntent>[0]['sendRevisionNotice']>) => Promise<unknown>;
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
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function renderHarness(
    prepareRevisionTarget: (
      recipient: string,
      signal: AbortSignal
    ) => Promise<MessageRevisionDraftTarget | null>,
    sendRevisionNotice = vi.fn(async () => ({ deliveredToInbox: true, messageId: 'notice-1' })),
    isRevisionTargetCurrent: (_target: MessageRevisionDraftTarget) => boolean = () => true
  ) {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let value: HookValue | null = null;
    act(() => {
      root.render(
        <Harness
          prepareRevisionTarget={prepareRevisionTarget}
          sendRevisionNotice={sendRevisionNotice}
          isRevisionTargetCurrent={isRevisionTargetCurrent}
          onValue={(next) => (value = next)}
        />
      );
    });
    return { root, sendRevisionNotice, value: () => value as HookValue };
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
    let currentAddressKey = preparedTarget.addressKey;
    const sendRevisionNotice = vi.fn(
      () => new Promise<unknown>((resolve) => (resolveNotice = resolve))
    );
    const harness = renderHarness(
      vi.fn(async () => preparedTarget),
      sendRevisionNotice,
      (target) => target.addressKey === currentAddressKey
    );
    let pending!: Promise<void>;
    act(() => {
      pending = harness.value().handleReviseMessage(message);
    });
    await act(async () => undefined);
    expect(sendRevisionNotice).toHaveBeenCalledOnce();

    currentAddressKey = 'composer:alice';
    await act(async () => resolveNotice({ deliveredToInbox: true, messageId: 'notice-1' }));
    await pending;

    expect(harness.value().revisionRequest).toBeNull();
    act(() => harness.root.unmount());
  });
});
