import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { composerRecoverySummary } from '@renderer/services/composerDraftRecovery';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ComposerOutboxController,
  shouldProjectComposerOutboxItem,
  useComposerOutboxItems,
} from './useComposerOutboxItems';

import type { ComposerDraftDestination } from './composerDraftDestination';
import type {
  ComposerDraftAddress,
  ComposerDraftRepository,
  ComposerRecoveryRecord,
} from '@renderer/types/composerDraft';
import type { InboxMessage } from '@shared/types';

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
const feed: ComposerDraftAddress = {
  contextId: 'context-a',
  teamName: 'team-a',
  target: { kind: 'team-feed' },
};
const crossTeam: ComposerDraftAddress = {
  contextId: 'context-a',
  teamName: 'team-a',
  target: { kind: 'cross-team', toTeam: 'team-b', toMember: 'carol' },
};
const CAN_OPEN_ADDRESS = (): boolean => true;

function recovery(
  id: string,
  address: ComposerDraftAddress,
  reason: ComposerRecoveryRecord['reason'],
  messageId?: string
): ComposerRecoveryRecord {
  return {
    version: 2,
    id,
    address,
    snapshot: {
      content: { text: id, chips: [], attachments: [], actionMode: 'do' },
      editorContext: { kind: 'plain' },
    },
    preparedRequest: {
      kind: 'local',
      teamName: 'team-a',
      request: { member: 'alice', text: id },
    },
    reason,
    createdAt: 1,
    updatedAt: 2,
    ...(reason === 'accepted-awaiting-echo'
      ? { outcome: { kind: 'accepted' as const, messageId } }
      : reason === 'unconfirmed-send'
        ? { outcome: { kind: 'unconfirmed' as const, messageId } }
        : reason === 'not-sent'
          ? { outcome: { kind: 'not-sent' as const, detail: 'offline' } }
          : {}),
  };
}

function destination(address: ComposerDraftAddress): ComposerDraftDestination {
  return {
    address,
    isEmpty: true,
    isLoaded: true,
    loadGeneration: 1,
    workingRevision: '0',
    restoreRecovery: vi.fn(),
    moveWorkingAsNew: vi.fn(),
  };
}

function repositoryHarness(records: ComposerRecoveryRecord[]): ComposerDraftRepository {
  return {
    loadWorking: vi.fn(),
    saveWorking: vi.fn(),
    listWorkingSummaries: vi.fn(async () => ({ summaries: [], status: 'durable' as const })),
    discardWorking: vi.fn(),
    moveWorkingAsNew: vi.fn(),
    discardNamespace: vi.fn(),
    beginAttempt: vi.fn(),
    settleAttempt: vi.fn(),
    stashWorking: vi.fn(),
    listRecoveries: vi.fn(async () => ({
      recoveries: records.map(composerRecoverySummary),
      status: 'durable' as const,
    })),
    loadRecovery: vi.fn(
      async (_contextId, _teamName, id) => records.find((record) => record.id === id) ?? null
    ),
    restoreRecovery: vi.fn(),
    reconcileRecovery: vi.fn(async () => 'blocked' as const),
    discardRecovery: vi.fn(),
    subscribe: () => () => undefined,
    isAttemptActive: () => false,
    setAttemptActive: () => undefined,
  };
}

const Harness = ({
  address,
  repository,
  messages,
  onValue,
  canOpenAddress = CAN_OPEN_ADDRESS,
  draftDestination,
}: {
  address: ComposerDraftAddress;
  repository: ComposerDraftRepository;
  messages: readonly InboxMessage[];
  onValue: (value: ComposerOutboxController) => void;
  canOpenAddress?: (address: ComposerDraftAddress) => boolean;
  draftDestination?: ComposerDraftDestination;
}): null => {
  onValue(
    useComposerOutboxItems({
      contextId: 'context-a',
      teamName: 'team-a',
      viewAddress: address,
      destination: draftDestination ?? destination(address),
      canonicalMessages: messages,
      canOpenAddress,
      repository,
    })
  );
  return null;
};

