import { parseHostTeamRunId, parseHostTeamSelectionKey } from '@features/agent-backend/contracts';
import {
  captureTeamLocalStateEpoch,
  isTeamLocalStateEpochCurrent,
} from '@renderer/store/team/teamLocalStateEpoch';
import { isTeamRunIgnored } from '@renderer/store/team/teamProvisioningRunIdentity';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';

import type { AppState } from '@renderer/store/types';
import type { RetryFailedOpenCodeSecondaryLanesResult } from '@shared/types';
import type { CapturedHostFailedMemberRetry } from '@shared/types/teamMemberRestart';

export type FailedOpenCodeRetryResult =
  | RetryFailedOpenCodeSecondaryLanesResult
  | { kind: 'host'; attempted: string[] };

/** Reuse member recovery, keeping one displayed Team/run and never reselecting between members. */
export function createHostFailedMemberRetry(options: {
  teamName: string;
  runId: string;
  contextId: string;
  memberNames: readonly string[];
  failedSelections: Readonly<Record<string, CapturedHostFailedMemberRetry | undefined>>;
  getState(): Pick<
    AppState,
    | 'activeContextId'
    | 'isContextSwitching'
    | 'currentRuntimeRunIdByTeam'
    | 'currentProvisioningRunIdByTeam'
    | 'ignoredRuntimeRunIds'
    | 'ignoredProvisioningRunIds'
  >;
  restartMember: AppState['restartMember'];
}): () => Promise<FailedOpenCodeRetryResult> {
  const { teamName, runId, contextId, restartMember, getState } = options;
  const names = [...options.memberNames];
  const failedSelections = structuredClone(options.failedSelections);
  const contextEpoch = captureContextScopedRequestEpoch();
  const teamEpoch = captureTeamLocalStateEpoch(teamName);
  const assertCurrent = () => {
    const state = getState();
    if (
      state.isContextSwitching ||
      state.activeContextId !== contextId ||
      !isContextScopedRequestEpochCurrent(contextEpoch) ||
      !isTeamLocalStateEpochCurrent(teamName, teamEpoch) ||
      state.currentRuntimeRunIdByTeam[teamName] !== runId ||
      state.currentProvisioningRunIdByTeam[teamName] !== runId ||
      isTeamRunIgnored(state.ignoredRuntimeRunIds, runId, teamName) ||
      isTeamRunIgnored(state.ignoredProvisioningRunIds, runId, teamName)
    )
      throw new Error('Team launch changed. Refresh its status before retrying.');
  };
  return async () => {
    if (parseHostTeamRunId(runId).handleId !== parseHostTeamSelectionKey(teamName))
      throw new Error('The displayed launch does not belong to this Team.');
    assertCurrent();
    for (const name of names) {
      assertCurrent();
      const expected = failedSelections[name];
      if (!expected || expected.runId !== runId)
        throw new Error(
          'Failed teammate status is unavailable. Refresh its status before retrying.'
        );
      // No secondary-lane flag: Host owns the original retry/action receipt and its lookup.
      await restartMember(teamName, name, undefined, expected);
      assertCurrent();
    }
    return { kind: 'host', attempted: [...names] };
  };
}
