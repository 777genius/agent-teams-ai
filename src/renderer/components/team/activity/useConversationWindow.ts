import { useLayoutEffect, useMemo, useState } from 'react';

import { toMessageKey } from '@renderer/utils/teamMessageKey';

import {
  calculateConversationWindow,
  classifyConversationHead,
  CONVERSATION_PAGE_SIZE,
} from './conversationWindow';

import type { InboxMessage } from '@shared/types';

export function useConversationWindow(
  messages: InboxMessage[],
  identity: string,
  enabled: boolean
) {
  const [requested, setRequested] = useState({ identity, count: CONVERSATION_PAGE_SIZE });
  const [committed, setCommitted] = useState<{
    identity: string;
    messages: InboxMessage[];
    visibleKeys: Set<string>;
    keys: Set<string>;
    freshKeys: Set<string>;
  } | null>(null);
  const previous = committed?.identity === identity ? committed : null;
  const window = useMemo(
    () =>
      calculateConversationWindow(
        messages,
        requested.identity === identity ? requested.count : CONVERSATION_PAGE_SIZE,
        enabled ? previous?.visibleKeys : undefined
      ),
    [messages, requested, identity, enabled, previous?.visibleKeys]
  );
  const freshKeys =
    previous?.messages === messages
      ? previous.freshKeys
      : classifyConversationHead(messages, enabled ? previous?.keys : undefined);
  useLayoutEffect(() => {
    if (!enabled) return;
    if (window.reset) setRequested({ identity, count: CONVERSATION_PAGE_SIZE });
    const visibleKeys = new Set(window.visibleMessages.map(toMessageKey));
    if (
      previous?.messages === messages &&
      previous.visibleKeys.size === visibleKeys.size &&
      [...visibleKeys].every((key) => previous.visibleKeys.has(key))
    )
      return;
    setCommitted({
      identity,
      messages,
      visibleKeys,
      keys: new Set(messages.map(toMessageKey)),
      freshKeys,
    });
  }, [enabled, identity, messages, previous, window.visibleMessages, window.reset, freshKeys]);
  return {
    ...window,
    freshKeys,
    showMore: () => setRequested({ identity, count: window.budget + CONVERSATION_PAGE_SIZE }),
    showAll: () => setRequested({ identity, count: Infinity }),
  };
}
