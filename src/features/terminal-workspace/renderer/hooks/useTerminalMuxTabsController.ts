import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  persistTerminalTabPreferences,
  readStoredTerminalTabPreferences,
} from '../adapters/terminalTabPreferencesStorage';
import {
  areStringArraysEqual,
  areTerminalTabPreferencesEqual,
  normalizeTerminalTabPreferences,
  reorderTerminalTabsById,
  type TerminalMuxTab,
  type TerminalTabColorId,
  type TerminalTabDropIndicator,
  type TerminalTabPreferences,
  type TerminalWorkspaceSnapshot,
} from '../model/terminalTabPreferences';
import {
  createTerminalMuxTabsViewModel,
  resolveTerminalTabStripKeyboardIntent,
  type TerminalMuxTabsViewModel,
  type TerminalTabStripFocusTarget,
} from '../view-models/terminalMuxTabs';

import { type TerminalMuxCommands, useTerminalMuxTabLifecycle } from './useTerminalMuxTabLifecycle';
import { useTerminalTabPointerReorder } from './useTerminalTabPointerReorder';

import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';

export interface UseTerminalMuxTabsControllerOptions {
  commands: TerminalMuxCommands;
  placement: 'console' | 'sheet-header';
  settingsOpen: boolean;
  snapshot: TerminalWorkspaceSnapshot;
  teamName: string;
  onSettingsOpenChange?: (open: boolean) => void;
  onTabContentPendingChange?: (pending: boolean) => void;
}

export interface TerminalMuxTabsController {
  busy: boolean;
  cancelRenameTab: () => void;
  closeCandidate: TerminalMuxTab | null;
  commitRenameTab: () => Promise<void>;
  confirmCloseCandidate: () => Promise<void>;
  createTab: () => Promise<void>;
  dismissCloseCandidate: () => void;
  draggingTabId: string | null;
  dropIndicator: TerminalTabDropIndicator | null;
  editingTabId: string | null;
  editingTitle: string;
  endTabPointerDrag: (event?: ReactPointerEvent<HTMLDivElement>) => void;
  error: string | null;
  getTabDragOffsetX: (tabId: string) => number;
  handleSettingsTabKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  handleTabClick: (event: ReactMouseEvent<HTMLButtonElement>, tabId: string) => void;
  handleTabKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, tabId: string) => void;
  handleTabLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
  handleTabPointerDown: (event: ReactPointerEvent<HTMLDivElement>, tabId: string) => void;
  handleTabPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  handleTabPointerUp: (event: ReactPointerEvent<HTMLDivElement>, tabId: string) => void;
  pendingAction: string | null;
  registerTabButtonElement: (tabId: string, element: HTMLButtonElement | null) => void;
  registerTabElement: (tabId: string, element: HTMLDivElement | null) => void;
  renameInputRef: RefObject<HTMLInputElement | null>;
  requestCloseTab: (tab: TerminalMuxTab) => Promise<void>;
  setEditingTitle: (title: string) => void;
  setTabColor: (tabId: string, colorId: TerminalTabColorId) => void;
  settingsTabButtonRef: RefObject<HTMLButtonElement | null>;
  startRenameTab: (tab: TerminalMuxTab, label: string) => void;
  tabListElementRef: RefObject<HTMLDivElement | null>;
  viewModel: TerminalMuxTabsViewModel;
}

