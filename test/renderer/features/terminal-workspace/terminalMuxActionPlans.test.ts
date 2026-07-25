import {
  planCloseTerminalTab,
  planCreateTerminalTab,
  planFocusTerminalTab,
  planRenameTerminalTab,
} from '@features/terminal-workspace/renderer/model/terminalMuxActionPlans';
import {
  PREWARMED_TERMINAL_TAB_TITLE,
  type TerminalMuxTab,
} from '@features/terminal-workspace/renderer/model/terminalTabPreferences';
import { describe, expect, it } from 'vitest';

describe('terminal mux action plans', () => {
  const visibleTabs = [createTab('tab-1', 'Build'), createTab('tab-2', 'Tests')];

  it('plans focus only when the target is available and inactive', () => {
    expect(planFocusTerminalTab('tab-2', 'tab-1', true)).toEqual({
      actionId: 'focus-tab:tab-2',
      commands: [{ kind: 'focus_tab', tab_id: 'tab-2' }],
    });
    expect(planFocusTerminalTab('tab-1', 'tab-1', true)).toBeNull();
    expect(planFocusTerminalTab('tab-2', 'tab-1', false)).toBeNull();
  });

  it('activates a prewarmed tab when focus and rename are supported', () => {
    const prewarmedTab = createTab('tab-prewarmed', PREWARMED_TERMINAL_TAB_TITLE);

    expect(
      planCreateTerminalTab({
        canCreateTab: true,
        canFocusTab: true,
        canRenameTab: true,
        prewarmedTab,
        visibleTabs,
      })
    ).toEqual({
      actionId: 'activate-prewarmed-tab',
      commands: [
        { kind: 'rename_tab', tab_id: 'tab-prewarmed', title: 'Tab 3' },
        { kind: 'focus_tab', tab_id: 'tab-prewarmed' },
      ],
    });
  });

  it('falls back to a new tab and rejects unavailable creation', () => {
    expect(
      planCreateTerminalTab({
        canCreateTab: true,
        canFocusTab: false,
        canRenameTab: true,
        prewarmedTab: createTab('tab-prewarmed', PREWARMED_TERMINAL_TAB_TITLE),
        visibleTabs,
      })
    ).toEqual({
      actionId: 'new-tab',
      commands: [{ kind: 'new_tab', title: 'Tab 3' }],
    });
    expect(
      planCreateTerminalTab({
        canCreateTab: false,
        canFocusTab: true,
        canRenameTab: true,
        prewarmedTab: null,
        visibleTabs,
      })
    ).toBeNull();
  });

  it('plans close, adjacent focus, and normalized rename without mutating tabs', () => {
    expect(
      planCloseTerminalTab({
        activeVisibleTabId: 'tab-2',
        canCloseVisibleTabs: true,
        canFocusTab: true,
        orderedVisibleTabs: visibleTabs,
        tab: visibleTabs[1],
      })
    ).toEqual({
      actionId: 'close-tab:tab-2',
      commands: [
        { kind: 'close_tab', tab_id: 'tab-2' },
        { kind: 'focus_tab', tab_id: 'tab-1' },
      ],
    });
    expect(planRenameTerminalTab(visibleTabs[0], '  Release  ')).toEqual({
      actionId: 'rename-tab:tab-1',
      commands: [{ kind: 'rename_tab', tab_id: 'tab-1', title: 'Release' }],
    });
    expect(planRenameTerminalTab(visibleTabs[0], ' Build ')).toBeNull();
    expect(visibleTabs.map((tab) => tab.title)).toEqual(['Build', 'Tests']);
  });
});

function createTab(tabId: string, title: string): TerminalMuxTab {
  return {
    active: false,
    focused_pane: `pane-${tabId}`,
    root: {
      cwd: '/fixtures/terminal-mux-actions',
      kind: 'leaf',
      pane_id: `pane-${tabId}`,
      title,
    },
    tab_id: tabId,
    title,
  } as TerminalMuxTab;
}
