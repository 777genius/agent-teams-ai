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
});
