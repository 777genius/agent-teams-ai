import { unwrapIpc } from '@renderer/utils/unwrapIpc';

import { projectIncomingMemberSpawnSnapshot } from './teamRuntimeRunAdoption';

import type { AppState } from '../types';
import type { MemberSpawnStatusesSnapshot } from '@shared/types';
import type { TeamMemberRestartResult } from '@shared/types/teamMemberRestart';
import type { StoreApi } from 'zustand';

/** Feature-local action orchestration; generic runtime event adoption remains unchanged. */
export function createTeamMemberRestartAction<TScope>(options: {
  get: () => AppState;
  set: StoreApi<AppState>['setState'];
  captureScope(teamName: string): TScope;
  isScopeCurrent(teamName: string, scope: TScope): boolean;
  restart: (...args: Parameters<AppState['restartMember']>) => Promise<TeamMemberRestartResult>;
  readSnapshot(teamName: string): Promise<MemberSpawnStatusesSnapshot>;
  onEqualSuppressed: (teamName: string, runId: string | null | undefined) => void;
}): AppState['restartMember'] {
  const { get, set } = options;
  const invocationByTeam = new Map<string, number>();
  return async (teamName, memberName, expectedSecondary) => {
    const invocation = (invocationByTeam.get(teamName) ?? 0) + 1;
    invocationByTeam.set(teamName, invocation);
    const requestScope = options.captureScope(teamName);
    const isCurrent = (): boolean =>
      invocationByTeam.get(teamName) === invocation &&
      options.isScopeCurrent(teamName, requestScope);
    const predecessor = get().currentRuntimeRunIdByTeam[teamName];
    const previousProvisioning = get().currentProvisioningRunIdByTeam[teamName];
    try {
      const result = await unwrapIpc('team:restartMember', () =>
        options.restart(teamName, memberName, expectedSecondary)
      );
      const retainedFailure = result.status === 'failed_retained' ? result : null;
      const correlated =
        !retainedFailure ||
        (retainedFailure.teamName === teamName &&
          retainedFailure.memberName === memberName &&
          retainedFailure.predecessorRunId === predecessor);
      if (predecessor && correlated && isCurrent()) {
        try {
          // Only this exact action result can hand off a still-live aggregate.
          // Generic events keep rejecting other generations while secondary lanes live.
          const snapshot = await options.readSnapshot(teamName);
          const successor = snapshot.runId?.trim();
          let adopted = false;
          const failedPrimary = snapshot.statuses[memberName];
          const retainedSnapshot =
            !retainedFailure ||
            (successor === retainedFailure.successorRunId &&
              failedPrimary?.runtimeAlive === false &&
              failedPrimary.launchState === 'failed_to_start' &&
              Object.entries(snapshot.statuses).some(
                ([name, member]) => name !== memberName && member.runtimeAlive === true
              ));
          if (successor && successor !== predecessor && retainedSnapshot) {
            set((state) => {
              if (
                !isCurrent() ||
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
          if (adopted && successor && isCurrent()) {
            await get().getProvisioningStatus(successor);
          }
        } catch {
          // A best-effort UI read never replaces the original restart outcome.
        }
      }
      if (retainedFailure) {
        await unwrapIpc('team:restartMember', () =>
          Promise.reject(new Error(retainedFailure.error))
        );
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
        ...(isCurrent() && !stoppedPredecessor ? [get().refreshTeamData(teamName)] : []),
        get().refreshTeamMessagesHead(teamName),
        get().fetchMemberSpawnStatuses(teamName),
        get().fetchTeamAgentRuntime(teamName),
      ]);
    }
  };
}
