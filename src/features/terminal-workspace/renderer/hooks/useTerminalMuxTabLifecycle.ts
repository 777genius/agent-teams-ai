import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  planCloseTerminalTab,
  planCreateTerminalTab,
  planFocusTerminalTab,
  planRenameTerminalTab,
  type TerminalMuxActionPlan,
  type TerminalMuxCommand,
} from '../model/terminalMuxActionPlans';
import {
  PREWARMED_TERMINAL_TAB_TITLE,
  resolveTerminalTabContentState,
  resolveVisibleTabToFocusAfterClose,
  type TerminalMuxTab,
  type TerminalWorkspaceSnapshot,
} from '../model/terminalTabPreferences';

import type { TerminalCommandRunPresentation } from '../model/terminalCommandRuns';
import type { WorkspaceKernel } from '@terminal-platform/workspace-core';

export type TerminalMuxCommands = Pick<
  WorkspaceKernel['commands'],
  'attachSession' | 'dispatchMuxCommand'
>;

export interface TerminalMuxTabCloseDispatch {
  closedTabId: string;
  preferredFocusTabId: string | null;
  willDispatchPreferredFocus: boolean;
}

export interface TerminalMuxTabCloseFocusSettlement {
  changed: boolean;
  closedTabId: string;
  focusTabId: string;
}

interface UseTerminalMuxTabLifecycleOptions {
  activeSessionId: string | null;
  activeTabId: string | null;
  activeVisibleTabId: string | null;
  canCloseVisibleTabs: boolean;
  canCreateTab: boolean;
  canFocusTab: boolean;
  canRenameTab: boolean;
  commandRuns: readonly TerminalCommandRunPresentation[];
  commands: TerminalMuxCommands;
  orderedVisibleTabs: readonly TerminalMuxTab[];
  prewarmedTab: TerminalMuxTab | null;
  snapshot: TerminalWorkspaceSnapshot;
  tabsCount: number;
  visibleTabs: readonly TerminalMuxTab[];
  onSettingsOpenChange?: (open: boolean) => void;
  onTabCloseDispatched?: (dispatch: TerminalMuxTabCloseDispatch) => void;
  onTabCloseFocusSettled?: (settlement: TerminalMuxTabCloseFocusSettlement) => void;
  onTabContentPendingChange?: (pending: boolean) => void;
}

interface UseTerminalMuxTabLifecycleResult {
  busy: boolean;
  cancelRenameTab: () => void;
  closeCandidate: TerminalMuxTab | null;
  commitRenameTab: () => Promise<void>;
  confirmCloseCandidate: () => Promise<void>;
  createTab: () => Promise<void>;
  dismissCloseCandidate: () => void;
  editingTabId: string | null;
  editingTitle: string;
  error: string | null;
  focusTab: (tabId: string) => Promise<void>;
  pendingAction: string | null;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  requestCloseTab: (tab: TerminalMuxTab) => Promise<void>;
  setEditingTitle: (title: string) => void;
  startRenameTab: (tab: TerminalMuxTab, label: string) => void;
}

interface LifecycleScope {
  activeSessionId: string | null;
  commands: TerminalMuxCommands;
  epoch: number;
}

interface LifecycleOperationToken {
  activeSessionId: string;
  commands: TerminalMuxCommands;
  key: string;
  scopeEpoch: number;
  serial: number;
}

interface LifecycleViewState {
  closeCandidate: TerminalMuxTab | null;
  editingTabId: string | null;
  editingTitle: string;
  error: string | null;
  pendingAction: string | null;
  scopeEpoch: number;
}

interface PendingContentLease {
  callback: ((pending: boolean) => void) | undefined;
  token: LifecycleOperationToken;
}

interface PrewarmFailures {
  keys: Set<string>;
  scopeEpoch: number;
}

