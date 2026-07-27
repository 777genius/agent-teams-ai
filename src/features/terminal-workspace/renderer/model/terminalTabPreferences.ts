import type { TerminalCommandRunPresentation } from './terminalCommandRuns';
import type { WorkspaceKernel } from '@terminal-platform/workspace-core';

export const PREWARMED_TERMINAL_TAB_TITLE = '__tp_prewarmed_shell__';
const TERMINAL_TAB_PREFERENCES_VERSION = 1;
const TERMINAL_TAB_COLOR_LABEL_KEYS = {
  amber: 'terminalWorkspace.tabColorAmber',
  blue: 'terminalWorkspace.tabColorBlue',
  cyan: 'terminalWorkspace.tabColorCyan',
  emerald: 'terminalWorkspace.tabColorEmerald',
  lime: 'terminalWorkspace.tabColorLime',
  orange: 'terminalWorkspace.tabColorOrange',
  rose: 'terminalWorkspace.tabColorRose',
  sky: 'terminalWorkspace.tabColorSky',
  slate: 'terminalWorkspace.tabColorSlate',
  teal: 'terminalWorkspace.tabColorTeal',
  violet: 'terminalWorkspace.tabColorViolet',
} as const;

export type TerminalWorkspaceSnapshot = ReturnType<WorkspaceKernel['getSnapshot']>;
export type TerminalMuxTab = NonNullable<
  TerminalWorkspaceSnapshot['attachedSession']
>['topology']['tabs'][number];
type TerminalMuxPaneTreeNode = TerminalMuxTab['root'];
export type TerminalTabColorId = (typeof TERMINAL_TAB_COLOR_OPTIONS)[number]['id'];
export type TerminalTabContentState = 'empty' | 'has-content' | 'unknown';

export interface TerminalTabColorOption {
  id: string;
  accent: string;
  border: string;
  background: string;
  hoverBackground: string;
}

export interface TerminalTabPreferences {
  version: number;
  order: string[];
  colors: Record<string, TerminalTabColorId>;
}

export interface TerminalTabDropIndicator {
  placementMode: 'before' | 'after';
  tabId: string;
}

export interface TerminalTabPointerDrag {
  active: boolean;
  grabOffsetX: number;
  offsetX: number;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  tabId: string;
}

export const TERMINAL_TAB_COLOR_OPTIONS = [
  {
    id: 'slate',
    accent: '#94a3b8',
    border: 'rgba(148, 163, 184, 0.56)',
    background: 'rgba(148, 163, 184, 0.14)',
    hoverBackground: 'rgba(148, 163, 184, 0.18)',
  },
  {
    id: 'sky',
    accent: '#38bdf8',
    border: 'rgba(56, 189, 248, 0.58)',
    background: 'rgba(56, 189, 248, 0.15)',
    hoverBackground: 'rgba(56, 189, 248, 0.2)',
  },
  {
    id: 'blue',
    accent: '#60a5fa',
    border: 'rgba(96, 165, 250, 0.58)',
    background: 'rgba(96, 165, 250, 0.15)',
    hoverBackground: 'rgba(96, 165, 250, 0.2)',
  },
  {
    id: 'cyan',
    accent: '#22d3ee',
    border: 'rgba(34, 211, 238, 0.58)',
    background: 'rgba(34, 211, 238, 0.14)',
    hoverBackground: 'rgba(34, 211, 238, 0.19)',
  },
  {
    id: 'teal',
    accent: '#2dd4bf',
    border: 'rgba(45, 212, 191, 0.56)',
    background: 'rgba(45, 212, 191, 0.14)',
    hoverBackground: 'rgba(45, 212, 191, 0.19)',
  },
  {
    id: 'emerald',
    accent: '#34d399',
    border: 'rgba(52, 211, 153, 0.56)',
    background: 'rgba(52, 211, 153, 0.14)',
    hoverBackground: 'rgba(52, 211, 153, 0.19)',
  },
  {
    id: 'lime',
    accent: '#a3e635',
    border: 'rgba(163, 230, 53, 0.52)',
    background: 'rgba(163, 230, 53, 0.12)',
    hoverBackground: 'rgba(163, 230, 53, 0.17)',
  },
  {
    id: 'amber',
    accent: '#fbbf24',
    border: 'rgba(251, 191, 36, 0.54)',
    background: 'rgba(251, 191, 36, 0.13)',
    hoverBackground: 'rgba(251, 191, 36, 0.18)',
  },
  {
    id: 'orange',
    accent: '#fb923c',
    border: 'rgba(251, 146, 60, 0.54)',
    background: 'rgba(251, 146, 60, 0.13)',
    hoverBackground: 'rgba(251, 146, 60, 0.18)',
  },
  {
    id: 'rose',
    accent: '#fb7185',
    border: 'rgba(251, 113, 133, 0.56)',
    background: 'rgba(251, 113, 133, 0.14)',
    hoverBackground: 'rgba(251, 113, 133, 0.19)',
  },
  {
    id: 'violet',
    accent: '#a78bfa',
    border: 'rgba(167, 139, 250, 0.56)',
    background: 'rgba(167, 139, 250, 0.14)',
    hoverBackground: 'rgba(167, 139, 250, 0.19)',
  },
] as const satisfies readonly TerminalTabColorOption[];

