import { toMessageKey } from '@renderer/utils/teamMessageKey';

import { isLeadThought } from './timelineClassification';

import type { InboxMessage } from '@shared/types';

export const CONVERSATION_PAGE_SIZE = 30;

/** Retain the oldest surviving committed key; remote tail never grows the budget. */
export function calculateConversationWindow(
  messages: InboxMessage[],
  requested: number,
  previousKeys?: ReadonlySet<string>
): { visibleMessages: InboxMessage[]; hiddenCount: number; budget: number; reset: boolean } {
  let significant = 0;
  let boundary = 0;
  let survived = false;
  for (const message of messages) {
    if (!isLeadThought(message)) significant++;
    if (previousKeys?.has(toMessageKey(message))) {
      boundary = significant;
      survived = true;
    }
  }
  const reset = Boolean(previousKeys?.size && !survived);
  const budget = reset ? CONVERSATION_PAGE_SIZE : Math.max(requested, boundary);
  let seen = 0;
  const cutoff = messages.findIndex((message) => !isLeadThought(message) && ++seen > budget);
  return {
    visibleMessages: cutoff < 0 ? messages : messages.slice(0, cutoff),
    hiddenCount: Math.max(0, significant - budget),
    budget,
    reset,
  };
}

/** Only keys before a surviving old head are proven live arrivals. */
export function classifyConversationHead(
  messages: InboxMessage[],
  previousKeys?: ReadonlySet<string>
): Set<string> {
  const result = new Set<string>();
  if (!previousKeys?.size) return result;
  for (const message of messages) {
    const key = toMessageKey(message);
    if (previousKeys.has(key)) return result;
    result.add(key);
  }
  return new Set();
}

export function projectTimelineRows<T>(
  rows: readonly T[],
  presentation: 'activity' | 'conversation'
): readonly T[] {
  return presentation === 'conversation' ? [...rows].reverse() : rows;
}
