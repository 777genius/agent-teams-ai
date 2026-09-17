import { useEffect, useMemo, useRef, useState } from 'react';

import {
  buildChatListView,
  type ChatListViewItem,
  type ConversationScope,
  conversationScopeKey,
  type ConversationSurface,
  TEAM_DIRECT_CHAT_AUTO_OLDER_PAGE_CAP,
} from '@features/team-direct-chats/renderer';
import { toMessageKey } from '@renderer/utils/teamMessageKey';

import { collectThreadUnreadSnapshotKeys } from './messagesPanelConversations';

import type { InboxMessage, ResolvedTeamMember } from '@shared/types';

export function useTeamChatListItems(args: {
  members: readonly ResolvedTeamMember[];
  messages: readonly InboxMessage[];
  readSet: ReadonlySet<string>;
  teamFeedLabel: string;
  emptyPreview: string;
  leadNames: Iterable<string>;
  sortByActivity?: boolean;
  enabled?: boolean;
}): ChatListViewItem[] {
  return useMemo(
    () =>
      args.enabled === false
        ? []
        : buildChatListView({
            members: args.members,
            messages: args.messages,
            readSet: args.readSet,
            toKey: toMessageKey,
            teamFeedLabel: args.teamFeedLabel,
            emptyPreview: args.emptyPreview,
            leadNames: args.leadNames,
            sortByActivity: args.sortByActivity,
          }),
    [
      args.emptyPreview,
      args.enabled,
      args.leadNames,
      args.members,
      args.messages,
      args.readSet,
      args.sortByActivity,
      args.teamFeedLabel,
    ]
  );
}

export function useDirectThreadAutoOlder({
  renderSurface,
  scope,
  threadOpenedAt,
  scopedCount,
  hasMore,
  loadingOlder,
  loadOlder,
}: {
  renderSurface: ConversationSurface;
  scope: ConversationScope;
  threadOpenedAt: number;
  scopedCount: number;
  hasMore: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<void>;
}): void {
  const pagesRef = useRef(0);
  useEffect(() => {
    pagesRef.current = 0;
  }, [threadOpenedAt, scope]);
  useEffect(() => {
    if (renderSurface !== 'thread' || scope.kind !== 'direct') return;
    if (scopedCount > 0 || !hasMore || loadingOlder) return;
    if (pagesRef.current >= TEAM_DIRECT_CHAT_AUTO_OLDER_PAGE_CAP) return;
    pagesRef.current += 1;
    void loadOlder();
  }, [hasMore, loadOlder, loadingOlder, renderSurface, scope, scopedCount]);
}

export function useThreadUnreadSnapshot({
  renderSurface,
  scope,
  threadOpenedAt,
  messages,
  readSet,
}: {
  renderSurface: ConversationSurface;
  scope: ConversationScope;
  threadOpenedAt: number;
  messages: readonly InboxMessage[];
  readSet: ReadonlySet<string>;
}): ReadonlySet<string> {
  const visitKey = `${renderSurface}:${conversationScopeKey(scope)}:${threadOpenedAt}`;
  const visitKeyRef = useRef(visitKey);
  const readAtOpenRef = useRef(readSet);
  const [snapshot, setSnapshot] = useState<Set<string>>(() => new Set());
  const lastVisitRef = useRef(visitKey);

  if (visitKeyRef.current !== visitKey) {
    visitKeyRef.current = visitKey;
    readAtOpenRef.current = readSet;
  }

  useEffect(() => {
    if (renderSurface !== 'thread') {
      setSnapshot(new Set());
      return;
    }
    const visitChanged = lastVisitRef.current !== visitKey;
    lastVisitRef.current = visitKey;
    setSnapshot((prev) => {
      const next = collectThreadUnreadSnapshotKeys({
        messages,
        readSetAtOpen: readAtOpenRef.current,
        toKey: toMessageKey,
        openedAt: threadOpenedAt,
        existing: visitChanged ? undefined : prev,
      });
      if (!visitChanged && next.size === prev.size && [...next].every((key) => prev.has(key))) {
        return prev;
      }
      return next;
    });
  }, [messages, renderSurface, threadOpenedAt, visitKey]);

  return snapshot;
}

export function useResetScrollOnConversationChange({
  teamName,
  scopeKey,
  navigationSurface,
  persistScrollTop,
  scrollElementRef,
}: {
  teamName: string;
  scopeKey: string;
  navigationSurface: ConversationSurface;
  persistScrollTop: (nextScrollTop: number) => void;
  scrollElementRef: { current: HTMLElement | null };
}): void {
  const conversationKey = `${scopeKey}:${navigationSurface}`;
  const lastTeamRef = useRef(teamName);
  const lastConversationRef = useRef(conversationKey);
  useEffect(() => {
    if (lastTeamRef.current !== teamName) {
      lastTeamRef.current = teamName;
      lastConversationRef.current = conversationKey;
      return;
    }
    if (lastConversationRef.current === conversationKey) {
      return;
    }
    lastConversationRef.current = conversationKey;
    persistScrollTop(0);
    if (scrollElementRef.current) scrollElementRef.current.scrollTop = 0;
  }, [conversationKey, persistScrollTop, scrollElementRef, teamName]);
}
