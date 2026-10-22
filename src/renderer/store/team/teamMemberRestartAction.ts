import { unwrapIpc } from '@renderer/utils/unwrapIpc';

import { projectIncomingMemberSpawnSnapshot } from './teamRuntimeRunAdoption';

import type { AppState } from '../types';
import type { MemberSpawnStatusesSnapshot } from '@shared/types';
import type { StoreApi } from 'zustand';

/** Feature-local action orchestration; generic runtime event adoption remains unchanged. */
export function createTeamMemberRestartAction<TScope>(options: {
  get: () => AppState;
  set: StoreApi<AppState>['setState'];
  captureScope(teamName: string): TScope;
  isScopeCurrent(teamName: string, scope: TScope): boolean;
  restart: AppState['restartMember'];
  readSnapshot(teamName: string): Promise<MemberSpawnStatusesSnapshot>;
  onEqualSuppressed: (teamName: string, runId: string | null | undefined) => void;
}): AppState['restartMember'] {
  const { get, set } = options;
  return async (teamName, memberName, expectedSecondary) => {
    const requestScope = options.captureScope(teamName);
    const predecessor = get().currentRuntimeRunIdByTeam[teamName];
    const previousProvisioning = get().currentProvisioningRunIdByTeam[teamName];
    try {
      await unwrapIpc('team:restartMember', () =>
        options.restart(teamName, memberName, expectedSecondary)
      );
      if (predecessor && options.isScopeCurrent(teamName, requestScope)) {
        try {
          // Only this completed explicit action can hand off a still-live aggregate.
          // Generic events keep rejecting other generations while secondary lanes live.
          const snapshot = await options.readSnapshot(teamName);
          const successor = snapshot.runId?.trim();
          let adopted = false;
          if (successor && successor !== predecessor) {
            set((state) => {
              if (
                !options.isScopeCurrent(teamName, requestScope) ||
                state.currentRuntimeRunIdByTeam[teamName] !== predecessor ||
                state.currentProvisioningRunIdByTeam[teamName] !== previousProvisioning ||
                state.ignoredRuntimeRunIds[predecessor] === teamName ||
                state.ignoredProvisioningRunIds[predecessor] === teamName ||
                state.ignoredRuntimeRunIds[successor] === teamName ||
                state.ignoredProvisioningRunIds[successor] === teamName ||
                !Object.values(snapshot.statuses).some((member) => member.runtimeAlive === true)
              ) {
                return {};
              }
              adopted = true;
              const nextPins = { ...state.currentRuntimeRunIdByTeam, [teamName]: successor };
              const nextRuns = { ...state.provisioningRuns };
              delete nextRuns[predecessor];
              return {
                ...projectIncomingMemberSpawnSnapshot({
                  teamName,
                  snapshot,
                  prev: { ...state, currentRuntimeRunIdByTeam: nextPins },
                  onEqualSuppressed: options.onEqualSuppressed,
                }),
                currentRuntimeRunIdByTeam: nextPins,
                currentProvisioningRunIdByTeam: {
                  ...state.currentProvisioningRunIdByTeam,
                  [teamName]: successor,
                },
                provisioningRuns: nextRuns,
                ignoredRuntimeRunIds: { ...state.ignoredRuntimeRunIds, [predecessor]: teamName },
                ignoredProvisioningRunIds: {
                  ...state.ignoredProvisioningRunIds,
                  [predecessor]: teamName,
                },
              };
            });
          }
          if (adopted && successor && options.isScopeCurrent(teamName, requestScope)) {
            await get().getProvisioningStatus(successor);
          }
        } catch {
          // A successful restart remains successful when its best-effort UI read fails.
        }
      }
    } finally {
      const state = get();
      const currentRun = state.currentRuntimeRunIdByTeam[teamName];
      const stoppedPredecessor =
        predecessor &&
        state.ignoredRuntimeRunIds[predecessor] === teamName &&
        (!currentRun ||
          currentRun === predecessor ||
          state.ignoredRuntimeRunIds[currentRun] === teamName);
      await Promise.allSettled([
        ...(options.isScopeCurrent(teamName, requestScope) && !stoppedPredecessor
          ? [get().refreshTeamData(teamName)]
          : []),
        get().refreshTeamMessagesHead(teamName),
        get().fetchMemberSpawnStatuses(teamName),
        get().fetchTeamAgentRuntime(teamName),
      ]);
    }
  };
}
