import { isOrdinaryTeamTab } from '@renderer/types/tabs';
import { normalizePath } from '@renderer/utils/pathNormalize';

import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
  subscribeContextScopedRequestEpoch,
} from '../utils/contextScopedRequestEpoch';
import { getSessionResetState, getWorktreeNavigationState } from '../utils/stateResetHelpers';

import type { AppState } from '../types';
import type { StoreApi } from 'zustand';

interface ProjectMatch {
  projectId: string;
  repositoryId: string | null;
  worktreeId: string | null;
}

function findProject(state: AppState, path: string): ProjectMatch | undefined {
  const project = (state.projects ?? []).find((value) => normalizePath(value.path) === path);
  if (project) return { projectId: project.id, repositoryId: null, worktreeId: null };
  for (const group of state.repositoryGroups ?? []) {
    const worktree = group.worktrees.find((value) => normalizePath(value.path) === path);
    if (worktree) {
      return { projectId: worktree.id, repositoryId: group.id, worktreeId: worktree.id };
    }
  }
  return undefined;
}

function projectSelection(state: AppState) {
  return [
    state.selectedRepositoryId,
    state.selectedWorktreeId,
    state.selectedProjectId,
    state.activeProjectId,
  ] as const;
}

function needsSelection(state: AppState, match: ProjectMatch): boolean {
  return match.repositoryId === null
    ? state.selectedProjectId !== match.projectId
    : state.selectedRepositoryId !== match.repositoryId ||
        state.selectedWorktreeId !== match.worktreeId ||
        state.selectedProjectId !== match.projectId;
}

function focusedNavigation(state: AppState) {
  const panes = state.paneLayout.panes.filter((pane) => pane.id === state.paneLayout.focusedPaneId);
  if (panes.length !== 1) return null;
  const pane = panes[0];
  const tabs = pane.tabs.filter((tab) => tab.id === pane.activeTabId);
  if (pane.activeTabId !== null && tabs.length !== 1) return null;
  const tab = tabs[0];
  return [
    pane.id,
    pane.activeTabId,
    state.activeTabId,
    tab?.type,
    tab?.teamName,
    tab?.projectId,
    tab?.sessionId,
    tab?.taskDetail?.contextId,
    tab?.taskDetail?.taskId,
    tab?.teamsCreationPage,
    tab?.teamsCreationSeed?.id,
    tab?.pendingNavigation?.id,
  ] as const;
}

function sameValues(before: readonly unknown[], after: readonly unknown[] | null): boolean {
  return after !== null && before.every((value, index) => value === after[index]);
}

function openOrdinaryTeamTab(state: AppState, teamName: string): void {
  const teamSummary = state.teamByName[teamName];
  const selectedTeamDisplayName =
    state.selectedTeamName === teamName ? state.selectedTeamData?.config.name : undefined;
  const displayName = teamSummary?.displayName || selectedTeamDisplayName || teamName;
  const existing = state
    .getAllPaneTabs()
    .find((tab) => isOrdinaryTeamTab(tab) && tab.teamName === teamName);
  if (existing) {
    state.setActiveTab(existing.id);
    if (existing.label !== displayName) state.updateTabLabel(existing.id, displayName);
  } else {
    state.openTab({ type: 'team', label: displayName, teamName });
  }
}

