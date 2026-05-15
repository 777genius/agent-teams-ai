import { describe, expect, it } from 'vitest';

import { rankCommandItems } from '../policies/rankCommandItems';

import type { CommandItem } from '../models/CommandItem';

function item(overrides: Partial<CommandItem>): CommandItem {
  return {
    id: 'item',
    providerId: 'provider',
    category: 'action',
    icon: 'search',
    title: 'Alpha',
    intent: { type: 'tab.open', tab: 'dashboard' },
    ...overrides,
  };
}

describe('rankCommandItems', () => {
  it('uses provider order as the stable tie breaker for identical scores', () => {
    const result = rankCommandItems('alpha', [
      { providerIndex: 0, items: [item({ id: 'first', providerId: 'first' })] },
      { providerIndex: 1, items: [item({ id: 'second', providerId: 'second' })] },
    ]);

    expect(result.map((entry) => entry.item.providerId)).toEqual(['first', 'second']);
  });

  it('keeps the highest ranked item for a shared dedupe key', () => {
    const result = rankCommandItems('alpha', [
      {
        providerIndex: 0,
        items: [
          item({
            id: 'weak',
            providerId: 'first',
            title: 'Alpha detail',
            dedupeKey: 'same-command',
          }),
        ],
      },
      {
        providerIndex: 1,
        items: [
          item({
            id: 'strong',
            providerId: 'second',
            title: 'Alpha',
            priority: 50,
            dedupeKey: 'same-command',
          }),
        ],
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.item.id).toBe('strong');
  });

  it('filters items with no fuzzy match for non-empty queries', () => {
    const result = rankCommandItems('settings', [
      { providerIndex: 0, items: [item({ title: 'Open dashboard' })] },
    ]);

    expect(result).toEqual([]);
  });
});
