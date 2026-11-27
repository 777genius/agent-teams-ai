import { useEffect, useRef } from 'react';

import type { ConversationScope } from '@features/team-direct-chats/renderer';

interface NavigationIntent {
  contextId: string;
  teamName: string;
  scope: ConversationScope;
  nonce: number;
  createdAt: number;
}

let latest: NavigationIntent | null = null;
let nextNonce = 0;
const subscribers = new Set<(intent: NavigationIntent) => void>();

export function requestAttentionChatNavigation(input: Omit<NavigationIntent, 'nonce' | 'createdAt'>): void {
  const intent: NavigationIntent = { ...input, nonce: ++nextNonce, createdAt: Date.now() };
  latest = intent;
  for (const subscriber of subscribers) subscriber(intent);
}

/** Pending intent also reaches team panels mounted *after* opening the tab. */
export function useAttentionConversationNavigation(
  contextId: string,
  teamName: string,
  open: (scope: ConversationScope) => void
): void {
  const handledRef = useRef(0);
  useEffect(() => {
    const onIntent = (intent: NavigationIntent): void => {
      if (intent.contextId !== contextId || intent.teamName !== teamName ||
          intent.nonce === handledRef.current) return;
      if (Date.now() - intent.createdAt > 30_000) {
        if (latest?.nonce === intent.nonce) latest = null;
        return;
      }
      handledRef.current = intent.nonce;
      // Keep the intent until its short expiry: another already-open pane may
      // mount its MessagesPanel only after openTeamTab focuses that pane.
      open(intent.scope);
    };
    subscribers.add(onIntent);
    if (latest) onIntent(latest);
    return () => {
      subscribers.delete(onIntent);
    };
  }, [contextId, teamName, open]);
}
