import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { describe, expect, it, vi } from 'vitest';

import { useGroupChatComposer } from '../../../src/features/team-group-chats/renderer/hooks/useGroupChatComposer';

const ports = vi.hoisted(() => ({ send: vi.fn(), load: vi.fn(), save: vi.fn() }));
vi.mock('@renderer/api', () => ({ api: { teamGroupChats: { send: ports.send } } }));
vi.mock('@renderer/services/composerDraftRepository', () => ({
  composerDraftRepository: { loadWorking: ports.load, saveWorking: ports.save },
}));

describe('group composer canonical send outcome', () => {
  it('keeps a successful send and clears local text when durable draft cleanup conflicts', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    ports.load.mockImplementation(async (address) => ({
      working: {
        version: 2,
        address,
        workingRevision: 'loaded',
        content: null,
        editorContext: { kind: 'plain' },
        updatedAt: 0,
      },
      status: 'persistent',
    }));
    ports.save.mockImplementation(async (_address, _revision, nextRevision, content) =>
      content === null
        ? { kind: 'conflict', currentWorkingRevision: 'another-window', status: 'persistent' }
        : { kind: 'saved', workingRevision: nextRevision, status: 'persistent' }
    );
    const sent = {
      saved: true,
      groupChatId: 'group-a',
      messageId: 'canonical',
      statusPersisted: true,
    };
    ports.send.mockResolvedValue(sent);
    const refresh = vi.fn(async () => {});
    let composer: ReturnType<typeof useGroupChatComposer> | undefined;
    function Probe() {
      composer = useGroupChatComposer('team-a', 'root-a', 'group-a', refresh, 'Release discussion');
      return null;
    }
    const view = createRoot(document.createElement('div'));
    try {
      await act(async () => {
        view.render(<Probe />);
      });
      expect(composer?.ready).toBe(true);
      act(() => composer!.change('A concrete answer'));
      await act(async () => {
        await composer!.send();
      });
      expect(composer!.result).toEqual(sent);
      expect(composer!.text).toBe('');
      expect(composer!.attemptId).toBeNull();
      expect(composer!.pending).toBe(false);
      expect(composer!.error).toMatch(/^Message saved, but the draft could not be cleared:/);
      expect(ports.send).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(ports.save.mock.calls[0]?.[0].target).toMatchObject({
        kind: 'group',
        groupChatId: 'group-a',
        groupChatName: 'Release discussion',
      });
    } finally {
      act(() => view.unmount());
      vi.unstubAllGlobals();
    }
  });
  it('freezes the selected recipient across an unknown send and restores old pending attempts as All', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let stored: import('../../../src/renderer/types/composerDraft').ComposerDraftContent | null =
      null;
    ports.send.mockReset();
    ports.save.mockReset();
    ports.load.mockImplementation(async (address) => ({
      working: {
        version: 2,
        address,
        workingRevision: 'loaded',
        content: stored,
        editorContext: { kind: 'plain' },
        updatedAt: 0,
      },
      status: 'durable',
    }));
    ports.save.mockImplementation(async (_address, _revision, nextRevision, content) => {
      stored = content;
      return { kind: 'saved', workingRevision: nextRevision, status: 'durable' };
    });
    ports.send.mockRejectedValueOnce(new Error('Connection interrupted'));
    let composer: ReturnType<typeof useGroupChatComposer> | undefined;
    function Probe() {
      composer = useGroupChatComposer(
        'team-a',
        'root-a',
        'group-a',
        async () => {},
        'Discussion',
        'lead'
      );
      return null;
    }
    const view = createRoot(document.createElement('div'));
    try {
      await act(async () => {
        view.render(<Probe key="first" />);
      });
      expect(composer!.recipientName).toBe('lead');
      await act(async () => {
        composer!.change('Selected message');
      });
      await act(async () => {
        composer!.selectRecipient('bob');
      });
      await act(async () => {
        await composer!.send();
      });
      const first = ports.send.mock.calls[0][0];
      expect(first.recipientName).toBe('bob');
      expect(composer!.attemptId).toBe(first.messageId);
      act(() => {
        composer!.selectRecipient('lead');
        composer!.change('Changed');
      });
      expect(composer!.recipientName).toBe('bob');
      expect(composer!.text).toBe('Selected message');
      await act(async () => {
        view.render(<Probe key="recovered" />);
      });
      expect(composer!.recipientName).toBe('bob');
      ports.send.mockResolvedValue({
        saved: true,
        groupChatId: 'group-a',
        messageId: first.messageId,
        statusPersisted: true,
      });
      await act(async () => {
        await composer!.send();
      });
      expect(ports.send.mock.calls[1][0]).toEqual(first);
      stored = {
        text: 'Old pending All',
        chips: [],
        attachments: [],
        actionMode: 'do',
        restoredOrigin: {
          kind: 'unconfirmed-send',
          attemptId: 'old-attempt',
          messageId: 'old-attempt',
        },
      };
      await act(async () => {
        view.render(<Probe key="old-pending" />);
      });
      expect(composer!.recipientName).toBeNull();
      await act(async () => {
        await composer!.send();
      });
      expect(ports.send.mock.calls[2][0]).toMatchObject({
        messageId: 'old-attempt',
        text: 'Old pending All',
      });
      expect(ports.send.mock.calls[2][0]).not.toHaveProperty('recipientName');
    } finally {
      act(() => view.unmount());
      vi.unstubAllGlobals();
    }
  });

  it('allows retargeting a definitively rejected member while preserving text and creating a new identity', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    ports.send.mockReset();
    ports.save.mockReset();
    ports.load.mockImplementation(async (address) => ({
      working: {
        version: 2,
        address,
        workingRevision: 'loaded',
        content: null,
        editorContext: { kind: 'plain' },
        updatedAt: 0,
      },
      status: 'durable',
    }));
    ports.save.mockImplementation(async (_address, _revision, nextRevision) => ({
      kind: 'saved',
      workingRevision: nextRevision,
      status: 'durable',
    }));
    ports.send.mockRejectedValueOnce(
      Object.assign(new Error('Member was removed'), { code: 'invalid-recipient' })
    );
    let composer: ReturnType<typeof useGroupChatComposer> | undefined;
    const renders: { context: string; ready: boolean }[] = [];
    function Probe({ lead = 'lead', context = 'root-a' }: { lead?: string; context?: string }) {
      composer = useGroupChatComposer(
        'team-a',
        context,
        'group-a',
        async () => {},
        'Discussion',
        lead
      );
      renders.push({ context, ready: composer.ready });
      return null;
    }
    const view = createRoot(document.createElement('div'));
    try {
      await act(async () => {
        view.render(<Probe />);
      });
      await act(async () => {
        composer!.change('Keep this draft');
      });
      await act(async () => {
        view.render(<Probe lead="new-lead" />);
      });
      expect(composer!.recipientName).toBe('lead');
      await act(async () => {
        await composer!.send();
      });
      const rejected = ports.send.mock.calls[0][0];
      expect(composer!.attemptId).toBeNull();
      expect(composer!.text).toBe('Keep this draft');
      await act(async () => {
        composer!.selectRecipient('bob');
      });
      ports.send.mockImplementation(async (request) => ({
        saved: true,
        groupChatId: request.groupChatId,
        messageId: request.messageId,
        statusPersisted: true,
      }));
      await act(async () => {
        await composer!.send();
      });
      expect(ports.send.mock.calls[1][0].recipientName).toBe('bob');
      expect(ports.send.mock.calls[1][0].messageId).not.toBe(rejected.messageId);
      await act(async () => {
        composer!.change('Previous context draft');
      });
      await act(async () => {
        view.render(<Probe context="root-b" />);
      });
      expect(renders.find((render) => render.context === 'root-b')?.ready).toBe(false);
      expect(composer!.ready).toBe(true);
      expect(composer!.text).toBe('');
    } finally {
      act(() => view.unmount());
      vi.unstubAllGlobals();
    }
  });
});
