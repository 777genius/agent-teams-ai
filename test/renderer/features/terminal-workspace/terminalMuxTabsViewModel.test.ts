import {
  createTerminalMuxTabsViewModel,
  resolveTerminalTabStripKeyboardIntent,
} from '@features/terminal-workspace/renderer/view-models/terminalMuxTabs';
import {
  PREWARMED_TERMINAL_TAB_TITLE,
  type TerminalMuxTab,
  type TerminalTabPreferences,
  type TerminalWorkspaceSnapshot,
} from '@features/terminal-workspace/renderer/model/terminalTabPreferences';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@terminal-platform/workspace-react', () => ({
  resolveTerminalTopologyControlState: (snapshot: MockSnapshot) => snapshot.__controls,
}));

describe('terminal mux tabs view model', () => {
  it('projects visible tabs, preferences, capabilities, and active presentation', () => {
    const build = createTab('tab-build', 'Build');
    const logs = createTab('tab-logs', 'Logs');
    const prewarmed = createTab('tab-prewarmed', PREWARMED_TERMINAL_TAB_TITLE);
    const snapshot = createSnapshot({
      activeTab: logs,
      tabs: [build, logs, prewarmed],
    });
    const preferences: TerminalTabPreferences = {
      colors: {
        'tab-build': 'amber',
      },
      order: ['tab-logs', 'tab-build', 'tab-prewarmed'],
      version: 1,
    };

    const model = createTerminalMuxTabsViewModel({
      placement: 'sheet-header',
      preferences,
      settingsOpen: false,
      snapshot,
    });

    expect(model.activeSessionId).toBe('session-1');
    expect(model.activeTabId).toBe('tab-logs');
    expect(model.canCloseVisibleTabs).toBe(true);
    expect(model.headerPlacement).toBe(true);
    expect(model.prewarmedTab).toBe(prewarmed);
    expect(model.orderedVisibleTabIds).toEqual(['tab-logs', 'tab-build']);
    expect(
      model.tabItems.map(({ active, explicitColorId, id, label }) => ({
        active,
        explicitColorId,
        id,
        label,
      }))
    ).toEqual([
      {
        active: true,
        explicitColorId: undefined,
        id: 'tab-logs',
        label: 'Logs',
      },
      {
        active: false,
        explicitColorId: 'amber',
        id: 'tab-build',
        label: 'Build',
      },
    ]);
  });

  it('keeps terminal tabs inactive while the settings tab owns selection', () => {
    const tab = createTab('tab-1', 'Shell');
    const model = createTerminalMuxTabsViewModel({
      placement: 'console',
      preferences: {
        colors: {},
        order: [],
        version: 1,
      },
      settingsOpen: true,
      snapshot: createSnapshot({
        activeTab: tab,
        tabs: [tab],
      }),
    });

    expect(model.tabItems[0]?.active).toBe(false);
    expect(model.canCloseVisibleTabs).toBe(false);
  });
});

describe('terminal tab strip keyboard intent', () => {
  const tabIds = ['tab-1', 'tab-2', 'tab-3'];

  it('wraps arrow navigation and resolves Home and End', () => {
    expect(resolveTerminalTabStripKeyboardIntent('ArrowLeft', 'tab-1', tabIds)).toEqual({
      targetTabId: 'tab-3',
    });
    expect(resolveTerminalTabStripKeyboardIntent('ArrowRight', 'tab-3', tabIds)).toEqual({
      targetTabId: 'tab-1',
    });
    expect(resolveTerminalTabStripKeyboardIntent('Home', 'tab-2', tabIds)).toEqual({
      targetTabId: 'tab-1',
    });
    expect(resolveTerminalTabStripKeyboardIntent('End', 'tab-1', tabIds)).toEqual({
      targetTabId: 'tab-3',
    });
  });

  it('ignores unrelated keys and tabs outside the current strip', () => {
    expect(resolveTerminalTabStripKeyboardIntent('Enter', 'tab-1', tabIds)).toBeUndefined();
    expect(resolveTerminalTabStripKeyboardIntent('ArrowRight', 'missing', tabIds)).toBeUndefined();
    expect(resolveTerminalTabStripKeyboardIntent('ArrowRight', 'tab-1', [])).toBeUndefined();
  });
});

interface MockSnapshot extends TerminalWorkspaceSnapshot {
  __controls: {
    activeSessionId: string;
    activeTab: TerminalMuxTab | null;
    canCloseTab: boolean;
    canCreateTab: boolean;
    canFocusTab: boolean;
    canRenameTab: boolean;
  };
}

function createSnapshot({
  activeTab,
  tabs,
}: {
  activeTab: TerminalMuxTab | null;
  tabs: TerminalMuxTab[];
}): TerminalWorkspaceSnapshot {
  return {
    __controls: {
      activeSessionId: 'session-1',
      activeTab,
      canCloseTab: true,
      canCreateTab: true,
      canFocusTab: true,
      canRenameTab: true,
    },
    attachedSession: {
      focused_screen: null,
      session_id: 'session-1',
      topology: {
        focused_tab: activeTab?.tab_id ?? '',
        tabs,
      },
    },
  } as unknown as MockSnapshot;
}

function createTab(tabId: string, title: string): TerminalMuxTab {
  return {
    active: false,
    focused_pane: `pane-${tabId}`,
    root: {
      cwd: '/fixtures/terminal-mux-tabs',
      kind: 'leaf',
      pane_id: `pane-${tabId}`,
      title,
    },
    tab_id: tabId,
    title,
  } as TerminalMuxTab;
}
