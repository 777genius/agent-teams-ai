import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';

import type { InboxMessage, MessagesPage } from '@shared/types';

const EMPTY_MESSAGES: InboxMessage[] = [];

export function useGroupChatHistory(teamName: string, contextId: string, groupChatId?: string) {
  const identity = JSON.stringify([contextId, teamName, groupChatId ?? '']);
  const rootIdentity = JSON.stringify([contextId, teamName]);
  const [history, setHistory] = useState<{
    rootIdentity: string;
    groups: Record<string, InboxMessage[]>;
  }>({ rootIdentity, groups: {} });
  const [activeIdentity, setActiveIdentity] = useState(identity);
  const [page, setPage] = useState<MessagesPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(identity);
  current.current = identity;
  const session = useMemo(
    () => ({ identity, cursor: null as MessagesPage['nextCursor'], busy: false }),
    [identity]
  );
  const load = useCallback(
    async (older = false) => {
      if (!groupChatId || session.busy) return;
      session.busy = true;
      setLoading(true);
      try {
        const result = await api.teams.getMessagesPage(teamName, {
          groupChatId,
          limit: 100,
          ...(older && session.cursor ? { cursor: session.cursor } : {}),
        });
        if (current.current !== identity) return;
        setHistory((previous) => {
          const groups = previous.rootIdentity === rootIdentity ? previous.groups : {};
          const messages = groups[groupChatId] ?? EMPTY_MESSAGES;
          const combined = older
            ? [...result.messages, ...messages]
            : [...messages, ...result.messages];
          const unique = new Map(combined.map((message) => [message.messageId, message]));
          return {
            rootIdentity,
            groups: {
              ...groups,
              [groupChatId]: [...unique.values()].sort(
                (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)
              ),
            },
          };
        });
        if (older || !session.cursor) {
          session.cursor = result.nextCursor;
          setPage(result);
        }
        setError(null);
      } catch (cause) {
        if (current.current === identity)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        session.busy = false;
        if (current.current === identity) setLoading(false);
      }
    },
    [groupChatId, identity, rootIdentity, session, teamName]
  );
  useEffect(() => {
    setHistory((previous) =>
      previous.rootIdentity === rootIdentity ? previous : { rootIdentity, groups: {} }
    );
    setActiveIdentity(identity);
    setError(null);
    setPage(null);
    session.cursor = null;
    session.busy = false;
    void load();
  }, [identity, load, rootIdentity, session]);
  useEffect(() => {
    if (!groupChatId) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [groupChatId, load]);
  useEffect(
    () =>
      api.teams.onTeamChange?.((_event, change) => {
        if (groupChatId && change.teamName === teamName && change.type === 'inbox') void load();
      }),
    [groupChatId, load, teamName]
  );
  const isCurrentHistory = history.rootIdentity === rootIdentity;
  const knownMessages = useMemo(
    () => (isCurrentHistory ? Object.values(history.groups).flat() : EMPTY_MESSAGES),
    [history, isCurrentHistory]
  );
  return {
    // Passive effects clear state after render; never expose the previous root's
    // rows to read-backfill or thread consumers during that intervening render.
    messages:
      isCurrentHistory && groupChatId
        ? (history.groups[groupChatId] ?? EMPTY_MESSAGES)
        : EMPTY_MESSAGES,
    knownMessages,
    hasMore: activeIdentity === identity ? (page?.hasMore ?? false) : false,
    loading: activeIdentity === identity ? loading : !!groupChatId,
    error: activeIdentity === identity ? error : null,
    refresh: () => load(),
    loadOlder: () => load(true),
  };
}