export function parseTerminalTabPreferences(raw: string | null): TerminalTabPreferences {
  if (!raw) return createDefaultTerminalTabPreferences();

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return createDefaultTerminalTabPreferences();
    }

    const source = parsed as {
      order?: unknown;
      colors?: unknown;
    };
    const order = Array.isArray(source.order)
      ? source.order.filter((item): item is string => typeof item === 'string')
      : [];
    const colors: Record<string, TerminalTabColorId> = {};
    if (source.colors && typeof source.colors === 'object') {
      for (const [tabId, colorId] of Object.entries(source.colors)) {
        if (typeof tabId === 'string' && isTerminalTabColorId(colorId)) {
          colors[tabId] = colorId;
        }
      }
    }

    return {
      version: TERMINAL_TAB_PREFERENCES_VERSION,
      order,
      colors,
    };
  } catch {
    return createDefaultTerminalTabPreferences();
  }
}

export function formatMuxTabTitle(tab: TerminalMuxTab, index: number): string {
  return tab.title?.trim() || `Tab ${index + 1}`;
}

export function formatNextMuxTabTitle(tabs: readonly TerminalMuxTab[]): string {
  const usedTitles = new Set(
    tabs.map((tab) => tab.title?.trim()).filter((title): title is string => Boolean(title))
  );
  let nextNumber = Math.max(tabs.length + 1, 1);

  for (const title of usedTitles) {
    const match = /^Tab\s+(\d+)$/i.exec(title);
    if (!match) continue;
    nextNumber = Math.max(nextNumber, Number(match[1]) + 1);
  }

  let nextTitle = formatNewMuxTabTitle(nextNumber);
  while (usedTitles.has(nextTitle)) {
    nextNumber += 1;
    nextTitle = formatNewMuxTabTitle(nextNumber);
  }

  return nextTitle;
}

export function createDefaultTerminalTabPreferences(): TerminalTabPreferences {
  return {
    version: TERMINAL_TAB_PREFERENCES_VERSION,
    order: [],
    colors: {},
  };
}

export function normalizeTerminalTabPreferences(
  preferences: TerminalTabPreferences,
  tabs: readonly TerminalMuxTab[]
): TerminalTabPreferences {
  const normalizedOrder = orderTerminalTabsByPreference(tabs, preferences.order).map(
    (tab) => tab.tab_id
  );
  const visibleTabIds = new Set(normalizedOrder);
  const colors: Record<string, TerminalTabColorId> = {};

  for (const [tabId, colorId] of Object.entries(preferences.colors)) {
    if (visibleTabIds.has(tabId) && isTerminalTabColorId(colorId)) {
      colors[tabId] = colorId;
    }
  }

  return {
    version: TERMINAL_TAB_PREFERENCES_VERSION,
    order: normalizedOrder,
    colors,
  };
}

export function orderTerminalTabsByPreference(
  tabs: readonly TerminalMuxTab[],
  order: readonly string[]
): TerminalMuxTab[] {
  const remainingTabsById = new Map(tabs.map((tab) => [tab.tab_id, tab]));
  const orderedTabs: TerminalMuxTab[] = [];

  for (const tabId of order) {
    const tab = remainingTabsById.get(tabId);
    if (!tab) continue;
    orderedTabs.push(tab);
    remainingTabsById.delete(tabId);
  }

  return [...orderedTabs, ...tabs.filter((tab) => remainingTabsById.has(tab.tab_id))];
}

export function resolveVisibleTabToFocusAfterClose(
  orderedTabs: readonly TerminalMuxTab[],
  closingTabId: string
): string | null {
  const closingIndex = orderedTabs.findIndex((tab) => tab.tab_id === closingTabId);
  if (closingIndex < 0) {
    return null;
  }

  return orderedTabs[closingIndex - 1]?.tab_id ?? orderedTabs[closingIndex + 1]?.tab_id ?? null;
}

