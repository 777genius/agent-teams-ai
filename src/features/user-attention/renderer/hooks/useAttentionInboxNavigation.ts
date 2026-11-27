import { useCallback } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import {
  getTeamMessagesSidebarUiState,
  setTeamMessagesSidebarUiState,
} from '@renderer/components/team/sidebar/teamSidebarUiState';
import { useStore } from '@renderer/store';

import { requestAttentionChatNavigation } from './conversationAttentionNavigation';

import type { AttentionTaskCandidate } from '../../contracts';
import type { AttentionChat } from '../../core/domain/buildAttention';
import type { ConversationScope } from '@features/team-direct-chats/renderer';

/** The only app-shell navigation adapter; attention UI stays presentation-only. */
export function useAttentionInboxNavigation() {
  const { t } = useAppTranslation('common');
  const contextId = useStore((state) => state.activeContextId);
  const openTeamTab = useStore((state) => state.openTeamTab);
  const openGlobalTaskDetail = useStore((state) => state.openGlobalTaskDetail);
  const openTab = useStore((state) => state.openTab);

  const onOpenTask = useCallback((task: AttentionTaskCandidate) => {
    if (task.logicalTeamName) openTeamTab(task.logicalTeamName, task.projectPath);
    openGlobalTaskDetail(task.teamName, task.taskId);
  }, [openGlobalTaskDetail, openTeamTab]);

  const onOpenChat = useCallback((chat: AttentionChat, scope: ConversationScope) => {
    // ProjectScopedTeamDetailView opens a logical tab, but its ready project
    // mounts MessagesPanel for the *physical* execution team. Match that panel,
    // not its logical parent, otherwise the requested conversation is lost.
    // Preload the physical team's *existing* sidebar state before the logical
    // tab can mount it. Otherwise initial hydration may persist the old
    // collapsed view after the one-shot navigation intent was consumed.
    const sidebarKey = JSON.stringify([contextId, chat.teamName]);
    const previous = getTeamMessagesSidebarUiState(sidebarKey);
    setTeamMessagesSidebarUiState(sidebarKey, {
      ...previous,
      messagesFilter: { ...previous.messagesFilter, from: new Set(), to: new Set() },
      messagesCollapsed: false,
      messagesSearchQuery: '',
      conversationSurface: 'thread',
      conversationScope: scope,
    });
    openTeamTab(chat.logicalTeamName || chat.teamName, chat.projectPath);
    // Still needed when the MessagesPanel is already mounted.
    requestAttentionChatNavigation({ contextId, teamName: chat.teamName, scope });
  }, [contextId, openTeamTab]);

  const onOpenFull = useCallback(() => {
    const state = useStore.getState();
    const pane = state.paneLayout.panes.find((p) => p.id === state.paneLayout.focusedPaneId);
    const existing = pane?.tabs.find((tab) => tab.type === 'attention');
    if (existing) state.setActiveTab(existing.id);
    else openTab({ type: 'attention', label: t('attention.tab') });
  }, [openTab, t]);

  return { onOpenTask, onOpenChat, onOpenFull };
}
