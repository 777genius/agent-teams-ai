import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
  subscribeContextScopedRequestEpoch,
} from '@renderer/store/utils/contextScopedRequestEpoch';
import { normalizePath } from '@renderer/utils/pathNormalize';
import { isTeamReadUnavailable } from '@shared/utils/normalizeTeamAggregateRead';

import type { AppState } from '@renderer/store/types';
import type { TeamSummary } from '@shared/types';
import type { StoreApi } from 'zustand';

interface CreatedTeamHandoff {
  presentation: 'dialog' | 'page';
  projectContextMode?: 'shared' | 'per_project';
  getGeneration(): number;
  isGenerationCurrent(generation: number): boolean;
  ownsPage(generation: number): boolean;
  getState(): AppState;
  subscribe: StoreApi<AppState>['subscribe'];
  resetDraft(): Promise<void>;
  resetForm(): Promise<void>;
  onClose(): void;
  onOpenTeam(name: string, cwd?: string): void;
}

function owner(state: AppState): string {
  return JSON.stringify([
    state.activeContextId,
    state.targetContextId,
    state.connectionMode,
    state.connectedHost,
    state.appConfig?.general?.claudeRootPath,
  ]);
}

function navigation(state: AppState) {
  const panes = state.paneLayout.panes.filter((pane) => pane.id === state.paneLayout.focusedPaneId);
  if (panes.length !== 1) return null;
  const pane = panes[0];
  const tabs = pane.tabs.filter((tab) => tab.id === pane.activeTabId);
  if (tabs.length !== 1) return null;
  const tab = tabs[0];
  return {
    identity: [
      pane.id,
      pane.activeTabId,
      state.activeTabId,
      tab.type,
      tab.teamName,
      tab.projectId,
      tab.sessionId,
      tab.taskDetail?.contextId,
      tab.taskDetail?.taskId,
      tab.pendingNavigation?.id,
      state.selectedRepositoryId,
      state.selectedWorktreeId,
      state.selectedProjectId,
      state.activeProjectId,
    ],
    creationPage: tab.teamsCreationPage,
    creationSeed: tab.teamsCreationSeed?.id,
  };
}

