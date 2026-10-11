import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { describe, expect, it, vi } from 'vitest';

import { IndexedDbQueueRepository } from '../../../src/features/manual-message-queue/renderer/adapters/queueRepository';
import { useDirectMessageQueue } from '../../../src/features/manual-message-queue/renderer/hooks/useDirectMessageQueue';
import { useGroupMessageQueue } from '../../../src/features/manual-message-queue/renderer/hooks/useGroupMessageQueue';
import { useComposerDraft } from '../../../src/renderer/hooks/useComposerDraft';
import { composerDraftRepository } from '../../../src/renderer/services/composerDraftRepository';

import { clearStore, scope } from './queueFixture';

import type { QueueItem } from '../../../src/features/manual-message-queue/core/domain/queue';
import type { ManualQueueOptions } from '../../../src/features/manual-message-queue/renderer/hooks/useManualMessageQueue';
import type { ResolvedTeamMember } from '../../../src/shared/types';

const ports = vi.hoisted(() => ({
  options: null as ManualQueueOptions | null,
  sendGroup: vi.fn(),
}));
vi.mock('../../../src/features/manual-message-queue/renderer/hooks/useManualMessageQueue', () => ({
  useManualMessageQueue: (options: ManualQueueOptions) => {
    ports.options = options;
    return { ...options, list: 'local queue' };
  },
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/hooks/useTaskSuggestions', () => ({ getTaskSuggestionsForTeamNow: () => [] }));
vi.mock('@renderer/store', () => ({
  useStore: { getState: () => ({ refreshTeamData: async () => {} }) },
}));
vi.mock('@renderer/api', () => ({ api: { teamGroupChats: { send: ports.sendGroup } } }));

describe('composer queue adapters', () => {
  it('queues the captured ask text while concurrent typing remains a durable working draft, then uses the existing direct transport', async () => {
    await clearStore();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let draft!: ReturnType<typeof useComposerDraft>;
    let queue!: ReturnType<typeof useDirectMessageQueue>;
    let isCrossTeam = false;
    const address = {
      contextId: scope.contextId,
      teamName: scope.teamName,
      target: { kind: 'direct' as const, participant: 'bob' },
    };
    const onSend = vi.fn(async () => ({ deliveredToInbox: true, messageId: 'canonical-direct' }));
    const members = [{ name: 'Bob', agentId: 'bob-1' }] as ResolvedTeamMember[];
    function Probe() {
      draft = useComposerDraft(address);
      queue = useDirectMessageQueue({
        teamName: scope.teamName,
        recipient: 'bob',
        members,
        draft,
        onSend,
        disabled: false,
        isCrossTeam,
      });
      return queue.list;
    }
    const host = document.createElement('div');
    const view = createRoot(host);
    try {
      await act(async () => {
        view.render(<Probe />);
      });
      act(() => draft.setActionMode('delegate'));
      expect(queue.unavailableReason).toBeUndefined();
      expect(ports.options!.unavailableReason).toContain('richUnsupported');
      act(() => draft.setText('Unsupported delegate request'));
      expect(queue.unavailableReason).toContain('richUnsupported');
      act(() => {
        draft.setText('Captured request');
        draft.setActionMode('ask');
      });
      await act(async () => {
        await draft.flush();
      });
      const options = ports.options!;
      const repository = new IndexedDbQueueRepository();
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let consumption!: Promise<void>;
      await act(async () => {
        consumption = options.consume(async (working) => {
          entered();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return repository.enqueue(scope, options.route, working, () => true);
        });
        await started;
      });
      act(() => draft.setText('Next working message'));
      await act(async () => {
        release();
        await consumption;
      });
      expect(draft.text).toBe('Next working message');
      await act(async () => {
        await draft.flush();
      });
      await act(async () => {
        expect((await composerDraftRepository.loadWorking(address)).working.content?.text).toBe(
          'Next working message'
        );
      });
      const [row] = await repository.list(scope, () => false);
      expect(row.text).toBe('Captured request');
      expect(row.actionMode).toBe('ask');
      const localWorking = (await composerDraftRepository.loadWorking(address)).working;
      expect(host.textContent).toBe('local queue');
      isCrossTeam = true;
      act(() => view.render(<Probe />));
      expect(queue.list).toBeNull();
      expect(host.textContent).toBe('');
      expect(ports.options!.unavailableReason).toContain('richUnsupported');
      expect(ports.options!.blockedReason(row)).toContain('queueDisabled');
      expect(await repository.list(scope, () => false)).toEqual([row]);
      expect(draft.text).toBe('Next working message');
      await act(async () => {
        expect((await composerDraftRepository.loadWorking(address)).working).toEqual(localWorking);
      });
      isCrossTeam = false;
      act(() => view.render(<Probe />));
      expect(queue.list).toBe('local queue');
      expect(host.textContent).toBe('local queue');
      expect(await repository.list(scope, () => false)).toEqual([row]);
      await act(async () => {
        expect((await composerDraftRepository.loadWorking(address)).working).toEqual(localWorking);
      });
      const request = options.prepare(row, crypto.randomUUID());
      expect(request).toMatchObject({ member: 'Bob' });
      members[0].name = 'BOB';
      await options.transport(row, request);
      expect(onSend).toHaveBeenCalledWith(
        'Bob',
        'Captured request',
        'Captured request',
        undefined,
        'ask',
        [],
        request.messageId
      );
      expect(request.messageId).not.toBe(row.queueItemId);
      expect(
        options.blockedReason({
          ...row,
          route: { kind: 'direct', participant: 'bob', agentId: 'replaced' },
        })
      ).toContain('recipientUnavailable');
    } finally {
      act(() => view.unmount());
      vi.unstubAllGlobals();
    }
  });
  it('always uses the canonical group API with the saved recipient, including standard All', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const composer = {
      text: 'Draft',
      recipientName: 'alice',
      ready: true,
      pending: false,
      attemptId: null,
      consumeForQueue: vi.fn(),
    } as never;
    function Probe() {
      useGroupMessageQueue({
        teamName: scope.teamName,
        groupChatId: 'custom',
        composer,
        fallbackCanSend: true,
        refresh: async () => {},
      });
      return null;
    }
    const view = createRoot(document.createElement('div'));
    try {
      act(() => view.render(<Probe />));
      const options = ports.options!;
      const row = {
        text: 'Captured group message',
        scope,
        actionMode: 'do',
        route: { kind: 'group', groupChatId: 'custom', recipientName: 'bob' },
      } as QueueItem;
      const request = options.prepare(row, crypto.randomUUID());
      await options.transport(row, request);
      expect(ports.sendGroup).toHaveBeenLastCalledWith({
        teamName: scope.teamName,
        groupChatId: 'custom',
        recipientName: 'bob',
        messageId: request.messageId,
        text: row.text,
        taskRefs: [],
      });
      await options.transport(
        { ...row, route: { kind: 'group', groupChatId: 'default', recipientName: null } },
        request
      );
      expect(ports.sendGroup).toHaveBeenLastCalledWith({
        teamName: scope.teamName,
        groupChatId: 'default',
        messageId: request.messageId,
        text: row.text,
        taskRefs: [],
      });
    } finally {
      act(() => view.unmount());
      vi.unstubAllGlobals();
    }
  });
});