/** Initialize a cold project catalog only for an explicit logical Team navigation. */
export function createOpenTeamTabAction(
  set: StoreApi<AppState>['setState'],
  get: () => AppState,
  store: StoreApi<AppState>
): AppState['openTeamTab'] {
  // Each actual store owns at most one delayed navigation and its subscriptions.
  let cancelPending: (() => void) | undefined;
  const selectProject = (match: ProjectMatch, isCurrent?: () => boolean): void => {
    const state = get();
    if (
      isCurrent
        ? sameValues(projectSelection(state), [
            match.repositoryId,
            match.worktreeId,
            match.projectId,
            match.projectId,
          ])
        : !needsSelection(state, match)
    )
      return;
    if (match.repositoryId === null || match.worktreeId === null) {
      if (!isCurrent) {
        state.selectProject(match.projectId);
        return;
      }
      set({
        selectedRepositoryId: null,
        selectedWorktreeId: null,
        selectedProjectId: match.projectId,
        activeProjectId: match.projectId,
        ...getSessionResetState(),
      });
    } else {
      set(getWorktreeNavigationState(match.repositoryId, match.worktreeId));
    }
    if (!isCurrent || isCurrent()) void get().fetchSessionsInitial(match.projectId);
  };

  return (teamName, projectPath) => {
    cancelPending?.();
    if (!teamName.trim()) return;
    const state = get();
    const path = projectPath ? normalizePath(projectPath) : undefined;
    const match = path === undefined ? undefined : findProject(state, path);
    if (match) {
      selectProject(match);
      openOrdinaryTeamTab(get(), teamName);
      return;
    }
    const target = state.teamByName[teamName];
    if (
      path === undefined ||
      target?.teamName !== teamName ||
      target.projectContextMode !== 'per_project'
    ) {
      // Legacy, shared and physical execution views do not require this catalog.
      openOrdinaryTeamTab(state, teamName);
      return;
    }
    const focus = focusedNavigation(state);
    if (
      !focus ||
      state.isContextSwitching ||
      (!state.repositoryGroupsLoading &&
        (state.repositoryGroupsInitialized || state.repositoryGroupsError))
    )
      return;

    const contextId = state.activeContextId;
    const epoch = captureContextScopedRequestEpoch();
    const ownerResourceRef = target.ownerResourceRef;
    const deletedAt = target.deletedAt;
    let expectedProject = projectSelection(state);
    let loadingObserved = state.repositoryGroupsLoading;
    let selecting = false;
    const cancel = (): void => {
      unsubscribeState();
      unsubscribeEpoch();
      if (cancelPending === cancel) cancelPending = undefined;
    };
    const isCurrent = (): boolean => {
      const current = get();
      const currentTarget = current.teamByName[teamName];
      return (
        cancelPending === cancel &&
        current.activeContextId === contextId &&
        !current.isContextSwitching &&
        isContextScopedRequestEpochCurrent(epoch) &&
        currentTarget?.teamName === teamName &&
        currentTarget.projectContextMode === 'per_project' &&
        currentTarget.ownerResourceRef === ownerResourceRef &&
        currentTarget.deletedAt === deletedAt &&
        sameValues(focus, focusedNavigation(current)) &&
        sameValues(expectedProject, projectSelection(current))
      );
    };
    const observe = (): void => {
      if (!isCurrent()) {
        cancel();
        return;
      }
      if (selecting) return;
      const current = get();
      if (current.repositoryGroupsLoading) {
        loadingObserved = true;
        return;
      }
      if (!loadingObserved) return;
      const resolved =
        !current.repositoryGroupsError && current.repositoryGroupsInitialized
          ? findProject(current, path)
          : undefined;
      if (!resolved) {
        cancel();
        return;
      }
      // Select before exposing the target tab. Reentrant subscribers may supersede this intent.
      expectedProject = [
        resolved.repositoryId,
        resolved.worktreeId,
        resolved.projectId,
        resolved.projectId,
      ];
      selecting = true;
      try {
        selectProject(resolved, isCurrent);
        if (!isCurrent()) return;
        unsubscribeState();
        openOrdinaryTeamTab(get(), teamName);
      } finally {
        cancel();
      }
    };
    cancelPending = cancel;
    const unsubscribeState = store.subscribe(observe);
    const unsubscribeEpoch = subscribeContextScopedRequestEpoch(cancel);
    // Joining an existing fetch observes its settlement; its action returns early when loading.
    if (isCurrent() && !get().repositoryGroupsLoading) void get().fetchRepositoryGroups();
  };
}
