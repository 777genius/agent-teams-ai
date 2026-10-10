import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';

import type { InboxMessage, MessagesPage } from '@shared/types';

const EMPTY_MESSAGES: InboxMessage[] = [];

export function useGroupChatHistory(teamName: string, contextId: string, groupChatId?: string) {
  const identity = JSON.stringify([contextId, teamName, groupChatId ?? '']);
  const [history, setHistory] = useState<{ identity: string; messages: InboxMessage[] }>({
    identity,
    messages: [],
  });
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
          const messages = previous.identity === identity ? previous.messages : EMPTY_MESSAGES;
          const combined = older
            ? [...result.messages, ...messages]
            : [...messages, ...result.messages];
          const unique = new Map(combined.map((message) => [message.messageId, message]));
          return {
            identity,
            messages: [...unique.values()].sort(
              (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)
            ),
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
    [groupChatId, identity, session, teamName]
  );
  useEffect(() => {
    setHistory({ identity, messages: [] });
    setPage(null);
    session.cursor = null;
    session.busy = false;
    void load();
  }, [identity, load, session]);
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
  const isCurrentHistory = history.identity === identity;
  return {
    // Passive effects clear state after render; never expose the previous root's
    // rows to read-backfill or thread consumers during that intervening render.
    messages: isCurrentHistory ? history.messages : EMPTY_MESSAGES,
    hasMore: isCurrentHistory ? (page?.hasMore ?? false) : false,
    loading: isCurrentHistory ? loading : !!groupChatId,
    error: isCurrentHistory ? error : null,
    refresh: () => load(),
    loadOlder: () => load(true),
  };
}