export function reorderTerminalTabsById(
  currentOrder: readonly string[],
  tabs: readonly TerminalMuxTab[],
  sourceTabId: string,
  targetTabId: string,
  placementMode: 'before' | 'after'
): string[] {
  const order = orderTerminalTabsByPreference(tabs, currentOrder).map((tab) => tab.tab_id);
  if (!order.includes(sourceTabId) || !order.includes(targetTabId)) {
    return order;
  }

  const withoutSource = order.filter((tabId) => tabId !== sourceTabId);
  const targetIndex = withoutSource.indexOf(targetTabId);
  if (targetIndex === -1) {
    return order;
  }

  withoutSource.splice(placementMode === 'after' ? targetIndex + 1 : targetIndex, 0, sourceTabId);
  return withoutSource;
}

export function resolveTerminalTabColor(
  colorId: TerminalTabColorId | undefined
): TerminalTabColorOption {
  return (
    TERMINAL_TAB_COLOR_OPTIONS.find((option) => option.id === colorId) ??
    TERMINAL_TAB_COLOR_OPTIONS.find((option) => option.id === 'sky') ??
    TERMINAL_TAB_COLOR_OPTIONS[0]
  );
}

export function getTerminalTabColorLabelKey(
  colorId: TerminalTabColorId
): (typeof TERMINAL_TAB_COLOR_LABEL_KEYS)[TerminalTabColorId] {
  return TERMINAL_TAB_COLOR_LABEL_KEYS[colorId];
}

export function isTerminalTabColorId(value: unknown): value is TerminalTabColorId {
  return (
    typeof value === 'string' && TERMINAL_TAB_COLOR_OPTIONS.some((option) => option.id === value)
  );
}

export function areTerminalTabPreferencesEqual(
  left: TerminalTabPreferences,
  right: TerminalTabPreferences
): boolean {
  if (left.version !== right.version || !areStringArraysEqual(left.order, right.order)) {
    return false;
  }

  const leftColors = Object.entries(left.colors);
  const rightColors = Object.entries(right.colors);
  if (leftColors.length !== rightColors.length) {
    return false;
  }

  return leftColors.every(([tabId, colorId]) => right.colors[tabId] === colorId);
}

export function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function isPrewarmedTerminalTab(tab: TerminalMuxTab): boolean {
  return tab.title?.trim() === PREWARMED_TERMINAL_TAB_TITLE;
}

export function normalizeTerminalUserTabTitle(title: string): string | null {
  const normalizedTitle = title.trim();
  return normalizedTitle && normalizedTitle !== PREWARMED_TERMINAL_TAB_TITLE
    ? normalizedTitle
    : null;
}

export function resolveTerminalTabContentState(
  snapshot: TerminalWorkspaceSnapshot,
  tab: TerminalMuxTab,
  commandRuns: readonly TerminalCommandRunPresentation[] = []
): TerminalTabContentState {
  const paneIds = collectPaneIds(tab.root);
  const focusedScreen = snapshot.attachedSession?.focused_screen ?? null;
  const attachedSessionId = snapshot.attachedSession?.session?.session_id ?? null;

  for (const paneId of paneIds) {
    if ((snapshot.drafts?.[paneId] ?? '').trim().length > 0) {
      return 'has-content';
    }
    if (
      attachedSessionId &&
      commandRuns.some(
        (run) =>
          run.sessionId === attachedSessionId &&
          run.paneId === paneId &&
          (run.status === 'running' || run.status === 'unknown')
      )
    ) {
      return 'has-content';
    }

    const historicalPane = snapshot.historicalPanes?.[paneId];
    if (
      historicalPane?.lines.some(hasVisibleTerminalText) ||
      historicalPane?.richLines?.some(hasRichTerminalLineContent)
    ) {
      return 'has-content';
    }

    if (
      focusedScreen?.pane_id === paneId &&
      (focusedScreen.surface.lines.some(hasRichTerminalLineContent) ||
        (focusedScreen.surface.progress?.state ?? 'inactive') !== 'inactive')
    ) {
      return 'has-content';
    }
  }

  // Screen and history projections cannot prove that the shell is idle. Direct
  // terminal input can start a long-running process and then clear both views
  // without producing a command-run event, so closing must stay conservative.
  return 'unknown';
}

function formatNewMuxTabTitle(tabNumber: number): string {
  return `Tab ${tabNumber}`;
}

function collectPaneIds(node: TerminalMuxPaneTreeNode): string[] {
  if (node.kind === 'leaf') {
    return [node.pane_id];
  }

  return [...collectPaneIds(node.first), ...collectPaneIds(node.second)];
}

function hasVisibleTerminalText(line: string): boolean {
  return line.length > 0;
}

function hasRichTerminalLineContent(line: {
  text: string;
  media?: readonly unknown[];
  semantic_marks?: readonly unknown[];
  side_effects?: readonly unknown[];
}): boolean {
  return (
    hasVisibleTerminalText(line.text) ||
    Boolean(line.media?.length) ||
    Boolean(line.semantic_marks?.length) ||
    Boolean(line.side_effects?.length)
  );
}
