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
    const canHandoff = (state: AppState, successor?: string): boolean =>
      Boolean(
        predecessor &&
        isCurrent() &&
        state.currentRuntimeRunIdByTeam[teamName] === predecessor &&
        state.currentProvisioningRunIdByTeam[teamName] === previousProvisioning &&
        state.ignoredRuntimeRunIds[predecessor] !== teamName &&
        state.ignoredProvisioningRunIds[predecessor] !== teamName &&
        (!successor ||
          (state.ignoredRuntimeRunIds[successor] !== teamName &&
            state.ignoredProvisioningRunIds[successor] !== teamName))
      );

    try {
      const result = await unwrapIpc('team:restartMember', () =>
        options.restart(teamName, memberName, expectedSecondary)
      );
      const restartFailure = result.status === 'restarted' ? null : result;
      const correlated =
        !restartFailure ||
        (restartFailure.teamName === teamName &&
          restartFailure.memberName === memberName &&
          restartFailure.predecessorRunId === predecessor);
      let statusUnavailable = false;
      if (predecessor && correlated && canHandoff(get())) {
        let snapshot: MemberSpawnStatusesSnapshot | undefined;
        // Retry only observation, within this invocation's bounded authority.
        for (let attempt = 0; attempt < 3 && canHandoff(get()); attempt += 1) {
          try {
            const observed = await options.readSnapshot(teamName);
            if (!canHandoff(get(), observed.runId?.trim())) break;
            snapshot = observed;
            break;
          } catch {
            if (!canHandoff(get())) break;
            statusUnavailable = attempt === 2;
          }
        }
        if (snapshot) {
          try {
            const successor = snapshot.runId?.trim();
            let adopted = false;
            const failedPrimary = snapshot.statuses[memberName];
            const retainedSnapshot =
              !restartFailure ||
              (successor === restartFailure.successorRunId &&
                (restartFailure.status === 'failed_restored' ||
                  (failedPrimary?.runtimeAlive === false &&
                    failedPrimary.launchState === 'failed_to_start' &&
                    Object.entries(snapshot.statuses).some(
                      ([name, member]) => name !== memberName && member.runtimeAlive === true
                    ))));
            if (successor && successor !== predecessor && retainedSnapshot) {
              set((state) => {
                if (
                  !canHandoff(state, successor) ||
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
            // Progress details are best-effort after the runtime handoff is confirmed.
          }
        }
      }
      if (restartFailure || statusUnavailable) {
        const statusError = statusUnavailable
          ? restartFailure
            ? "The teammate's current status could not be loaded."
            : 'Teammate restarted, but its current status could not be loaded.'
          : '';
        const message = [restartFailure?.error, statusError].filter(Boolean).join(' ');
        await unwrapIpc('team:restartMember', () => Promise.reject(new Error(message)));
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
