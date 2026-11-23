import { useCallback } from 'react';

import { useStore } from '@renderer/store';

import { useAttentionInbox } from '../hooks/useAttentionInbox';
import { requestAttentionChatNavigation } from '../hooks/conversationAttentionNavigation';

import { AttentionInboxPanel } from './AttentionInboxPanel';

import type { AttentionChat } from '../../core/domain/buildAttention';
import type { AttentionTaskCandidate } from '../../contracts';
import type { ConversationScope } from '@features/team-direct-chats/renderer';

export function AttentionInboxView({ variant = 'full' }: {
  variant?: 'compact' | 'full';
}): React.JSX.Element {
  const { model, loading, error, refresh } = useAttentionInbox();
  const contextId = useStore((state) => state.activeContextId);
  const openTeamTab = useStore((state) => state.openTeamTab);
  const openGlobalTaskDetail = useStore((state) => state.openGlobalTaskDetail);
  const openTab = useStore((state) => state.openTab);
  const onOpenTask = useCallback((task: AttentionTaskCandidate) => {
    openGlobalTaskDetail(task.teamName, task.taskId);
  }, [openGlobalTaskDetail]);
  const onOpenChat = useCallback((chat: AttentionChat, scope: ConversationScope) => {
    requestAttentionChatNavigation({ contextId, teamName: chat.teamName, scope });
    openTeamTab(chat.teamName);
  }, [contextId, openTeamTab]);
  const onOpenFull = useCallback(() => {
    const state = useStore.getState();
    const pane = state.paneLayout.panes.find((p) => p.id === state.paneLayout.focusedPaneId);
    const existing = pane?.tabs.find((tab) => tab.type === 'attention');
    if (existing) state.setActiveTab(existing.id);
    else openTab({ type: 'attention', label: 'Attention' });
  }, [openTab]);
  return (
    <div className={variant === 'compact' ? 'mb-6' : 'flex-1 overflow-auto bg-surface px-6 py-8'}>
      <div className={variant === 'compact' ? undefined : 'mx-auto max-w-5xl'}>
        <AttentionInboxPanel
          variant={variant}
          model={model}
          loading={loading}
          error={error}
          onRetry={refresh}
          onOpenTask={onOpenTask}
          onOpenChat={onOpenChat}
          onOpenFull={variant === 'compact' ? onOpenFull : undefined}
        />
      </div>
    </div>
  );
}
