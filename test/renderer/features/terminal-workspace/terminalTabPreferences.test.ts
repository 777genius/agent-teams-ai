import {
  PREWARMED_TERMINAL_TAB_TITLE,
  createDefaultTerminalTabPreferences,
  normalizeTerminalTabPreferences,
  normalizeTerminalUserTabTitle,
  orderTerminalTabsByPreference,
  parseTerminalTabPreferences,
  reorderTerminalTabsById,
  resolveTerminalTabContentState,
  resolveTerminalTabColor,
  resolveVisibleTabToFocusAfterClose,
  type TerminalMuxTab,
  type TerminalWorkspaceSnapshot,
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

  it('normalizes user titles without exposing the internal prewarmed tab identity', () => {
    expect(normalizeTerminalUserTabTitle('  Release  ')).toBe('Release');
    expect(normalizeTerminalUserTabTitle('   ')).toBeNull();
    expect(normalizeTerminalUserTabTitle(` ${PREWARMED_TERMINAL_TAB_TITLE} `)).toBeNull();
  });

  it('treats missing pane history as unknown and potentially destructive', () => {
    const snapshot = createSnapshot({
      focusedPaneId: 'pane-tab-1',
      focusedLines: [''],
    });

    expect(resolveTerminalTabContentState(snapshot, tabs[0])).toBe('unknown');
    expect(resolveTerminalTabContentState(snapshot, tabs[1])).toBe('unknown');
  });

  it('requires complete focused single-pane history to prove a tab is empty', () => {
    const completeHistory = createHistoricalPane();

    expect(
      resolveTerminalTabContentState(
        createSnapshot({
          focusedPaneId: 'pane-tab-1',
          historicalPanes: {
            'pane-tab-1': completeHistory,
          },
        }),
        tabs[0]
      )
    ).toBe('empty');
    expect(
      resolveTerminalTabContentState(
        createSnapshot({
          focusedPaneId: 'pane-tab-1',
          historicalPanes: {
            'pane-tab-1': createHistoricalPane({
              hasMoreSegments: true,
              nextEventSeq: 2n,
            }),
          },
        }),
        tabs[0]
      )
    ).toBe('unknown');
    expect(
      resolveTerminalTabContentState(
        createSnapshot({
          focusedPaneId: 'pane-tab-1',
          historicalPanes: {
            'pane-tab-2': completeHistory,
          },
        }),
        tabs[1]
      )
    ).toBe('unknown');
  });

  it('prioritizes known content and keeps multi-pane tabs conservative', () => {
    const snapshot = createSnapshot({
      focusedPaneId: 'pane-tab-1',
      focusedLines: ['live output'],
      historicalPanes: {
        'pane-tab-1': createHistoricalPane(),
        'pane-tab-2': createHistoricalPane(),
      },
    });

    expect(resolveTerminalTabContentState(snapshot, tabs[0])).toBe('has-content');
    expect(
      resolveTerminalTabContentState(
        createSnapshot({
          focusedPaneId: 'pane-tab-1',
          historicalPanes: {
            'pane-tab-1': createHistoricalPane({ lines: [' '] }),
          },
        }),
        tabs[0]
      )
    ).toBe('has-content');
    expect(
      resolveTerminalTabContentState(snapshot, createSplitTab('tab-split', tabs[0], tabs[1]))
    ).toBe('has-content');
    expect(
      resolveTerminalTabContentState(
        createSnapshot({
          focusedPaneId: 'pane-tab-1',
          historicalPanes: {
            'pane-tab-1': createHistoricalPane(),
            'pane-tab-2': createHistoricalPane(),
          },
        }),
        createSplitTab('tab-split', tabs[0], tabs[1])
      )
    ).toBe('unknown');
  });
});

interface HistoricalPaneFixture {
  fromEventSeq: bigint;
  hasGaps: boolean;
  hasMoreSegments: boolean;
  lines: string[];
  nextEventSeq: bigint | null;
}

function createSnapshot({
  focusedLines = [],
  focusedPaneId,
  historicalPanes = {},
}: {
  focusedLines?: string[];
  focusedPaneId: string;
  historicalPanes?: Record<string, HistoricalPaneFixture>;
}): TerminalWorkspaceSnapshot {
  return {
    attachedSession: {
      focused_screen: {
        pane_id: focusedPaneId,
        surface: {
          lines: focusedLines.map((text) => ({ spans: [], text })),
        },
      },
    },
    historicalPanes,
  } as unknown as TerminalWorkspaceSnapshot;
}

function createHistoricalPane(
  overrides: Partial<HistoricalPaneFixture> = {}
): HistoricalPaneFixture {
  return {
    fromEventSeq: 1n,
    hasGaps: false,
    hasMoreSegments: false,
    lines: [],
    nextEventSeq: null,
    ...overrides,
  };
}

function createSplitTab(
  tabId: string,
  firstTab: TerminalMuxTab,
  secondTab: TerminalMuxTab
): TerminalMuxTab {
  return {
    active: false,
    focused_pane: firstTab.focused_pane,
    root: {
      direction: 'horizontal',
      first: firstTab.root,
      kind: 'split',
      ratio: 0.5,
      second: secondTab.root,
    },
    tab_id: tabId,
    title: 'Split',
  } as TerminalMuxTab;
}

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
