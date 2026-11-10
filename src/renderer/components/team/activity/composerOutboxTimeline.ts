import type { TimelineItem } from './LeadThoughtsGroup';
import type { ComposerOutboxItem } from '@renderer/services/composerOutbox';

export type ActivityTimelineItem =
  | TimelineItem
  | { readonly type: 'composer-outbox'; readonly item: ComposerOutboxItem };

function canonicalItemTimestamp(item: TimelineItem): number {
  const timestamp =
    item.type === 'lead-thoughts'
      ? item.group.thoughts[0]?.timestamp
      : item.message.timestamp;
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function mergeComposerOutboxTimelineItems(
  canonicalItems: readonly TimelineItem[],
  outboxItems: readonly ComposerOutboxItem[]
): ActivityTimelineItem[] {
  const result: ActivityTimelineItem[] = [];
  let canonicalIndex = 0;
  let outboxIndex = 0;
  while (canonicalIndex < canonicalItems.length || outboxIndex < outboxItems.length) {
    const canonical = canonicalItems[canonicalIndex];
    const outbox = outboxItems[outboxIndex];
    if (!outbox) {
      if (canonical) result.push(canonical);
      canonicalIndex += 1;
      continue;
    }
    if (!canonical) {
      result.push({ type: 'composer-outbox', item: outbox });
      outboxIndex += 1;
      continue;
    }
    if (canonicalItemTimestamp(canonical) >= outbox.createdAt) {
      result.push(canonical);
      canonicalIndex += 1;
    } else {
      result.push({ type: 'composer-outbox', item: outbox });
      outboxIndex += 1;
    }
  }
  return result;
}
