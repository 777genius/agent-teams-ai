import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useAttentionConversationNavigation } from '../../../../src/features/user-attention/renderer/hooks/conversationAttentionNavigation';
import { useAttentionInboxNavigation } from '../../../../src/features/user-attention/renderer/hooks/useAttentionInboxNavigation';
import {
  getTeamMessagesSidebarUiState,
  setTeamMessagesSidebarUiState,
} from '../../../../src/renderer/components/team/sidebar/teamSidebarUiState';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AttentionChat } from '../../../../src/features/user-attention/core/domain/buildAttention';

const state = vi.hoisted(() => ({
  activeContextId: 'attention-navigation-context',
  openTeamTab: vi.fn(),
  openGlobalTaskDetail: vi.fn(),
  openTab: vi.fn(),
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/store', () => ({
  useStore: Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state }
  ),
}));

const physicalName = 'attention-physical-project-b-preload';
const scope = { kind: 'direct' as const, participant: 'alice' };
const chat: AttentionChat = {
  teamName: physicalName,
  logicalTeamName: 'attention-logical',
  projectPath: '/projects/b',
  teamDisplayName: 'History fixture',
  name: 'alice',
  scope,
  unreadCount: 1,
  latestUnread: {
    from: 'alice',
    to: 'user',
    text: 'Project B asks for input',
    timestamp: '2026-11-23T12:00:00.000Z',
    read: false,
    messageId: 'attention-preload-b',
  },
};

function OpenChatButton(): React.JSX.Element {
  const { onOpenChat } = useAttentionInboxNavigation();
  return <button type="button" onClick={() => onOpenChat(chat, scope)}>Open B</button>;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Attention logical-to-physical sidebar navigation', () => {
  it('preloads the target before mounting its project tab and retains a late-mount intent', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const contextKey = JSON.stringify([state.activeContextId, physicalName]);
    const otherKey = JSON.stringify(['other-root', physicalName]);
    const old = {
      ...getTeamMessagesSidebarUiState(contextKey),
      messagesFilter: { from: new Set(['bob']), to: new Set(['other']), showNoise: true },
    };
    setTeamMessagesSidebarUiState(contextKey, {
      ...old,
      messagesCollapsed: true,
      messagesSearchQuery: 'stale search',
      conversationSurface: 'list',
      conversationScope: { kind: 'team-feed' },
    });
    setTeamMessagesSidebarUiState(otherKey, {
      ...old,
      messagesCollapsed: true,
      conversationSurface: 'list',
      conversationScope: { kind: 'team-feed' },
    });

    const beforeTabSwitch = vi.fn(() => getTeamMessagesSidebarUiState(contextKey));
    state.openTeamTab.mockImplementation(beforeTabSwitch);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<OpenChatButton />));
      await act(async () => {
        (host.querySelector('button') as HTMLButtonElement).click();
      });
      expect(state.openTeamTab).toHaveBeenCalledWith('attention-logical', '/projects/b');
      expect(beforeTabSwitch).toHaveReturnedWith(expect.objectContaining({
        messagesCollapsed: false,
        messagesSearchQuery: '',
        messagesFilter: { from: new Set(), to: new Set(), showNoise: true },
        conversationSurface: 'thread',
        conversationScope: scope,
      }));
      expect(getTeamMessagesSidebarUiState(otherKey).messagesCollapsed).toBe(true);
      expect(getTeamMessagesSidebarUiState(otherKey).conversationSurface).toBe('list');
      expect(getTeamMessagesSidebarUiState(otherKey).messagesFilter).toEqual(old.messagesFilter);

      const opened = vi.fn();
      function MountedLater(): React.JSX.Element {
        useAttentionConversationNavigation(state.activeContextId, physicalName, opened);
        return <div data-testid="mounted-project-b" />;
      }
      await act(async () => root.render(<MountedLater />));
      expect(opened).toHaveBeenCalledOnce();
      expect(opened).toHaveBeenCalledWith(scope);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
