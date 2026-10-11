import React, { act, isValidElement } from 'react';
import { createRoot } from 'react-dom/client';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureQueueScope } from '../../../src/features/manual-message-queue/renderer/adapters/queueBinding';
import {
  dispatchQueueItem,
  ownsQueueAttempt,
} from '../../../src/features/manual-message-queue/renderer/adapters/queueDispatch';
import { IndexedDbQueueRepository } from '../../../src/features/manual-message-queue/renderer/adapters/queueRepository';
import { useManualMessageQueue } from '../../../src/features/manual-message-queue/renderer/hooks/useManualMessageQueue';
import {
  acquireComposerSubmission,
  releaseComposerSubmission,
  resetComposerSubmissionForTests,
  runComposerSubmission,
} from '../../../src/renderer/components/team/messages/composerSubmission';
import {
  invalidateContextScopedRequestEpoch,
  resetContextScopedRequestEpochForTests,
} from '../../../src/renderer/store/utils/contextScopedRequestEpoch';

import { clearStore, directRoute, scope, seed, working } from './queueFixture';

import type {
  QueueItem,
  QueueRoute,
} from '../../../src/features/manual-message-queue/core/domain/queue';
import type { QueueListProps } from '../../../src/features/manual-message-queue/renderer/ui/QueueList';
import type { InboxMessage } from '../../../src/shared/types';

const bindingPorts = vi.hoisted(() => ({
  state: {
    activeContextId: 'local',
    isContextSwitching: false,
    connectedHost: null as string | null,
  },
  root: vi.fn(),
  ssh: vi.fn(),
  pages: vi.fn(),
  translate: (key: string) => key,
}));
vi.mock('@renderer/store', () => ({
  useStore: Object.assign(
    (select: (state: typeof bindingPorts.state) => unknown) => select(bindingPorts.state),
    { getState: () => bindingPorts.state }
  ),
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: bindingPorts.translate }),
}));
vi.mock('@renderer/api', () => ({
  api: {
    config: { getClaudeRootInfo: bindingPorts.root },
    ssh: { getState: bindingPorts.ssh },
    teams: { getMessagesPage: bindingPorts.pages },
  },
}));