export function useTerminalMuxTabLifecycle({
  activeSessionId,
  activeTabId,
  activeVisibleTabId,
  canCloseVisibleTabs,
  canCreateTab,
  canFocusTab,
  canRenameTab,
  commandRuns,
  commands,
  orderedVisibleTabs,
  prewarmedTab,
  snapshot,
  tabsCount,
  visibleTabs,
  onSettingsOpenChange,
  onTabCloseDispatched,
  onTabCloseFocusSettled,
  onTabContentPendingChange,
}: UseTerminalMuxTabLifecycleOptions): UseTerminalMuxTabLifecycleResult {
  const mountedRef = useRef(true);
  const operationSerialRef = useRef(0);
  const scopeRef = useRef<LifecycleScope>({
    activeSessionId,
    commands,
    epoch: 0,
  });
  const foregroundOperationRef = useRef<LifecycleOperationToken | null>(null);
  const backgroundOperationRef = useRef<LifecycleOperationToken | null>(null);
  const pendingContentLeaseRef = useRef<PendingContentLease | null>(null);
  const prewarmFailuresRef = useRef<PrewarmFailures>({
    keys: new Set(),
    scopeEpoch: 0,
  });
  const renderedScopeIsCurrent =
    scopeRef.current.activeSessionId === activeSessionId && scopeRef.current.commands === commands;
  const scopeEpoch = scopeRef.current.epoch + (renderedScopeIsCurrent ? 0 : 1);
  const [viewState, setViewState] = useState<LifecycleViewState>(() =>
    createInitialViewState(scopeEpoch)
  );
  const currentViewState =
    renderedScopeIsCurrent && viewState.scopeEpoch === scopeEpoch
      ? viewState
      : createInitialViewState(scopeEpoch);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const prewarmedTabId = prewarmedTab?.tab_id ?? null;
  const busy = currentViewState.pendingAction !== null;

  const updateViewStateForEpoch = useCallback(
    (
      targetScopeEpoch: number,
      update: (current: LifecycleViewState) => LifecycleViewState
    ): void => {
      setViewState((current) => {
        if (scopeRef.current.epoch !== targetScopeEpoch) {
          return current;
        }
        return update(
          current.scopeEpoch === targetScopeEpoch
            ? current
            : createInitialViewState(targetScopeEpoch)
        );
      });
    },
    []
  );

  const releasePendingContentLease = useCallback((token?: LifecycleOperationToken): void => {
    const lease = pendingContentLeaseRef.current;
    if (!lease || (token && lease.token !== token)) {
      return;
    }

    pendingContentLeaseRef.current = null;
    lease.callback?.(false);
  }, []);

  useLayoutEffect(() => {
    if (
      scopeRef.current.activeSessionId === activeSessionId &&
      scopeRef.current.commands === commands
    ) {
      return;
    }

    scopeRef.current = { activeSessionId, commands, epoch: scopeEpoch };
    foregroundOperationRef.current = null;
    backgroundOperationRef.current = null;
    prewarmFailuresRef.current = { keys: new Set(), scopeEpoch };
    releasePendingContentLease();
    setViewState((current) =>
      current.scopeEpoch === scopeEpoch ? current : createInitialViewState(scopeEpoch)
    );
  }, [activeSessionId, commands, releasePendingContentLease, scopeEpoch]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      foregroundOperationRef.current = null;
      backgroundOperationRef.current = null;
      releasePendingContentLease();
    };
  }, [releasePendingContentLease]);

  const isTokenInCurrentScope = useCallback((token: LifecycleOperationToken): boolean => {
    const scope = scopeRef.current;
    return (
      mountedRef.current &&
      token.scopeEpoch === scope.epoch &&
      token.activeSessionId === scope.activeSessionId &&
      token.commands === scope.commands
    );
  }, []);

  const isForegroundOperationCurrent = useCallback(
    (token: LifecycleOperationToken): boolean =>
      foregroundOperationRef.current === token && isTokenInCurrentScope(token),
    [isTokenInCurrentScope]
  );

  const isBackgroundOperationCurrent = useCallback(
    (token: LifecycleOperationToken): boolean =>
      backgroundOperationRef.current === token && isTokenInCurrentScope(token),
    [isTokenInCurrentScope]
  );

  const createOperationToken = useCallback((key: string): LifecycleOperationToken | null => {
    const scope = scopeRef.current;
    if (!scope.activeSessionId) {
      return null;
    }

    operationSerialRef.current += 1;
    return {
      activeSessionId: scope.activeSessionId,
      commands: scope.commands,
      key,
      scopeEpoch: scope.epoch,
      serial: operationSerialRef.current,
    };
  }, []);

  const runMuxAction = useCallback(
    async (
      plan: TerminalMuxActionPlan,
      onCommandSettled?: (command: TerminalMuxCommand, changed: boolean) => void
    ): Promise<void> => {
      if (!renderedScopeIsCurrent || foregroundOperationRef.current) {
        return;
      }

      const token = createOperationToken(plan.actionId);
      if (!token) {
        return;
      }

      backgroundOperationRef.current = null;
      foregroundOperationRef.current = token;
      const tabContentPending =
        plan.actionId.startsWith('focus-tab:') || plan.actionId === 'activate-prewarmed-tab';

      updateViewStateForEpoch(token.scopeEpoch, (current) => ({
        ...current,
        error: null,
        pendingAction: plan.actionId,
      }));

      if (tabContentPending) {
        releasePendingContentLease();
        pendingContentLeaseRef.current = {
          callback: onTabContentPendingChange,
          token,
        };
        onTabContentPendingChange?.(true);
      }

      try {
        for (const command of plan.commands) {
          if (!isForegroundOperationCurrent(token)) {
            return;
          }
          const result = await token.commands.dispatchMuxCommand(token.activeSessionId, command);
          if (!isForegroundOperationCurrent(token)) {
            return;
          }
          onCommandSettled?.(command, result.changed);
          if (command.kind === 'close_tab' && !result.changed) {
            break;
          }
        }

        await token.commands.attachSession(token.activeSessionId);
      } catch (reason: unknown) {
        if (isForegroundOperationCurrent(token)) {
          updateViewStateForEpoch(token.scopeEpoch, (current) => ({
            ...current,
            error: getErrorMessage(reason),
          }));
        }
      } finally {
        releasePendingContentLease(token);
        if (foregroundOperationRef.current === token) {
          foregroundOperationRef.current = null;
          if (isTokenInCurrentScope(token)) {
            updateViewStateForEpoch(token.scopeEpoch, (current) => ({
              ...current,
              pendingAction: null,
            }));
          }
        }
      }
    },
    [
      createOperationToken,
      isForegroundOperationCurrent,
      isTokenInCurrentScope,
      onTabContentPendingChange,
      renderedScopeIsCurrent,
      releasePendingContentLease,
      updateViewStateForEpoch,
    ]
  );

  useEffect(() => {
    if (!currentViewState.editingTabId) {
      return undefined;
    }

    const frame = window.requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [currentViewState.editingTabId]);

  const focusTab = useCallback(
    async (tabId: string): Promise<void> => {
      onSettingsOpenChange?.(false);
      const plan = planFocusTerminalTab(tabId, activeTabId, canFocusTab);
      if (plan) {
        await runMuxAction(plan);
      }
    },
    [activeTabId, canFocusTab, onSettingsOpenChange, runMuxAction]
  );

  const createTab = useCallback(async (): Promise<void> => {
    const plan = planCreateTerminalTab({
      canCreateTab,
      canFocusTab,
      canRenameTab,
      prewarmedTab,
      visibleTabs,
    });
    if (!plan) {
      return;
    }

    onSettingsOpenChange?.(false);
    await runMuxAction(plan);
  }, [
    canCreateTab,
    canFocusTab,
    canRenameTab,
    onSettingsOpenChange,
    prewarmedTab,
    runMuxAction,
    visibleTabs,
  ]);

  const closeTab = useCallback(
    async (tab: TerminalMuxTab): Promise<void> => {
      const plan = planCloseTerminalTab({
        activeVisibleTabId,
        canCloseVisibleTabs,
        canFocusTab,
        orderedVisibleTabs,
        tab,
      });
      if (!plan) {
        return;
      }

      const targetScopeEpoch = scopeRef.current.epoch;
      const preferredFocusTabId = resolveVisibleTabToFocusAfterClose(
        orderedVisibleTabs,
        tab.tab_id
      );
      const willDispatchPreferredFocus = plan.commands.some(
        (command) => command.kind === 'focus_tab' && command.tab_id === preferredFocusTabId
      );
      await runMuxAction(plan, (command, changed) => {
        if (
          changed &&
          command.kind === 'close_tab' &&
          command.tab_id === tab.tab_id &&
          mountedRef.current &&
          scopeRef.current.epoch === targetScopeEpoch
        ) {
          onTabCloseDispatched?.({
            closedTabId: tab.tab_id,
            preferredFocusTabId,
            willDispatchPreferredFocus,
          });
          return;
        }
        if (
          command.kind === 'focus_tab' &&
          command.tab_id === preferredFocusTabId &&
          mountedRef.current &&
          scopeRef.current.epoch === targetScopeEpoch
        ) {
          onTabCloseFocusSettled?.({
            changed,
            closedTabId: tab.tab_id,
            focusTabId: command.tab_id,
          });
        }
      });
    },
    [
      activeVisibleTabId,
      canCloseVisibleTabs,
      canFocusTab,
      onTabCloseDispatched,
      onTabCloseFocusSettled,
      orderedVisibleTabs,
      runMuxAction,
    ]
  );

  const requestCloseTab = useCallback(
    async (tab: TerminalMuxTab): Promise<void> => {
      if (!canCloseVisibleTabs || foregroundOperationRef.current || prewarmedTabId === tab.tab_id) {
        return;
      }

      if (resolveTerminalTabContentState(snapshot, tab, commandRuns) !== 'empty') {
        const targetScopeEpoch = scopeRef.current.epoch;
        updateViewStateForEpoch(targetScopeEpoch, (current) => ({
          ...current,
          closeCandidate: tab,
        }));
        return;
      }

      await closeTab(tab);
    },
    [canCloseVisibleTabs, closeTab, commandRuns, prewarmedTabId, snapshot, updateViewStateForEpoch]
  );

  const dismissCloseCandidate = useCallback((): void => {
    const targetScopeEpoch = scopeRef.current.epoch;
    updateViewStateForEpoch(targetScopeEpoch, (current) => ({
      ...current,
      closeCandidate: null,
    }));
  }, [updateViewStateForEpoch]);

  const confirmCloseCandidate = useCallback(async (): Promise<void> => {
    const tab = viewState.scopeEpoch === scopeRef.current.epoch ? viewState.closeCandidate : null;
    dismissCloseCandidate();
    if (tab) {
      await closeTab(tab);
    }
  }, [closeTab, dismissCloseCandidate, viewState]);

  const startRenameTab = useCallback(
    (tab: TerminalMuxTab, label: string): void => {
      if (!canRenameTab || foregroundOperationRef.current || prewarmedTabId === tab.tab_id) {
        return;
      }

      const targetScopeEpoch = scopeRef.current.epoch;
      updateViewStateForEpoch(targetScopeEpoch, (current) => ({
        ...current,
        editingTabId: tab.tab_id,
        editingTitle: tab.title?.trim() || label,
      }));
    },
    [canRenameTab, prewarmedTabId, updateViewStateForEpoch]
  );

  const cancelRenameTab = useCallback((): void => {
    const targetScopeEpoch = scopeRef.current.epoch;
    updateViewStateForEpoch(targetScopeEpoch, (current) => ({
      ...current,
      editingTabId: null,
      editingTitle: '',
    }));
  }, [updateViewStateForEpoch]);

  const setEditingTitle = useCallback(
    (title: string): void => {
      const targetScopeEpoch = scopeRef.current.epoch;
      updateViewStateForEpoch(targetScopeEpoch, (current) => ({
        ...current,
        editingTitle: title,
      }));
    },
    [updateViewStateForEpoch]
  );

  const commitRenameTab = useCallback(async (): Promise<void> => {
    const current =
      viewState.scopeEpoch === scopeRef.current.epoch
        ? viewState
        : createInitialViewState(scopeRef.current.epoch);
    const tab = visibleTabs.find((candidate) => candidate.tab_id === current.editingTabId);
    const plan = tab ? planRenameTerminalTab(tab, current.editingTitle) : null;
    cancelRenameTab();
    if (plan) {
      await runMuxAction(plan);
    }
  }, [cancelRenameTab, runMuxAction, viewState, visibleTabs]);

  const startBackgroundOperation = useCallback(
    (key: string): LifecycleOperationToken | null => {
      if (foregroundOperationRef.current || backgroundOperationRef.current) {
        return null;
      }

      const token = createOperationToken(key);
      if (token) {
        backgroundOperationRef.current = token;
      }
      return token;
    },
    [createOperationToken]
  );

  const cancelBackgroundOperation = useCallback((token: LifecycleOperationToken): void => {
    if (backgroundOperationRef.current === token) {
      backgroundOperationRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (
      !renderedScopeIsCurrent ||
      !activeSessionId ||
      !activeVisibleTabId ||
      !canFocusTab ||
      busy ||
      prewarmedTabId === null ||
      activeTabId !== prewarmedTabId
    ) {
      return undefined;
    }

    const token = startBackgroundOperation(`restore:${prewarmedTabId}:${activeVisibleTabId}`);
    if (!token) {
      return undefined;
    }

    void (async () => {
      try {
        await Promise.resolve();
        if (!isBackgroundOperationCurrent(token)) {
          return;
        }
        await token.commands.dispatchMuxCommand(token.activeSessionId, {
          kind: 'focus_tab',
          tab_id: activeVisibleTabId,
        });
        if (!isBackgroundOperationCurrent(token)) {
          return;
        }
        await token.commands.attachSession(token.activeSessionId);
      } catch {
        // A restore is opportunistic. The next topology update can safely retry it.
      } finally {
        cancelBackgroundOperation(token);
      }
    })();

    return () => cancelBackgroundOperation(token);
  }, [
    activeSessionId,
    activeTabId,
    activeVisibleTabId,
    busy,
    canFocusTab,
    cancelBackgroundOperation,
    isBackgroundOperationCurrent,
    prewarmedTabId,
    renderedScopeIsCurrent,
    startBackgroundOperation,
  ]);

  useEffect(() => {
    if (
      !renderedScopeIsCurrent ||
      !activeSessionId ||
      !activeVisibleTabId ||
      !canCreateTab ||
      !canFocusTab ||
      busy ||
      prewarmedTabId !== null
    ) {
      return undefined;
    }

    const prewarmKey = `prewarm:${activeVisibleTabId}:${tabsCount}`;
    const failures = prewarmFailuresRef.current;
    if (failures.scopeEpoch === scopeEpoch && failures.keys.has(prewarmKey)) {
      return undefined;
    }

    const token = startBackgroundOperation(prewarmKey);
    if (!token) {
      return undefined;
    }

    void (async () => {
      try {
        await Promise.resolve();
        if (!isBackgroundOperationCurrent(token)) {
          return;
        }
        await token.commands.dispatchMuxCommand(token.activeSessionId, {
          kind: 'new_tab',
          title: PREWARMED_TERMINAL_TAB_TITLE,
        });
        if (!isBackgroundOperationCurrent(token)) {
          return;
        }
        await token.commands.attachSession(token.activeSessionId);
        if (!isBackgroundOperationCurrent(token)) {
          return;
        }
        await token.commands.dispatchMuxCommand(token.activeSessionId, {
          kind: 'focus_tab',
          tab_id: activeVisibleTabId,
        });
        if (!isBackgroundOperationCurrent(token)) {
          return;
        }
        await token.commands.attachSession(token.activeSessionId);
        if (isBackgroundOperationCurrent(token)) {
          prewarmFailuresRef.current.keys.delete(prewarmKey);
        }
      } catch {
        if (isBackgroundOperationCurrent(token)) {
          prewarmFailuresRef.current.keys.add(prewarmKey);
        }
      } finally {
        cancelBackgroundOperation(token);
      }
    })();

    return () => cancelBackgroundOperation(token);
  }, [
    activeSessionId,
    activeVisibleTabId,
    busy,
    canCreateTab,
    canFocusTab,
    cancelBackgroundOperation,
    isBackgroundOperationCurrent,
    prewarmedTabId,
    renderedScopeIsCurrent,
    scopeEpoch,
    startBackgroundOperation,
    tabsCount,
  ]);

  return {
    busy,
    cancelRenameTab,
    closeCandidate: currentViewState.closeCandidate,
    commitRenameTab,
    confirmCloseCandidate,
    createTab,
    dismissCloseCandidate,
    editingTabId: currentViewState.editingTabId,
    editingTitle: currentViewState.editingTitle,
    error: currentViewState.error,
    focusTab,
    pendingAction: currentViewState.pendingAction,
    renameInputRef,
    requestCloseTab,
    setEditingTitle,
    startRenameTab,
  };
}

function createInitialViewState(scopeEpoch: number): LifecycleViewState {
  return {
    closeCandidate: null,
    editingTabId: null,
    editingTitle: '',
    error: null,
    pendingAction: null,
    scopeEpoch,
  };
}

function getErrorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