describe('useComposerOutboxItems', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('filters by exact address and falls unavailable items back only to the team feed', () => {
    expect(shouldProjectComposerOutboxItem(alice, alice, () => true)).toBe(true);
    expect(shouldProjectComposerOutboxItem(bob, alice, () => true)).toBe(false);
    expect(shouldProjectComposerOutboxItem(bob, feed, () => false)).toBe(true);
    expect(shouldProjectComposerOutboxItem(null, feed, () => true)).toBe(true);
    expect(shouldProjectComposerOutboxItem(null, alice, () => false)).toBe(false);
  });

  it('hides accepted echoes but keeps unconfirmed sends visible until verified', async () => {
    const accepted = recovery('accepted', alice, 'accepted-awaiting-echo', 'message-1');
    const unconfirmed = recovery('unconfirmed', alice, 'unconfirmed-send', 'message-1');
    const failed = recovery('failed', alice, 'not-sent');
    const unrelated = recovery('bob', bob, 'not-sent');
    const repository = repositoryHarness([accepted, unconfirmed, failed, unrelated]);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const currentRef: { current: ComposerOutboxController | null } = { current: null };

    await act(async () => {
      root.render(
        <Harness
          address={alice}
          repository={repository}
          messages={[{ messageId: 'message-1', text: 'canonical' } as InboxMessage]}
          onValue={(value) => (currentRef.current = value)}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(currentRef.current?.items.map((item) => item.id)).toEqual([
      'recovery:failed',
      'recovery:unconfirmed',
    ]);
    expect(repository.loadRecovery).toHaveBeenCalledTimes(3);
    expect(repository.reconcileRecovery).toHaveBeenCalledTimes(1);
    expect(repository.reconcileRecovery).toHaveBeenCalledWith(
      'context-a',
      'team-a',
      'accepted',
      'message-1'
    );
    act(() => root.unmount());
  });

  it('shows failed-lookup cross-team recovery without restoring it to the local feed', async () => {
    const repository = repositoryHarness([recovery('cross-team-failed', crossTeam, 'not-sent')]);
    const localDestination = destination(feed);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const currentRef: { current: ComposerOutboxController | null } = { current: null };

    await act(async () => {
      root.render(
        <Harness
          address={feed}
          repository={repository}
          messages={[]}
          canOpenAddress={(address) => address.target.kind !== 'cross-team'}
          draftDestination={localDestination}
          onValue={(value) => (currentRef.current = value)}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const item = currentRef.current?.items[0];
    expect(item?.id).toBe('recovery:cross-team-failed');
    expect(item).toBeDefined();
    if (!item) throw new Error('Expected cross-team recovery in local outbox');
    const restoreResult = await currentRef.current?.restore(item);
    expect(restoreResult?.kind).toBe('blocked');
    expect(restoreResult?.status).toBe('durable');
    if (restoreResult?.kind !== 'blocked') throw new Error('Expected blocked cross-team restore');
    expect(restoreResult.error).toContain('cross-team recipient');
    expect(localDestination.restoreRecovery).not.toHaveBeenCalled();
    await currentRef.current?.copy(item);
    expect(writeText).toHaveBeenCalledWith('cross-team-failed');
    act(() => root.unmount());
  });

  it('ignores a stale address load that resolves after navigation', async () => {
    const aliceRecord = recovery('alice-failed', alice, 'not-sent');
    const bobRecord = recovery('bob-failed', bob, 'not-sent');
    const repository = repositoryHarness([aliceRecord, bobRecord]);
    let resolveAlice!: (value: {
      recoveries: ReturnType<typeof composerRecoverySummary>[];
      status: 'durable';
    }) => void;
    let resolveBob!: typeof resolveAlice;
    const aliceList = new Promise<{
      recoveries: ReturnType<typeof composerRecoverySummary>[];
      status: 'durable';
    }>((resolve) => (resolveAlice = resolve));
    const bobList = new Promise<{
      recoveries: ReturnType<typeof composerRecoverySummary>[];
      status: 'durable';
    }>((resolve) => (resolveBob = resolve));
    vi.mocked(repository.listRecoveries)
      .mockReturnValueOnce(aliceList)
      .mockReturnValueOnce(bobList);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const currentRef: { current: ComposerOutboxController | null } = { current: null };
    const render = (address: ComposerDraftAddress): void => {
      root.render(
        <Harness
          address={address}
          repository={repository}
          messages={[]}
          onValue={(value) => (currentRef.current = value)}
        />
      );
    };

    act(() => render(alice));
    await act(async () => Promise.resolve());
    act(() => render(bob));
    await act(async () => Promise.resolve());
    await act(async () => {
      resolveBob({ recoveries: [composerRecoverySummary(bobRecord)], status: 'durable' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(currentRef.current?.items.map((item) => item.id)).toEqual(['recovery:bob-failed']);

    await act(async () => {
      resolveAlice({ recoveries: [composerRecoverySummary(aliceRecord)], status: 'durable' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(currentRef.current?.items.map((item) => item.id)).toEqual(['recovery:bob-failed']);
    act(() => root.unmount());
  });
});