describe('selected manual send contract', () => {
  beforeEach(async () => {
    await clearStore();
    resetComposerSubmissionForTests();
  });
  async function queued(route: QueueRoute = directRoute) {
    const repository = new IndexedDbQueueRepository();
    const target = {
      ...scope,
      chat: route.kind === 'direct' ? 'direct:' + route.participant : 'group:' + route.groupChatId,
    };
    const draft = working('Selected', route);
    await seed(draft);
    await repository.enqueue(target, route, draft, () => true);
    return { repository, target, item: (await repository.list(target, ownsQueueAttempt))[0] };
  }
  it('binds SSH to the effective local root and authoritative host, rejecting disagreement or a switch during resolution', async () => {
    bindingPorts.state = {
      activeContextId: 'ssh-sandbox',
      isContextSwitching: false,
      connectedHost: 'sandbox',
    };
    bindingPorts.root.mockResolvedValue({ resolvedPath: '/local/configured/.claude' });
    bindingPorts.ssh.mockResolvedValue({
      state: 'connected',
      host: 'sandbox',
      remoteProjectsPath: '/remote/projects',
    });
    const captured = await captureQueueScope('test-team', directRoute);
    expect(captured).toMatchObject({
      root: '/local/configured/.claude',
      contextId: 'ssh-sandbox',
      host: 'sandbox',
    });
    bindingPorts.ssh.mockResolvedValue({ state: 'connected', host: 'different' });
    await expect(captureQueueScope('test-team', directRoute)).rejects.toThrow('rootUnavailable');
    bindingPorts.ssh.mockResolvedValue({ state: 'connected', host: 'sandbox' });
    bindingPorts.root.mockImplementation(async () => {
      bindingPorts.state = {
        activeContextId: 'local',
        isContextSwitching: false,
        connectedHost: null,
      };
      return { resolvedPath: '/local/configured/.claude' };
    });
    await expect(captureQueueScope('test-team', directRoute)).rejects.toThrow('rootUnavailable');
  });
  it('claims before one direct transport, shares the ordinary-send latch, survives remount, and settles without its UI', async () => {
    const { repository, target, item } = await queued();
    const next = working('Keep queued');
    await seed(next);
    await repository.enqueue(target, directRoute, next, () => true);
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const transport = vi.fn(async (captured: QueueItem) => {
      expect(captured.state).toBe('sending');
      expect((await repository.list(target, ownsQueueAttempt))[0].state).toBe('sending');
      entered();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { deliveredToInbox: true, messageId: captured.attempt!.messageId };
    });
    const sending = dispatchQueueItem({
      item,
      repository,
      binding: async () => target,
      isCurrent: () => true,
      blockedReason: () => null,
      prepare: (row, messageId) => ({ messageId, text: row.text, actionMode: row.actionMode }),
      transport,
    });
    await started;
    const ordinaryPrepare = vi.fn();
    const ordinary = await runComposerSubmission({
      contextId: target.contextId,
      attemptId: crypto.randomUUID(),
      prepare: ordinaryPrepare,
      isContextCurrent: () => true,
      transport: vi.fn(),
      repository: { isAttemptActive: () => false } as never,
    });
    expect(ordinary.kind).toBe('blocked');
    expect(ordinaryPrepare).not.toHaveBeenCalled();
    finish();
    await sending;
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await repository.list(target, ownsQueueAttempt)).map((row) => row.text)).toEqual([
      'Keep queued',
    ]);
  });
  it('keeps canonical custom-group routing and captured recipient, accepts saved partial fanout, and sends only the selected row', async () => {
    const route: QueueRoute = { kind: 'group', groupChatId: 'custom-group', recipientName: 'bob' };
    const { repository, target, item } = await queued(route);
    const transport = vi.fn(async (captured: QueueItem, request) => {
      expect(captured.route).toEqual(route);
      expect(request.messageId).not.toBe(item.queueItemId);
      return { saved: true as const, deliveredMemberNames: ['bob'], failedMemberNames: ['alice'] };
    });
    await dispatchQueueItem({
      item,
      repository,
      binding: async () => target,
      isCurrent: () => true,
      blockedReason: () => null,
      prepare: (row, messageId) => ({ messageId, text: row.text, actionMode: row.actionMode }),
      transport,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await repository.list(target, ownsQueueAttempt)).toEqual([]);
  });
  it('resets deterministic group rejection for a fresh attempt, but freezes uncertain failures without retry', async () => {
    const { repository, target, item } = await queued({
      kind: 'group',
      groupChatId: 'custom-group',
      recipientName: null,
    });
    const ids: string[] = [];
    const rejected = Object.assign(new Error('Archived before save'), { code: 'archived' });
    const transport = vi.fn(async (_row, request) => {
      ids.push(request.messageId);
      throw ids.length === 1 ? rejected : new Error('Lost response after possible save');
    });
    const options = {
      repository,
      binding: async () => target,
      isCurrent: () => true,
      blockedReason: () => null,
      prepare: (row: QueueItem, messageId: string) => ({
        messageId,
        text: row.text,
        actionMode: row.actionMode,
      }),
      transport,
    };
    await dispatchQueueItem({ ...options, item });
    let [row] = await repository.list(target, ownsQueueAttempt);
    expect(row.state).toBe('queued');
    expect(row.attempt).toBeUndefined();
    await repository.edit(row, 'Edited after known rejection');
    [row] = await repository.list(target, ownsQueueAttempt);
    await dispatchQueueItem({ ...options, item: row });
    [row] = await repository.list(target, ownsQueueAttempt);
    expect(row.state).toBe('unknown');
    expect(row.attempt!.request.text).toBe('Edited after known rejection');
    expect(ids[0]).not.toBe(ids[1]);
    await expect(dispatchQueueItem({ ...options, item: row })).rejects.toThrow('queue-frozen');
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('makes no transport call when the root changes after claim or the context latch is occupied', async () => {
    const { repository, target, item } = await queued();
    const transport = vi.fn();
    acquireComposerSubmission(target.contextId, 'ordinary-group');
    const options = {
      item,
      repository,
      binding: async () => target,
      blockedReason: () => null,
      isCurrent: () => true,
      prepare: (row: QueueItem, messageId: string) => ({
        messageId,
        text: row.text,
        actionMode: row.actionMode,
      }),
      transport,
    };
    await expect(dispatchQueueItem(options)).rejects.toThrow('queue-busy');
    releaseComposerSubmission(target.contextId, 'ordinary-group');
    let reads = 0;
    await dispatchQueueItem({
      ...options,
      binding: async () => (++reads === 1 ? target : { ...target, root: '/new-root' }),
    });
    expect(transport).not.toHaveBeenCalled();
    const [row] = await repository.list(target, ownsQueueAttempt);
    expect(row.state).toBe('queued');
    expect(row.attempt).toBeUndefined();
  });
  it('checks older exact echoes while absence, cursor loops, errors and a context switch preserve unknown delivery', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    try {
      for (const scenario of ['direct', 'group', 'absent', 'cursor-loop', 'switch', 'error']) {
        await clearStore();
        resetContextScopedRequestEpochForTests();
        bindingPorts.state = {
          activeContextId: 'local',
          isContextSwitching: false,
          connectedHost: null,
        };
        bindingPorts.root.mockReset().mockResolvedValue({ resolvedPath: scope.root });
        const route: QueueRoute =
          scenario === 'group'
            ? { kind: 'group', groupChatId: 'custom', recipientName: 'bob' }
            : directRoute;
        const { repository, target, item } = await queued(route);
        const messageId = crypto.randomUUID();
        const claimed = await repository.claim(item, {
          messageId,
          text: item.text,
          actionMode: item.actionMode,
        });
        await repository.settle(claimed, 'unknown');
        const [unknown] = await repository.list(target, ownsQueueAttempt);
        const echo: InboxMessage = {
          from: 'user',
          to: 'Bob',
          messageId,
          text: item.text,
          timestamp: '2026-10-11T00:00:00Z',
          read: true,
          ...(route.kind === 'group' ? { groupChatId: route.groupChatId } : {}),
        };
        const wrong = { ...echo, groupChatId: 'another-group' };
        let reads = 0;
        bindingPorts.pages.mockReset().mockImplementation(async (_team, request) => {
          reads += 1;
          if (scenario === 'error') throw new Error('History unavailable');
          if (reads === 1)
            return { messages: [wrong], hasMore: true, nextCursor: 'older', feedRevision: 'test' };
          expect(request.cursor).toBe('older');
          if (scenario === 'switch') invalidateContextScopedRequestEpoch();
          return {
            messages: scenario === 'absent' || scenario === 'cursor-loop' ? [wrong] : [echo],
            hasMore: scenario === 'cursor-loop',
            nextCursor: scenario === 'cursor-loop' ? 'older' : null,
            feedRevision: 'test',
          };
        });
        const refresh = vi.fn(async () => {});
        const transport = vi.fn();
        let queue!: ReturnType<typeof useManualMessageQueue>;
        function Probe() {
          queue = useManualMessageQueue({
            teamName: target.teamName,
            route,
            consume: async () => {},
            blockedReason: () => null,
            prepare: (row, id) => ({ messageId: id, text: row.text, actionMode: row.actionMode }),
            transport,
            refresh,
          });
          return null;
        }
        const view = createRoot(document.createElement('div'));
        try {
          await act(async () => {
            view.render(React.createElement(Probe));
          });
          await act(async () => {
            await repository.list(target, ownsQueueAttempt);
          });
          if (!isValidElement<QueueListProps>(queue.list)) throw new Error('Missing queue view');
          expect(queue.list.props.items).toHaveLength(1);
          const check = queue.list.props.onCheck;
          await act(async () => {
            const operation = check(unknown);
            if (scenario === 'direct' || scenario === 'group') await operation;
            else await expect(operation).rejects.toThrow();
          });
          let remaining: readonly QueueItem[] = [];
          await act(async () => {
            remaining = await repository.list(target, ownsQueueAttempt);
          });
          expect(transport).not.toHaveBeenCalled();
          if (scenario === 'direct' || scenario === 'group') {
            expect(remaining).toEqual([]);
            expect(refresh).toHaveBeenCalledTimes(1);
          } else {
            expect(remaining).toEqual([unknown]);
            expect(refresh).not.toHaveBeenCalled();
          }
          expect(reads).toBe(scenario === 'error' ? 1 : 2);
          expect(bindingPorts.pages.mock.calls[0][1]).toMatchObject({
            cursor: null,
            limit: 100,
            ...(route.kind === 'group' ? { groupChatId: route.groupChatId } : {}),
          });
        } finally {
          act(() => view.unmount());
        }
      }
    } finally {
      vi.unstubAllGlobals();
      resetContextScopedRequestEpochForTests();
    }
  });
});
