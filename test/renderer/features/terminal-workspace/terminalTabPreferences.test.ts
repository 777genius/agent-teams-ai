import {
  createDefaultTerminalTabPreferences,
  normalizeTerminalTabPreferences,
  orderTerminalTabsByPreference,
  parseTerminalTabPreferences,
  reorderTerminalTabsById,
  resolveTerminalTabColor,
  resolveVisibleTabToFocusAfterClose,
  type TerminalMuxTab,
} from '@features/terminal-workspace/renderer/model/terminalTabPreferences';
import { describe, expect, it } from 'vitest';

describe('terminal tab preferences', () => {
  const tabs = [createTab('tab-1', 'One'), createTab('tab-2', 'Two'), createTab('tab-3', 'Three')];

  it('parses only supported persisted tab order and color values', () => {
    expect(
      parseTerminalTabPreferences(
        JSON.stringify({
          colors: { 'tab-1': 'rose', 'tab-2': 'unsupported' },
          order: ['tab-2', 42, 'tab-1'],
          version: 0,
        })
      )
    ).toEqual({
      colors: { 'tab-1': 'rose' },
      order: ['tab-2', 'tab-1'],
      version: 1,
    });
    expect(parseTerminalTabPreferences('{broken')).toEqual(createDefaultTerminalTabPreferences());
  });

  it('orders known tabs by preference and appends unmentioned tabs stably', () => {
    expect(orderTerminalTabsByPreference(tabs, ['tab-3', 'missing', 'tab-1'])).toEqual([
      tabs[2],
      tabs[0],
      tabs[1],
    ]);
  });

  it('normalizes stale tab identities and color assignments', () => {
    expect(
      normalizeTerminalTabPreferences(
        {
          colors: { 'tab-1': 'amber', missing: 'rose' },
          order: ['tab-2', 'missing'],
          version: 1,
        },
        tabs
      )
    ).toEqual({
      colors: { 'tab-1': 'amber' },
      order: ['tab-2', 'tab-1', 'tab-3'],
      version: 1,
    });
  });

  it('reorders tabs and resolves the adjacent focus target without mutating inputs', () => {
    const currentOrder = ['tab-1', 'tab-2', 'tab-3'];

    expect(reorderTerminalTabsById(currentOrder, tabs, 'tab-1', 'tab-3', 'after')).toEqual([
      'tab-2',
      'tab-3',
      'tab-1',
    ]);
    expect(currentOrder).toEqual(['tab-1', 'tab-2', 'tab-3']);
    expect(resolveVisibleTabToFocusAfterClose(tabs, 'tab-2')).toBe('tab-1');
    expect(resolveVisibleTabToFocusAfterClose(tabs, 'missing')).toBeNull();
  });

  it('falls back to the canonical sky color for missing preferences', () => {
    expect(resolveTerminalTabColor(undefined).id).toBe('sky');
  });
});

function createTab(tabId: string, title: string): TerminalMuxTab {
  return {
    active: false,
    focused_pane: `pane-${tabId}`,
    root: {
      cwd: '/fixtures/terminal-tab',
      kind: 'leaf',
      pane_id: `pane-${tabId}`,
      title,
    },
    tab_id: tabId,
    title,
  } as TerminalMuxTab;
}
