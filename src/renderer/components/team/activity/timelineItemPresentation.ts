import { toMessageKey } from '@renderer/utils/teamMessageKey';

import { isNoiseMessage } from './activityMessagePresentation';
import { getThoughtGroupKey } from './thoughtGroupKey';
import { isCompactionMessage } from './timelineClassification';

import type { ActivityTimelineItem } from './composerOutboxTimeline';

/** Anchor zebra striping at the newest card so prepends never recolor existing cards. */
export function buildZebraShadeSet(items: readonly ActivityTimelineItem[]): ReadonlySet<number> {
  const result = new Set<number>();
  let cardCount = 0;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.type === 'composer-outbox' || item.type === 'lead-thoughts') {
      if (cardCount % 2 === 1) result.add(index);
      cardCount++;
    } else {
      if (isNoiseMessage(item.message.text) || isCompactionMessage(item.message)) continue;
      if (cardCount % 2 === 1) result.add(index);
      cardCount++;
    }
  }
  return result;
}

export function buildTimelineItemKeys(items: readonly ActivityTimelineItem[]): string[] {
  return items.map((item) => {
    if (item.type === 'composer-outbox') return `composer-outbox:${item.item.id}`;
    if (item.type === 'lead-thoughts') return getThoughtGroupKey(item.group);
    return toMessageKey(item.message);
  });
}

export function buildConversationNewItemKeys(
  items: readonly ActivityTimelineItem[],
  itemKeys: readonly string[],
  freshKeys: ReadonlySet<string>
): ReadonlySet<string> {
  return new Set(
    items.flatMap((item, index) => {
      const fresh =
        item.type === 'composer-outbox'
          ? false
          : item.type === 'lead-thoughts'
            ? item.group.thoughts.every((message) => freshKeys.has(toMessageKey(message)))
            : freshKeys.has(toMessageKey(item.message));
      return fresh ? [itemKeys[index]] : [];
    })
  );
}
