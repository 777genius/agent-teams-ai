import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useTeamConversationSurface } from '@features/team-direct-chats/renderer/hooks/useTeamConversationSurface';
import { useDirectThreadAutoOlder } from '@renderer/components/team/messages/useMessagesPanelChats';
import {
  createDefaultMessagesSidebarUiState,
  setTeamMessagesSidebarUiState,
} from '@renderer/components/team/sidebar/teamSidebarUiState';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConversationScope, ConversationSurface } from '@features/team-direct-chats/renderer';
import type { TeamConversationSurfaceState } from '@features/team-direct-chats/renderer/hooks/useTeamConversationSurface';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useTeamConversationSurface', () => {
  it('keeps floating-composer on the thread surface without a chat list', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const latest: { current: TeamConversationSurfaceState | null } = { current: null };

    function Probe(): React.JSX.Element {
      latest.current = useTeamConversationSurface({
        teamName: 'probe',
        members: [{ name: 'oscar' }],
        position: 'floating-composer',
      });
      return React.createElement('span', null, latest.current.renderSurface);
    }

    await act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });

    expect(latest.current?.renderSurface).toBe('thread');
    expect(latest.current?.navigationSurface).toBe('list');
    expect(host.textContent).toBe('thread');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('returns a stale direct member to the chat list', async () => {
    setTeamMessagesSidebarUiState('probe-stale', {
      ...createDefaultMessagesSidebarUiState(),
      conversationSurface: 'thread',
      conversationScope: { kind: 'direct', participant: 'alice' },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const latest: { current: TeamConversationSurfaceState | null } = { current: null };

    function Probe(): React.JSX.Element {
      latest.current = useTeamConversationSurface({
        teamName: 'probe-stale',
        members: [{ name: 'oscar' }],
        position: 'sidebar',
      });
      return React.createElement('span', null, latest.current.renderSurface);
    }

    await act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });

    expect(latest.current?.renderSurface).toBe('list');
    expect(latest.current?.scope).toEqual({ kind: 'team-feed' });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('restores the destination team thread instead of bouncing the previous DM', async () => {
    setTeamMessagesSidebarUiState('team-a', {
      ...createDefaultMessagesSidebarUiState(),
      conversationSurface: 'thread',
      conversationScope: { kind: 'direct', participant: 'alice' },
    });
    setTeamMessagesSidebarUiState('team-b', {
      ...createDefaultMessagesSidebarUiState(),
      conversationSurface: 'thread',
      conversationScope: { kind: 'direct', participant: 'oscar' },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const latest: { current: TeamConversationSurfaceState | null } = { current: null };

    function Probe({
      teamName,
      members,
    }: {
      teamName: string;
      members: readonly { name: string; agentType?: string }[];
    }): React.JSX.Element {
      latest.current = useTeamConversationSurface({
        teamName,
        members,
        position: 'sidebar',
      });
      return React.createElement('span', null, latest.current.renderSurface);
    }

    await act(async () => {
      root.render(
        React.createElement(Probe, {
          teamName: 'team-a',
          members: [{ name: 'alice' }],
        })
      );
      await Promise.resolve();
    });
    expect(latest.current?.scope).toEqual({ kind: 'direct', participant: 'alice' });

    await act(async () => {
      root.render(
        React.createElement(Probe, {
          teamName: 'team-b',
          members: [{ name: 'oscar', agentType: 'team-lead' }],
        })
      );
      await Promise.resolve();
    });

    expect(latest.current?.renderSurface).toBe('thread');
    expect(latest.current?.scope).toEqual({ kind: 'direct', participant: 'oscar' });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps a persisted thread while the roster is still empty', async () => {
    setTeamMessagesSidebarUiState('probe-empty-roster', {
      ...createDefaultMessagesSidebarUiState(),
      conversationSurface: 'thread',
      conversationScope: { kind: 'direct', participant: 'alice' },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const latest: { current: TeamConversationSurfaceState | null } = { current: null };

    function Probe(): React.JSX.Element {
      latest.current = useTeamConversationSurface({
        teamName: 'probe-empty-roster',
        members: [],
        position: 'sidebar',
      });
      return React.createElement('span', null, latest.current.renderSurface);
    }

    await act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });

    expect(latest.current?.renderSurface).toBe('thread');
    expect(latest.current?.scope).toEqual({ kind: 'direct', participant: 'alice' });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps a lead-alias thread when the roster lead uses a different name', async () => {
    setTeamMessagesSidebarUiState('probe-lead-alias', {
      ...createDefaultMessagesSidebarUiState(),
      conversationSurface: 'thread',
      conversationScope: { kind: 'direct', participant: 'team-lead' },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const latest: { current: TeamConversationSurfaceState | null } = { current: null };

    function Probe(): React.JSX.Element {
      latest.current = useTeamConversationSurface({
        teamName: 'probe-lead-alias',
        members: [{ name: 'oscar', agentType: 'team-lead' }, { name: 'alice' }],
        position: 'sidebar',
      });
      return React.createElement('span', null, latest.current.renderSurface);
    }

    await act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });

    expect(latest.current?.renderSurface).toBe('thread');
    expect(latest.current?.scope).toEqual({ kind: 'direct', participant: 'team-lead' });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});

describe('useDirectThreadAutoOlder', () => {
  it('stops after eight empty-page fetches', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const loadOlder = vi.fn(async () => undefined);
    const scope: ConversationScope = { kind: 'direct', participant: 'alice' };

    function Probe({
      loadingOlder,
      renderSurface = 'thread',
    }: {
      loadingOlder: boolean;
      renderSurface?: ConversationSurface;
    }): null {
      useDirectThreadAutoOlder({
        renderSurface,
        scope,
        threadOpenedAt: 1,
        scopedCount: 0,
        hasMore: true,
        loadingOlder,
        loadOlder,
      });
      return null;
    }

    await act(async () => {
      root.render(React.createElement(Probe, { loadingOlder: false }));
      await Promise.resolve();
    });
    expect(loadOlder).toHaveBeenCalledTimes(1);

    for (let page = 1; page < 8; page += 1) {
      await act(async () => {
        root.render(React.createElement(Probe, { loadingOlder: true }));
        await Promise.resolve();
      });
      await act(async () => {
        root.render(React.createElement(Probe, { loadingOlder: false }));
        await Promise.resolve();
      });
    }
    expect(loadOlder).toHaveBeenCalledTimes(8);

    await act(async () => {
      root.render(React.createElement(Probe, { loadingOlder: true }));
      await Promise.resolve();
    });
    await act(async () => {
      root.render(React.createElement(Probe, { loadingOlder: false }));
      await Promise.resolve();
    });
    expect(loadOlder).toHaveBeenCalledTimes(8);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
