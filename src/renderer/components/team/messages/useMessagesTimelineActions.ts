import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useStore } from '@renderer/store';
import { sameMessageActionOwner } from '@renderer/types/messageTaskSeed';

import { resolveExpandedTimelineItem } from './messagesPanelDerivedData';
import { resolveReplyRecipient } from './messagesPanelReplyRecipient';

import type { ConversationScope } from '@features/team-direct-chats/renderer';
import type { MessageActionOwner, MessageTaskSeed } from '@renderer/types/messageTaskSeed';
import type { InboxMessage, ResolvedTeamMember } from '@shared/types';

interface MessagesTimelineActionsInput {
  contextId: string;
  teamName: string;
  scopeKey: string;
  scope: ConversationScope;
  members: ResolvedTeamMember[];
  messages: InboxMessage[];
  expandedItemKey: string | null;
  setExpandedItemKey: (key: string | null) => void;
  onCreateTask?: (seed: MessageTaskSeed) => void;
  onReply?: (message: InboxMessage, recipientHint?: string) => void;
  groupId?: string;
  groupQuote?: (message: InboxMessage) => void;
  onRevise: (message: InboxMessage) => void;
}

/** Own the rendered/opened message identity, independently of refreshed message data. */
export function useMessagesTimelineActions({
  contextId,
  teamName,
  scopeKey,
  scope,
  members,
  messages,
  expandedItemKey,
  setExpandedItemKey,
  onCreateTask,
  onReply,
  groupId,
  groupQuote,
  onRevise,
}: MessagesTimelineActionsInput) {
  const actionOwner = useMemo(
    () => ({ contextId, teamName, scopeKey }),
    [contextId, teamName, scopeKey]
  );
  const currentOwnerRef = useRef(actionOwner);
  currentOwnerRef.current = actionOwner;
  const [expandedOwner, setExpandedOwner] = useState<MessageActionOwner | null>(
    expandedItemKey ? actionOwner : null
  );
  const isCurrentOwner = useCallback(
    () =>
      sameMessageActionOwner(actionOwner, currentOwnerRef.current) &&
      useStore.getState().activeContextId === contextId,
    [actionOwner, contextId]
  );
  const createTask = useCallback(
    (seed: MessageTaskSeed) => {
      if (isCurrentOwner() && seed.source.teamName === teamName) onCreateTask?.(seed);
    },
    [isCurrentOwner, onCreateTask, teamName]
  );
  const reply = useCallback(
    (message: InboxMessage) => {
      if (!isCurrentOwner()) return;
      if (groupId) groupQuote?.(message);
      else onReply?.(message, resolveReplyRecipient({ message, scope, teamName, members }));
    },
    [groupId, groupQuote, isCurrentOwner, members, onReply, scope, teamName]
  );
  const revise = useCallback(
    (message: InboxMessage) => {
      if (isCurrentOwner()) onRevise(message);
    },
    [isCurrentOwner, onRevise]
  );
  const expandedItem = useMemo(
    () => resolveExpandedTimelineItem(expandedItemKey, messages),
    [expandedItemKey, messages]
  );
  useEffect(() => {
    if (
      expandedItemKey &&
      (expandedItem === null || !sameMessageActionOwner(expandedOwner, actionOwner))
    ) {
      setExpandedItemKey(null);
    }
  }, [actionOwner, expandedItem, expandedItemKey, expandedOwner, setExpandedItemKey]);
  const expand = useCallback(
    (key: string) => {
      if (!isCurrentOwner()) return;
      setExpandedOwner(actionOwner);
      setExpandedItemKey(key);
    },
    [actionOwner, isCurrentOwner, setExpandedItemKey]
  );
  const closeExpand = useCallback(
    (open: boolean) => {
      if (!open) setExpandedItemKey(null);
    },
    [setExpandedItemKey]
  );
  return {
    actionOwner,
    expandedOwner,
    expandedItem,
    expand,
    closeExpand,
    createTask: onCreateTask ? createTask : undefined,
    reply: (groupId ? groupQuote : onReply) ? reply : undefined,
    revise: groupId ? undefined : revise,
  };
}