export function useTerminalMuxTabsController({
  commands,
  placement,
  settingsOpen,
  snapshot,
  teamName,
  onSettingsOpenChange,
  onTabContentPendingChange,
}: UseTerminalMuxTabsControllerOptions): TerminalMuxTabsController {
  const [tabPreferences, setTabPreferences] = useState<TerminalTabPreferences>(() =>
    readStoredTerminalTabPreferences(teamName)
  );
  const settingsTabButtonRef = useRef<HTMLButtonElement | null>(null);
  const tabButtonElementsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const viewModel = useMemo(
    () =>
      createTerminalMuxTabsViewModel({
        placement,
        preferences: tabPreferences,
        settingsOpen,
        snapshot,
      }),
    [placement, settingsOpen, snapshot, tabPreferences]
  );
  const lifecycle = useTerminalMuxTabLifecycle({
    activeSessionId: viewModel.activeSessionId,
    activeTabId: viewModel.activeTabId,
    activeVisibleTabId: viewModel.activeVisibleTabId,
    canCloseVisibleTabs: viewModel.canCloseVisibleTabs,
    canCreateTab: viewModel.canCreateTab,
    canFocusTab: viewModel.canFocusTab,
    canRenameTab: viewModel.canRenameTab,
    commands,
    orderedVisibleTabs: viewModel.orderedVisibleTabs,
    prewarmedTab: viewModel.prewarmedTab,
    snapshot,
    tabsCount: viewModel.tabsCount,
    visibleTabs: viewModel.visibleTabs,
    onSettingsOpenChange,
    onTabContentPendingChange,
  });
  const { busy, editingTabId, focusTab } = lifecycle;

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

  const reorderTabs = useCallback(
    ({
      placementMode,
      sourceTabId,
      targetTabId,
    }: Readonly<{
      placementMode: 'before' | 'after';
      sourceTabId: string;
      targetTabId: string;
    }>): void => {
      updateTabPreferences((current) => {
        const nextOrder = reorderTerminalTabsById(
          current.order,
          viewModel.visibleTabs,
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
    },
    [updateTabPreferences, viewModel.visibleTabs]
  );

  const pointerReorder = useTerminalTabPointerReorder({
    activeTabId: viewModel.activeTabId,
    canFocusTab: viewModel.canFocusTab,
    disabled: busy,
    editingTabId,
    orderedTabIds: viewModel.orderedVisibleTabIds,
    scopeKey: `${teamName}\u001f${viewModel.activeSessionId ?? ''}`,
    onRequestFocus: focusTab,
    onRequestReorder: reorderTabs,
  });

  useEffect(() => {
    setTabPreferences(readStoredTerminalTabPreferences(teamName));
  }, [teamName]);

  useEffect(() => {
    if (viewModel.visibleTabs.length === 0) {
      return;
    }
    updateTabPreferences((current) =>
      normalizeTerminalTabPreferences(current, viewModel.visibleTabs)
    );
  }, [updateTabPreferences, viewModel.visibleTabIdsKey, viewModel.visibleTabs]);

  const registerTabButtonElement = useCallback(
    (tabId: string, element: HTMLButtonElement | null): void => {
      if (element) {
        tabButtonElementsRef.current.set(tabId, element);
        return;
      }
      tabButtonElementsRef.current.delete(tabId);
    },
    []
  );

  const handleTabStripKeyDown = useCallback(
    (
      event: ReactKeyboardEvent<HTMLButtonElement>,
      currentTarget: TerminalTabStripFocusTarget
    ): void => {
      if (busy || editingTabId !== null || !viewModel.canFocusTab) {
        return;
      }
      const intent = resolveTerminalTabStripKeyboardIntent(
        event.key,
        currentTarget,
        viewModel.orderedVisibleTabIds,
        settingsOpen
      );
      if (!intent) {
        return;
      }

      event.preventDefault();
      if (intent.target.kind === 'settings') {
        settingsTabButtonRef.current?.focus();
        onSettingsOpenChange?.(true);
        return;
      }
      tabButtonElementsRef.current.get(intent.target.tabId)?.focus();
      void focusTab(intent.target.tabId);
    },
    [
      busy,
      editingTabId,
      focusTab,
      onSettingsOpenChange,
      settingsOpen,
      viewModel.canFocusTab,
      viewModel.orderedVisibleTabIds,
    ]
  );

  const handleTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, tabId: string): void => {
      handleTabStripKeyDown(event, { kind: 'terminal', tabId });
    },
    [handleTabStripKeyDown]
  );

  const handleSettingsTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
      handleTabStripKeyDown(event, { kind: 'settings' });
    },
    [handleTabStripKeyDown]
  );

  const setTabColor = useCallback(
    (tabId: string, colorId: TerminalTabColorId): void => {
      updateTabPreferences((current) => ({
        ...current,
        colors: {
          ...current.colors,
          [tabId]: colorId,
        },
      }));
    },
    [updateTabPreferences]
  );

  return {
    busy: lifecycle.busy,
    cancelRenameTab: lifecycle.cancelRenameTab,
    closeCandidate: lifecycle.closeCandidate,
    commitRenameTab: lifecycle.commitRenameTab,
    confirmCloseCandidate: lifecycle.confirmCloseCandidate,
    createTab: lifecycle.createTab,
    dismissCloseCandidate: lifecycle.dismissCloseCandidate,
    draggingTabId: pointerReorder.draggingTabId,
    dropIndicator: pointerReorder.dropIndicator,
    editingTabId: lifecycle.editingTabId,
    editingTitle: lifecycle.editingTitle,
    endTabPointerDrag: pointerReorder.endTabPointerDrag,
    error: lifecycle.error,
    getTabDragOffsetX: pointerReorder.getTabDragOffsetX,
    handleSettingsTabKeyDown,
    handleTabClick: pointerReorder.handleTabClick,
    handleTabKeyDown,
    handleTabLostPointerCapture: pointerReorder.handleTabLostPointerCapture,
    handleTabPointerDown: pointerReorder.handleTabPointerDown,
    handleTabPointerMove: pointerReorder.handleTabPointerMove,
    handleTabPointerUp: pointerReorder.handleTabPointerUp,
    pendingAction: lifecycle.pendingAction,
    registerTabButtonElement,
    registerTabElement: pointerReorder.registerTabElement,
    renameInputRef: lifecycle.renameInputRef,
    requestCloseTab: lifecycle.requestCloseTab,
    setEditingTitle: lifecycle.setEditingTitle,
    setTabColor,
    settingsTabButtonRef,
    startRenameTab: lifecycle.startRenameTab,
    tabListElementRef: pointerReorder.tabListElementRef,
    viewModel,
  };
}
