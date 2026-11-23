import { useEffect } from 'react';

import type { ConversationScope } from '@features/team-direct-chats/renderer';

interface NavigationIntent {
  contextId: string;
  teamName: string;
  scope: ConversationScope;
  nonce: number;
}

let latest: NavigationIntent | null = null;
let nextNonce = 0;
const subscribers = new Set<(intent: NavigationIntent) => void>();

export function requestAttentionChatNavigation(input: Omit<NavigationIntent, 'nonce'>): void {
  latest = { ...input, nonce: ++nextNonce };
  for (const subscriber of subscribers) subscriber(latest);
}

/** Pending intent also reaches team panels mounted *after* opening the tab. */
export function useAttentionConversationNavigation(
  contextId: string,
  teamName: string,
  open: (scope: ConversationScope) => void
): void {
  useEffect(() => {
    let handled = 0;
    const onIntent = (intent: NavigationIntent): void => {
      if (intent.contextId !== contextId || intent.teamName !== teamName ||
          intent.nonce === handled) return;
      handled = intent.nonce;
      open(intent.scope);
    };
    subscribers.add(onIntent);
    if (latest) onIntent(latest);
    return () => subscribers.delete(onIntent);
  }, [contextId, teamName, open]);
}
