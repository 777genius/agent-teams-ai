import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { resolveTerminalTopologyControlState } from '@terminal-platform/workspace-react';

import {
  persistTerminalTabPreferences,
  readStoredTerminalTabPreferences,
} from '../adapters/terminalTabPreferencesStorage';
import {
  areStringArraysEqual,
  areTerminalTabPreferencesEqual,
  formatNextMuxTabTitle,
  hasTerminalTabHistory,
  isPrewarmedTerminalTab,
  normalizeTerminalTabPreferences,
  orderTerminalTabsByPreference,
  PREWARMED_TERMINAL_TAB_TITLE,
  reorderTerminalTabsById,
  resolveVisibleTabToFocusAfterClose,
  shouldIgnoreTerminalTabDragTarget,
  type TerminalMuxCommand,
  type TerminalMuxTab,
  type TerminalTabColorId,
  type TerminalTabDropIndicator,
  type TerminalTabPointerDrag,
  type TerminalTabPreferences,
  type TerminalWorkspaceSnapshot,
} from '../model/terminalTabPreferences';

import { renderTerminalMuxTabs } from './TerminalMuxTabsView';

import type { WorkspaceKernel } from '@terminal-platform/workspace-core';

export const TerminalMuxTabs = ({
  kernel,
  settingsOpen = false,
  snapshot,
  teamName,
  onSettingsOpenChange,
  onTabContentPendingChange,
  placement = 'console',
}: {
  kernel: WorkspaceKernel;
  settingsOpen?: boolean;
  snapshot: TerminalWorkspaceSnapshot;
  teamName: string;
  onSettingsOpenChange?: (open: boolean) => void;
  onTabContentPendingChange?: (pending: boolean) => void;
  placement?: 'console' | 'sheet-header';
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closeCandidate, setCloseCandidate] = useState<TerminalMuxTab | null>(null);
  const [tabPreferences, setTabPreferences] = useState<TerminalTabPreferences>(() =>
    readStoredTerminalTabPreferences(teamName)
  );
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<TerminalTabDropIndicator | null>(null);
  const [tabPointerDrag, setTabPointerDrag] = useState<TerminalTabPointerDrag | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const prewarmInFlightRef = useRef<string | null>(null);
  const prewarmFailedSessionRef = useRef<string | null>(null);
  const suppressNextTabClickRef = useRef(false);
  const tabListElementRef = useRef<HTMLDivElement | null>(null);
  const tabElementRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const tabPointerDragRef = useRef<TerminalTabPointerDrag | null>(null);
  const tabRectsBeforeReorderRef = useRef<Map<string, DOMRect> | null>(null);
  const topology = snapshot.attachedSession?.topology ?? null;
  const controls = resolveTerminalTopologyControlState(snapshot);
  const tabs = topology?.tabs ?? [];
  const visibleTabs = tabs.filter((tab) => !isPrewarmedTerminalTab(tab));
  const visibleTabIdsKey = visibleTabs.map((tab) => tab.tab_id).join('\u001f');
  const orderedVisibleTabs = useMemo(
    () => orderTerminalTabsByPreference(visibleTabs, tabPreferences.order),
    [tabPreferences.order, visibleTabs]
  );
  const orderedVisibleTabIdsKey = orderedVisibleTabs.map((tab) => tab.tab_id).join('\u001f');
  const prewarmedTab = tabs.find(isPrewarmedTerminalTab) ?? null;
  const prewarmedTabId = prewarmedTab?.tab_id ?? null;
  const activeSessionId = controls.activeSessionId;
  const activeTabId =
    controls.activeTab?.tab_id ?? topology?.focused_tab ?? tabs[0]?.tab_id ?? null;
  const activeVisibleTabId = visibleTabs.some((tab) => tab.tab_id === activeTabId)
    ? activeTabId
    : (visibleTabs[0]?.tab_id ?? null);
  const busy = pendingAction !== null;
  const headerPlacement = placement === 'sheet-header';
  const canCloseVisibleTabs = controls.canCloseTab && visibleTabs.length > 1;

  const setTabPointerDragState = useCallback((nextDrag: TerminalTabPointerDrag | null): void => {
    tabPointerDragRef.current = nextDrag;
    setTabPointerDrag(nextDrag);
  }, []);

  const updateTabPreferences = useCallback(
    (updater: (current: TerminalTabPreferences) => TerminalTabPreferences): void => {
      setTabPreferences((current) => {
        const next = updater(current);
        if (areTerminalTabPreferencesEqual(current, next)) {
          return current;
        }
        persistTerminalTabPreferences(teamName, next);
        return next;
      });
    },
    [teamName]
  );

  const registerTabElement = useCallback((tabId: string, element: HTMLDivElement | null): void => {
    if (element) {
      tabElementRefs.current.set(tabId, element);
      return;
    }

    tabElementRefs.current.delete(tabId);
  }, []);

  const prefersReducedMotion = useCallback(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    []
  );

  const captureTabRectsBeforeReorder = useCallback((): void => {
    if (prefersReducedMotion()) {
      tabRectsBeforeReorderRef.current = null;
      return;
    }

    const rects = new Map<string, DOMRect>();
    tabElementRefs.current.forEach((element, tabId) => {
      rects.set(tabId, element.getBoundingClientRect());
    });
    tabRectsBeforeReorderRef.current = rects.size > 1 ? rects : null;
  }, [prefersReducedMotion]);

  useLayoutEffect(() => {
    const previousRects = tabRectsBeforeReorderRef.current;
    if (!previousRects || prefersReducedMotion()) {
      tabRectsBeforeReorderRef.current = null;
      return;
    }

    tabRectsBeforeReorderRef.current = null;
    tabElementRefs.current.forEach((element, tabId) => {
      if (tabId === draggingTabId) {
        return;
      }

      const previousRect = previousRects.get(tabId);
      if (!previousRect) {
        return;
      }

      const nextRect = element.getBoundingClientRect();
      const deltaX = previousRect.left - nextRect.left;
      const deltaY = previousRect.top - nextRect.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) {
        return;
      }

      if (typeof element.animate !== 'function') {
        return;
      }

      element.getAnimations?.().forEach((animation) => animation.cancel());
      element.animate(
        [{ transform: `translate(${deltaX}px, ${deltaY}px)` }, { transform: 'translate(0, 0)' }],
        {
          duration: 180,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        }
      );
    });
  }, [draggingTabId, orderedVisibleTabIdsKey, prefersReducedMotion]);

  const runMuxCommands = async (
    actionId: string,
    commands: readonly TerminalMuxCommand[]
  ): Promise<void> => {
    if (busy || !activeSessionId) {
      return;
    }

    const tabContentPending =
      actionId.startsWith('focus-tab:') || actionId === 'activate-prewarmed-tab';
    setPendingAction(actionId);
    setError(null);
    if (tabContentPending) {
      onTabContentPendingChange?.(true);
    }
    try {
      for (const command of commands) {
        await kernel.commands.dispatchMuxCommand(activeSessionId, command);
      }
      await kernel.commands.attachSession(activeSessionId);
    } catch (reason: unknown) {
      setError(getErrorMessage(reason));
    } finally {
      setPendingAction(null);
      if (tabContentPending) {
        onTabContentPendingChange?.(false);
      }
    }
  };

  const runMuxCommand = async (actionId: string, command: TerminalMuxCommand): Promise<void> => {
    await runMuxCommands(actionId, [command]);
  };

  useEffect(() => {
    setTabPreferences(readStoredTerminalTabPreferences(teamName));
  }, [teamName]);

  useEffect(
    () => () => {
      onTabContentPendingChange?.(false);
    },
    [onTabContentPendingChange]
  );

  useEffect(() => {
    if (visibleTabs.length === 0) {
      return;
    }

    updateTabPreferences((current) => normalizeTerminalTabPreferences(current, visibleTabs));
  }, [updateTabPreferences, visibleTabIdsKey, visibleTabs]);

  useEffect(() => {
    if (!editingTabId) {
      return undefined;
    }

    const frame = window.requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [editingTabId]);

  const focusTab = async (tabId: string): Promise<void> => {
    onSettingsOpenChange?.(false);
    if (!controls.canFocusTab || tabId === activeTabId) {
      return;
    }

    await runMuxCommand(`focus-tab:${tabId}`, { kind: 'focus_tab', tab_id: tabId });
  };

  const createTab = async (): Promise<void> => {
    if (!controls.canCreateTab) {
      return;
    }

    onSettingsOpenChange?.(false);
    const nextTabTitle = formatNextMuxTabTitle(visibleTabs);

    if (prewarmedTab && controls.canFocusTab && controls.canRenameTab) {
      await runMuxCommands('activate-prewarmed-tab', [
        {
          kind: 'rename_tab',
          tab_id: prewarmedTab.tab_id,
          title: nextTabTitle,
        },
        { kind: 'focus_tab', tab_id: prewarmedTab.tab_id },
      ]);
      return;
    }

    await runMuxCommand('new-tab', {
      kind: 'new_tab',
      title: nextTabTitle,
    });
  };

  const closeTab = async (tab: TerminalMuxTab): Promise<void> => {
    if (!canCloseVisibleTabs || isPrewarmedTerminalTab(tab)) {
      return;
    }

    const tabToFocusAfterClose =
      controls.canFocusTab && tab.tab_id === activeVisibleTabId
        ? resolveVisibleTabToFocusAfterClose(orderedVisibleTabs, tab.tab_id)
        : null;
    const commands: TerminalMuxCommand[] = [{ kind: 'close_tab', tab_id: tab.tab_id }];

    if (tabToFocusAfterClose) {
      commands.push({ kind: 'focus_tab', tab_id: tabToFocusAfterClose });
    }

    await runMuxCommands(`close-tab:${tab.tab_id}`, commands);
  };

  const requestCloseTab = async (tab: TerminalMuxTab): Promise<void> => {
    if (!canCloseVisibleTabs || busy || isPrewarmedTerminalTab(tab)) {
      return;
    }

    if (hasTerminalTabHistory(snapshot, tab)) {
      setCloseCandidate(tab);
      return;
    }

    await closeTab(tab);
  };

  const startRenameTab = (tab: TerminalMuxTab, label: string): void => {
    if (!controls.canRenameTab || busy || isPrewarmedTerminalTab(tab)) {
      return;
    }

    setEditingTabId(tab.tab_id);
    setEditingTitle(tab.title?.trim() || label);
  };

  const cancelRenameTab = (): void => {
    setEditingTabId(null);
    setEditingTitle('');
  };

  const commitRenameTab = async (): Promise<void> => {
    const tabId = editingTabId;
    const title = editingTitle.trim();
    const tab = visibleTabs.find((candidate) => candidate.tab_id === tabId);
    if (!tabId || !tab || !title) {
      cancelRenameTab();
      return;
    }

    cancelRenameTab();
    if (title === (tab.title?.trim() || '')) {
      return;
    }

    await runMuxCommand(`rename-tab:${tab.tab_id}`, {
      kind: 'rename_tab',
      tab_id: tab.tab_id,
      title,
    });
  };

  const setTabColor = (tabId: string, colorId: TerminalTabColorId): void => {
    updateTabPreferences((current) => ({
      ...current,
      colors: {
        ...current.colors,
        [tabId]: colorId,
      },
    }));
  };

  const reorderTabs = (
    sourceTabId: string,
    targetTabId: string,
    placementMode: 'before' | 'after'
  ): void => {
    if (sourceTabId === targetTabId) {
      return;
    }

    captureTabRectsBeforeReorder();
    updateTabPreferences((current) => {
      const nextOrder = reorderTerminalTabsById(
        current.order,
        visibleTabs,
        sourceTabId,
        targetTabId,
        placementMode
      );
      if (areStringArraysEqual(current.order, nextOrder)) {
        return current;
      }
      return {
        ...current,
        order: nextOrder,
      };
    });
  };

  const getTabReorderTarget = useCallback(
    (sourceTabId: string, clientX: number): TerminalTabDropIndicator | null => {
      const candidates = orderedVisibleTabs
        .filter((tab) => tab.tab_id !== sourceTabId)
        .map((tab) => {
          const element = tabElementRefs.current.get(tab.tab_id);
          const rect = element?.getBoundingClientRect();
          return rect
            ? {
                centerX: rect.left + rect.width / 2,
                left: rect.left,
                tabId: tab.tab_id,
              }
            : null;
        })
        .filter(
          (
            candidate
          ): candidate is {
            centerX: number;
            left: number;
            tabId: string;
          } => candidate !== null
        )
        .sort((left, right) => left.left - right.left);

      if (candidates.length === 0) {
        return null;
      }

      const beforeCandidate = candidates.find((candidate) => clientX < candidate.centerX);
      if (beforeCandidate) {
        return { placementMode: 'before', tabId: beforeCandidate.tabId };
      }

      return { placementMode: 'after', tabId: candidates[candidates.length - 1].tabId };
    },
    [orderedVisibleTabs]
  );

  const endTabPointerDrag = useCallback(
    (event?: React.PointerEvent<HTMLDivElement>): void => {
      const activeDrag = tabPointerDragRef.current;
      if (event && activeDrag?.pointerId !== event.pointerId) {
        return;
      }

      if (event && activeDrag?.active) {
        event.preventDefault();
      }

      if (event) {
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          // Pointer capture can already be released by the browser.
        }
      }

      setTabPointerDragState(null);
      setDraggingTabId(null);
      setDropIndicator(null);
      tabRectsBeforeReorderRef.current = null;
      window.setTimeout(() => {
        suppressNextTabClickRef.current = false;
      }, 0);
    },
    [setTabPointerDragState]
  );

  const handleTabPointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
    tab: TerminalMuxTab
  ): void => {
    const target = event.target;
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      editingTabId === tab.tab_id ||
      busy ||
      (target instanceof HTMLElement && shouldIgnoreTerminalTabDragTarget(target))
    ) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    setTabPointerDragState({
      active: false,
      grabOffsetX: event.clientX - rect.left,
      offsetX: 0,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      tabId: tab.tab_id,
    });
    setDropIndicator(null);

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Some test environments do not implement pointer capture.
    }
  };

  const handleTabPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const activeDrag = tabPointerDragRef.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - activeDrag.startClientX;
    const deltaY = event.clientY - activeDrag.startClientY;
    const shouldStartDrag =
      activeDrag.active || (Math.abs(deltaX) >= 4 && Math.abs(deltaX) >= Math.abs(deltaY));
    if (!shouldStartDrag) {
      return;
    }

    event.preventDefault();
    suppressNextTabClickRef.current = true;
    setDraggingTabId(activeDrag.tabId);

    const element = tabElementRefs.current.get(activeDrag.tabId);
    const rect = element?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    const baseLeft = rect.left - activeDrag.offsetX;
    const tabListRect = tabListElementRef.current?.getBoundingClientRect();
    const unclampedLeft = event.clientX - activeDrag.grabOffsetX;
    const clampedLeft = tabListRect
      ? Math.min(
          Math.max(unclampedLeft, tabListRect.left),
          Math.max(tabListRect.left, tabListRect.right - rect.width)
        )
      : unclampedLeft;
    const nextDrag = {
      ...activeDrag,
      active: true,
      offsetX: clampedLeft - baseLeft,
    };

    setTabPointerDragState(nextDrag);

    const reorderTarget = getTabReorderTarget(activeDrag.tabId, event.clientX);
    if (!reorderTarget) {
      setDropIndicator(null);
      return;
    }

    const nextOrder = reorderTerminalTabsById(
      tabPreferences.order,
      visibleTabs,
      activeDrag.tabId,
      reorderTarget.tabId,
      reorderTarget.placementMode
    );
    if (
      areStringArraysEqual(
        orderedVisibleTabs.map((tab) => tab.tab_id),
        nextOrder
      )
    ) {
      setDropIndicator(null);
      return;
    }

    setDropIndicator((current) =>
      current?.tabId === reorderTarget.tabId &&
      current.placementMode === reorderTarget.placementMode
        ? current
        : reorderTarget
    );
    reorderTabs(activeDrag.tabId, reorderTarget.tabId, reorderTarget.placementMode);
  };

  const handleTabPointerUp = (
    event: React.PointerEvent<HTMLDivElement>,
    tab: TerminalMuxTab
  ): void => {
    const activeDrag = tabPointerDragRef.current;
    const shouldFocusTab =
      activeDrag?.pointerId === event.pointerId &&
      activeDrag.tabId === tab.tab_id &&
      controls.canFocusTab &&
      tab.tab_id !== activeTabId &&
      !busy;

    if (shouldFocusTab) {
      suppressNextTabClickRef.current = true;
      void focusTab(tab.tab_id);
    }

    endTabPointerDrag(event);
  };

  useEffect(() => {
    if (
      !activeSessionId ||
      !activeVisibleTabId ||
      !controls.canFocusTab ||
      busy ||
      prewarmedTabId === null ||
      activeTabId !== prewarmedTabId
    ) {
      return;
    }

    const restoreKey = `${activeSessionId}:restore:${prewarmedTabId}:${activeVisibleTabId}`;
    if (prewarmInFlightRef.current === restoreKey) {
      return;
    }

    prewarmInFlightRef.current = restoreKey;
    void (async () => {
      try {
        await kernel.commands.dispatchMuxCommand(activeSessionId, {
          kind: 'focus_tab',
          tab_id: activeVisibleTabId,
        });
        await kernel.commands.attachSession(activeSessionId);
      } finally {
        if (prewarmInFlightRef.current === restoreKey) {
          prewarmInFlightRef.current = null;
        }
      }
    })();
  }, [
    activeSessionId,
    activeTabId,
    activeVisibleTabId,
    busy,
    controls.canFocusTab,
    kernel,
    prewarmedTabId,
  ]);

  useEffect(() => {
    if (
      !activeSessionId ||
      !activeVisibleTabId ||
      !controls.canCreateTab ||
      !controls.canFocusTab ||
      busy ||
      prewarmedTabId !== null ||
      prewarmFailedSessionRef.current === activeSessionId
    ) {
      return;
    }

    const prewarmKey = `${activeSessionId}:prewarm:${activeVisibleTabId}:${tabs.length}`;
    if (prewarmInFlightRef.current === prewarmKey) {
      return;
    }

    prewarmInFlightRef.current = prewarmKey;
    void (async () => {
      try {
        await kernel.commands.dispatchMuxCommand(activeSessionId, {
          kind: 'new_tab',
          title: PREWARMED_TERMINAL_TAB_TITLE,
        });
        await kernel.commands.attachSession(activeSessionId);
        await kernel.commands.dispatchMuxCommand(activeSessionId, {
          kind: 'focus_tab',
          tab_id: activeVisibleTabId,
        });
        await kernel.commands.attachSession(activeSessionId);
        prewarmFailedSessionRef.current = null;
      } catch {
        prewarmFailedSessionRef.current = activeSessionId;
      } finally {
        if (prewarmInFlightRef.current === prewarmKey) {
          prewarmInFlightRef.current = null;
        }
      }
    })();
  }, [
    activeSessionId,
    activeVisibleTabId,
    busy,
    controls.canCreateTab,
    controls.canFocusTab,
    kernel,
    prewarmedTabId,
    tabs.length,
  ]);

  return renderTerminalMuxTabs({
    t,
    headerPlacement,
    visibleTabs,
    orderedVisibleTabs,
    tabPreferences,
    settingsOpen,
    activeVisibleTabId,
    pendingAction,
    canCloseVisibleTabs,
    editingTabId,
    editingTitle,
    draggingTabId,
    dropIndicator,
    tabPointerDrag,
    busy,
    error,
    closeCandidate,
    controls,
    tabListElementRef,
    renameInputRef,
    registerTabElement,
    endTabPointerDrag,
    handleTabPointerDown,
    handleTabPointerMove,
    handleTabPointerUp,
    suppressNextTabClickRef,
    focusTab,
    startRenameTab,
    commitRenameTab,
    setEditingTitle,
    cancelRenameTab,
    requestCloseTab,
    setTabColor,
    onSettingsOpenChange,
    createTab,
    setCloseCandidate,
    closeTab,
  });
};

function getErrorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
