import { describe, expect, it, vi } from 'vitest';

import { resolveCommandPaletteItems } from '../resolveCommandPaletteItems';

import type { CommandContext } from '../../domain/models/CommandContext';
import type { CommandItem } from '../../domain/models/CommandItem';
import type { CommandProvider } from '../../domain/models/CommandProvider';

const context: CommandContext = {
  selectedProjectId: null,
  activeTeamName: null,
  globalSearchEnabled: false,
};

function item(overrides: Partial<CommandItem>): CommandItem {
  return {
    id: 'item',
    providerId: 'provider',
    category: 'action',
    icon: 'search',
    title: 'Open settings',
    intent: { type: 'tab.open', tab: 'settings' },
    ...overrides,
  };
}

describe('resolveCommandPaletteItems', () => {
  it('keeps healthy provider results when another provider throws', async () => {
    const broken: CommandProvider = {
      id: 'broken',
      match: () => {
        throw new Error('boom');
      },
    };
    const healthy: CommandProvider = {
      id: 'healthy',
      match: () => [item({ providerId: 'healthy', title: 'Open dashboard' })],
    };

    const result = await resolveCommandPaletteItems({
      query: 'dashboard',
      context,
      providers: [broken, healthy],
      signal: new AbortController().signal,
    });

    expect(result.aborted).toBe(false);
    expect(result.items.map((entry) => entry.providerId)).toEqual(['healthy']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.providerId).toBe('broken');
  });

  it('ignores stale async provider results after cancellation', async () => {
    const asyncProvider: CommandProvider = {
      id: 'async',
      match: () => [],
      matchAsync: vi.fn(
        () =>
          new Promise<readonly CommandItem[]>((resolve) => {
            globalThis.setTimeout(
              () => resolve([item({ providerId: 'async', title: 'Async result' })]),
              50
            );
          })
      ),
    };
    const controller = new AbortController();

    const pending = resolveCommandPaletteItems({
      query: 'async',
      context,
      providers: [asyncProvider],
      signal: controller.signal,
    });
    controller.abort();

    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.items).toEqual([]);
  });

  it('resolves async items when the signal stays active', async () => {
    const asyncProvider: CommandProvider = {
      id: 'async',
      match: () => [],
      matchAsync: async () => [item({ providerId: 'async', title: 'Async settings' })],
    };

    const result = await resolveCommandPaletteItems({
      query: 'settings',
      context,
      providers: [asyncProvider],
      signal: new AbortController().signal,
    });

    expect(result.aborted).toBe(false);
    expect(result.items.map((entry) => entry.title)).toEqual(['Async settings']);
  });
});
