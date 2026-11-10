import { conversationScopeKey } from './conversationScope';

import type { ConversationScope } from './conversationScope';

export function isPinnedChatKey(value: string): boolean {
  return value === 'team-feed' || value.startsWith('direct:');
}

export function normalizePinnedChatKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string' || !isPinnedChatKey(value) || seen.has(value)) {
      continue;
    }
    seen.add(value);
    keys.push(value);
  }
  return keys;
}

export function togglePinnedChatKey(order: readonly string[], key: string): string[] {
  if (!isPinnedChatKey(key)) {
    return [...order];
  }
  if (order.includes(key)) {
    return order.filter((item) => item !== key);
  }
  return [key, ...order];
}

export function movePinnedChatKey(
  order: readonly string[],
  fromKey: string,
  toKey: string
): string[] {
  const from = order.indexOf(fromKey);
  const to = order.indexOf(toKey);
  if (from < 0 || to < 0 || from === to) {
    return [...order];
  }
  const next = [...order];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function prunePinnedChatKeys(
  order: readonly string[],
  availableKeys: ReadonlySet<string>
): string[] {
  return order.filter((key) => availableKeys.has(key));
}

export function applyPinnedChatOrder<T extends { scope: ConversationScope }>(
  items: readonly T[],
  pinnedKeys: readonly string[]
): T[] {
  if (pinnedKeys.length === 0) {
    return [...items];
  }
  const byKey = new Map(items.map((item) => [conversationScopeKey(item.scope), item] as const));
  const pinned: T[] = [];
  const pinnedSet = new Set<string>();
  for (const key of pinnedKeys) {
    const item = byKey.get(key);
    if (!item) {
      continue;
    }
    pinned.push(item);
    pinnedSet.add(key);
  }
  const rest = items.filter((item) => !pinnedSet.has(conversationScopeKey(item.scope)));
  return [...pinned, ...rest];
}
