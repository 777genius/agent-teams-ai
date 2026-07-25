import {
  formatNextMuxTabTitle,
  isPrewarmedTerminalTab,
  resolveVisibleTabToFocusAfterClose,
  type TerminalMuxTab,
} from './terminalTabPreferences';

import type { MuxCommand } from '@terminal-platform/runtime-types';

export type TerminalMuxCommand = MuxCommand;

export interface TerminalMuxActionPlan {
  actionId: string;
  commands: readonly TerminalMuxCommand[];
}

export function planFocusTerminalTab(
  tabId: string,
  activeTabId: string | null,
  canFocusTab: boolean
): TerminalMuxActionPlan | null {
  if (!canFocusTab || tabId === activeTabId) {
    return null;
  }

  return {
    actionId: `focus-tab:${tabId}`,
    commands: [{ kind: 'focus_tab', tab_id: tabId }],
  };
}

export function planCreateTerminalTab({
  canCreateTab,
  canFocusTab,
  canRenameTab,
  prewarmedTab,
  visibleTabs,
}: {
  canCreateTab: boolean;
  canFocusTab: boolean;
  canRenameTab: boolean;
  prewarmedTab: TerminalMuxTab | null;
  visibleTabs: readonly TerminalMuxTab[];
}): TerminalMuxActionPlan | null {
  if (!canCreateTab) {
    return null;
  }

  const title = formatNextMuxTabTitle(visibleTabs);
  if (prewarmedTab && canFocusTab && canRenameTab) {
    return {
      actionId: 'activate-prewarmed-tab',
      commands: [
        {
          kind: 'rename_tab',
          tab_id: prewarmedTab.tab_id,
          title,
        },
        { kind: 'focus_tab', tab_id: prewarmedTab.tab_id },
      ],
    };
  }

  return {
    actionId: 'new-tab',
    commands: [{ kind: 'new_tab', title }],
  };
}

export function planCloseTerminalTab({
  activeVisibleTabId,
  canCloseVisibleTabs,
  canFocusTab,
  orderedVisibleTabs,
  tab,
}: {
  activeVisibleTabId: string | null;
  canCloseVisibleTabs: boolean;
  canFocusTab: boolean;
  orderedVisibleTabs: readonly TerminalMuxTab[];
  tab: TerminalMuxTab;
}): TerminalMuxActionPlan | null {
  if (!canCloseVisibleTabs || isPrewarmedTerminalTab(tab)) {
    return null;
  }

  const commands: TerminalMuxCommand[] = [{ kind: 'close_tab', tab_id: tab.tab_id }];
  if (canFocusTab && tab.tab_id === activeVisibleTabId) {
    const nextTabId = resolveVisibleTabToFocusAfterClose(orderedVisibleTabs, tab.tab_id);
    if (nextTabId) {
      commands.push({ kind: 'focus_tab', tab_id: nextTabId });
    }
  }

  return {
    actionId: `close-tab:${tab.tab_id}`,
    commands,
  };
}

export function planRenameTerminalTab(
  tab: TerminalMuxTab,
  title: string
): TerminalMuxActionPlan | null {
  const normalizedTitle = title.trim();
  if (!normalizedTitle || normalizedTitle === (tab.title?.trim() || '')) {
    return null;
  }

  return {
    actionId: `rename-tab:${tab.tab_id}`,
    commands: [
      {
        kind: 'rename_tab',
        tab_id: tab.tab_id,
        title: normalizedTitle,
      },
    ],
  };
}
