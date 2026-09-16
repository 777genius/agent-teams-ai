import { resolveTerminalTopologyControlState } from '@terminal-platform/workspace-react';

import {
  formatMuxTabTitle,
  isPrewarmedTerminalTab,
  orderTerminalTabsByPreference,
  resolveTerminalTabColor,
  type TerminalMuxTab,
  type TerminalTabColorId,
  type TerminalTabColorOption,
  type TerminalTabPreferences,
  type TerminalWorkspaceSnapshot,
} from '../model/terminalTabPreferences';

export interface TerminalMuxTabItemViewModel {
  active: boolean;
  color: TerminalTabColorOption;
  explicitColorId: TerminalTabColorId | undefined;
  id: string;
  label: string;
  tab: TerminalMuxTab;
}

export interface TerminalMuxTabsViewModel {
  activeSessionId: string | null;
  activeTabId: string | null;
  activeVisibleTabId: string | null;
  canCloseVisibleTabs: boolean;
  canCreateTab: boolean;
  canFocusTab: boolean;
  canRenameTab: boolean;
  headerPlacement: boolean;
  orderedVisibleTabIds: string[];
  orderedVisibleTabs: TerminalMuxTab[];
  prewarmedTab: TerminalMuxTab | null;
  tabItems: TerminalMuxTabItemViewModel[];
  tabsCount: number;
  visibleTabIdsKey: string;
  visibleTabs: TerminalMuxTab[];
}

export interface CreateTerminalMuxTabsViewModelOptions {
  placement: 'console' | 'sheet-header';
  preferences: TerminalTabPreferences;
  settingsOpen: boolean;
  snapshot: TerminalWorkspaceSnapshot;
}

export type TerminalTabStripFocusTarget =
  | Readonly<{
      kind: 'settings';
    }>
  | Readonly<{
      kind: 'terminal';
      tabId: string;
    }>;

export type TerminalTabStripKeyboardIntent =
  | Readonly<{
      target: TerminalTabStripFocusTarget;
    }>
  | undefined;

export function createTerminalMuxTabsViewModel({
  placement,
  preferences,
  settingsOpen,
  snapshot,
}: CreateTerminalMuxTabsViewModelOptions): TerminalMuxTabsViewModel {
  const topology = snapshot.attachedSession?.topology ?? null;
  const controls = resolveTerminalTopologyControlState(snapshot);
  const tabs = topology?.tabs ?? [];
  const visibleTabs = tabs.filter((tab) => !isPrewarmedTerminalTab(tab));
  const orderedVisibleTabs = orderTerminalTabsByPreference(visibleTabs, preferences.order);
  const activeTabId =
    controls.activeTab?.tab_id ?? topology?.focused_tab ?? tabs[0]?.tab_id ?? null;
  const activeVisibleTabId = visibleTabs.some((tab) => tab.tab_id === activeTabId)
    ? activeTabId
    : (visibleTabs[0]?.tab_id ?? null);

  return {
    activeSessionId: controls.activeSessionId,
    activeTabId,
    activeVisibleTabId,
    canCloseVisibleTabs: controls.canCloseTab && visibleTabs.length > 1,
    canCreateTab: controls.canCreateTab,
    canFocusTab: controls.canFocusTab,
    canRenameTab: controls.canRenameTab,
    headerPlacement: placement === 'sheet-header',
    orderedVisibleTabIds: orderedVisibleTabs.map((tab) => tab.tab_id),
    orderedVisibleTabs,
    prewarmedTab: tabs.find(isPrewarmedTerminalTab) ?? null,
    tabItems: orderedVisibleTabs.map((tab, index) => {
      const explicitColorId = preferences.colors[tab.tab_id];
      return {
        active: !settingsOpen && tab.tab_id === activeVisibleTabId,
        color: resolveTerminalTabColor(explicitColorId),
        explicitColorId,
        id: tab.tab_id,
        label: formatMuxTabTitle(tab, index),
        tab,
      };
    }),
    tabsCount: tabs.length,
    visibleTabIdsKey: visibleTabs.map((tab) => tab.tab_id).join('\u001f'),
    visibleTabs,
  };
}

export function resolveTerminalTabStripKeyboardIntent(
  key: string,
  currentTarget: TerminalTabStripFocusTarget,
  orderedTabIds: readonly string[],
  settingsOpen = false
): TerminalTabStripKeyboardIntent {
  const orderedTargets: TerminalTabStripFocusTarget[] = orderedTabIds.map((tabId) => ({
    kind: 'terminal',
    tabId,
  }));
  if (settingsOpen) {
    orderedTargets.push({ kind: 'settings' });
  }
  const currentIndex = orderedTargets.findIndex((target) =>
    areTerminalTabStripTargetsEqual(target, currentTarget)
  );
  if (currentIndex < 0 || orderedTargets.length === 0) {
    return undefined;
  }

  let targetIndex: number;
  switch (key) {
    case 'ArrowLeft':
      targetIndex = (currentIndex - 1 + orderedTargets.length) % orderedTargets.length;
      break;
    case 'ArrowRight':
      targetIndex = (currentIndex + 1) % orderedTargets.length;
      break;
    case 'Home':
      targetIndex = 0;
      break;
    case 'End':
      targetIndex = orderedTargets.length - 1;
      break;
    default:
      return undefined;
  }

  return {
    target: orderedTargets[targetIndex],
  };
}

function areTerminalTabStripTargetsEqual(
  left: TerminalTabStripFocusTarget,
  right: TerminalTabStripFocusTarget
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'settings' || (right.kind === 'terminal' && left.tabId === right.tabId))
  );
}