/** Capture before Create; an accepted result grants no authority over a successor editor. */
export function captureCreatedTeamHandoff(input: CreatedTeamHandoff) {
  const scopedPage = input.presentation === 'page' && input.projectContextMode === 'per_project';
  const original = scopedPage ? input.getState() : null;
  const originalOwner = original ? owner(original) : null;
  const originalNavigation = original ? navigation(original) : null;
  const epoch = captureContextScopedRequestEpoch();
  const generation = input.getGeneration();
  let expectedGeneration = generation;
  let phase: 'pending' | 'resetting' | 'closing' | 'closed' = 'pending';
  let closeObserved = false;
  let live = Boolean(
    original && !original.isContextSwitching && originalNavigation?.creationPage === true
  );
  let targetCurrent: (() => boolean) | undefined;
  const waiters = new Set<() => void>();
  let unsubscribeState = () => {};
  let unsubscribeEpoch = () => {};
  const dispose = (): void => {
    live = false;
    unsubscribeState();
    unsubscribeEpoch();
    for (const done of [...waiters]) done();
  };
  const current = (): boolean => {
    if (!live || !originalNavigation || !isContextScopedRequestEpochCurrent(epoch)) return false;
    const state = input.getState();
    const selected = navigation(state);
    if (
      state.isContextSwitching ||
      owner(state) !== originalOwner ||
      !selected ||
      !originalNavigation.identity.every((value, index) => value === selected.identity[index]) ||
      (targetCurrent && !targetCurrent())
    )
      return false;
    const open =
      selected.creationPage === originalNavigation.creationPage &&
      selected.creationSeed === originalNavigation.creationSeed;
    const closed = selected.creationPage === false && selected.creationSeed === undefined;
    const intendedClose = (phase === 'closing' || phase === 'closed') && closed;
    if (
      intendedClose
        ? !input.isGenerationCurrent(expectedGeneration)
        : !(
            input.ownsPage(expectedGeneration) ||
            (phase === 'resetting' && input.ownsPage(generation + 1))
          )
    )
      return false;
    if (phase === 'closing') {
      if (closed) closeObserved = true;
      return closed || (!closeObserved && open);
    }
    return phase === 'closed' ? closed && closeObserved : open;
  };
  if (scopedPage) {
    unsubscribeState = input.subscribe(() => {
      if (!current()) dispose();
    });
    unsubscribeEpoch = subscribeContextScopedRequestEpoch(dispose);
  }
  const waitForInitialList = async (): Promise<void> => {
    if (!input.getState().teamsLoading) return;
    await new Promise<void>((resolve) => {
      let stop = () => {};
      const done = (): void => {
        stop();
        waiters.delete(done);
        resolve();
      };
      const check = (): void => {
        if (!current() || !input.getState().teamsLoading) done();
      };
      waiters.add(done);
      stop = input.subscribe(check);
      check();
    });
  };
  const completeScoped = async (name: string, cwd: string): Promise<void> => {
    if (!current() || !input.isGenerationCurrent(generation)) return;
    while (current() && input.getState().teamsLoading) await waitForInitialList();
    if (!current()) return;
    let readSucceeded = true;
    const read: { teams?: readonly TeamSummary[] } = {};
    try {
      // Joining an initial fetch returns early. Drain it above, then request this accepted Team.
      await input.getState().fetchTeams({
        onCurrentRead: (teams) => {
          read.teams = teams;
        },
      });
    } catch {
      readSucceeded = false;
    }
    if (!current()) return;
    const state = input.getState();
    const target = state.teamByName[name];
    const returned = read.teams?.find((row) => row.teamName === name);
    const available =
      readSucceeded &&
      !state.teamsLoading &&
      !state.teamsError &&
      target?.teamName === name &&
      returned !== undefined &&
      returned.ownerResourceRef === target.ownerResourceRef &&
      returned.projectContextMode === target.projectContextMode &&
      returned.projectPath === target.projectPath &&
      returned.deletedAt === target.deletedAt &&
      target.projectContextMode === 'per_project' &&
      target.deletedAt === undefined &&
      typeof target.projectPath === 'string' &&
      normalizePath(target.projectPath) === normalizePath(cwd) &&
      !isTeamReadUnavailable(state.teamsUnavailable, target);
    if (available) {
      const source = [
        target.ownerResourceRef,
        target.projectContextMode,
        target.projectPath,
        target.deletedAt,
      ];
      targetCurrent = () => {
        const currentState = input.getState();
        const row = currentState.teamByName[name];
        return (
          row?.teamName === name &&
          !currentState.teamsError &&
          !isTeamReadUnavailable(currentState.teamsUnavailable, row) &&
          source.every(
            (value, index) =>
              value ===
              [row.ownerResourceRef, row.projectContextMode, row.projectPath, row.deletedAt][index]
          )
        );
      };
    }
    phase = 'resetting';
    await input.resetForm();
    expectedGeneration = generation + 1;
    phase = 'pending';
    if (!current()) return;
    // Retire the accepted form even when its navigation read failed. Do not recreate the Team.
    phase = 'closing';
    input.onClose();
    phase = 'closed';
    if (available && current()) input.onOpenTeam(name, cwd);
  };
  const completeOriginal = async (name: string, cwd?: string): Promise<void> => {
    const generation = input.getGeneration();
    if (input.presentation === 'page' && !input.isGenerationCurrent(generation)) return;
    if (!input.ownsPage(generation)) {
      if (
        !input
          .getState()
          .getAllPaneTabs()
          .some((tab) => tab.type === 'teams' && tab.teamsCreationPage)
      )
        await input.resetDraft();
      return;
    }
    await input.resetForm();
    if (!input.ownsPage(generation + 1)) return;
    const tab = input.presentation === 'page' ? input.getState().getActiveTab() : null;
    if (input.presentation !== 'page' || (tab?.type === 'teams' && tab.teamsCreationPage)) {
      input.onOpenTeam(name, cwd);
    }
    input.onClose();
  };
  const complete = async (name: string, cwd?: string): Promise<void> => {
    try {
      if (scopedPage && cwd?.trim()) await completeScoped(name, cwd);
      else await completeOriginal(name, cwd);
    } finally {
      dispose();
    }
  };
  return Object.assign(complete, { dispose });
}
