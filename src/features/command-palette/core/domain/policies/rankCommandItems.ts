import { scoreCommandMatch } from './scoreCommandMatch';

import type { CommandItem, RankedCommandItem } from '../models/CommandItem';

export interface CommandProviderItems {
  providerIndex: number;
  items: readonly CommandItem[];
}

function commandDedupeKey(item: CommandItem): string {
  return item.dedupeKey ?? `${item.providerId}:${item.id}`;
}

function compareRankedCommandItems(left: RankedCommandItem, right: RankedCommandItem): number {
  const scoreDelta = right.score - left.score;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const providerDelta = left.providerIndex - right.providerIndex;
  if (providerDelta !== 0) {
    return providerDelta;
  }

  return left.itemIndex - right.itemIndex;
}

export function rankCommandItems(
  query: string,
  providerItems: readonly CommandProviderItems[],
  limit = 30
): RankedCommandItem[] {
  const ranked: RankedCommandItem[] = [];

  for (const bucket of providerItems) {
    bucket.items.forEach((item, itemIndex) => {
      const score = scoreCommandMatch(query, item);
      if (score == null) {
        return;
      }
      ranked.push({
        item,
        score,
        providerIndex: bucket.providerIndex,
        itemIndex,
      });
    });
  }

  ranked.sort(compareRankedCommandItems);

  const deduped: RankedCommandItem[] = [];
  const seen = new Set<string>();
  for (const entry of ranked) {
    const key = commandDedupeKey(entry.item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
    if (deduped.length >= limit) {
      break;
    }
  }

  return deduped;
}
