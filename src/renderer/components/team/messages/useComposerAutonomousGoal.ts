import {
  isHostTeamSelectionKey,
  readAutonomousGoalOptions,
} from '@features/agent-backend/contracts';
import { useStore } from '@renderer/store';

import { restoredAutonomousGoalRequest } from './composerSendUtils';

import type { UseComposerDraftResult } from '@renderer/hooks/useComposerDraft';

/** Advisory UI gate. Intake and every automatic claim are independently authorized by the Host. */
export function useComposerAutonomousGoal(
  teamName: string,
  draft: Pick<
    UseComposerDraftResult,
    'address' | 'revisionContext' | 'actionMode' | 'autonomousGoal' | 'snapshot'
  >,
  context: {
    isLeadRecipient: boolean;
    isCrossTeam: boolean;
    isTeamAlive?: boolean;
    nativeCommand: boolean;
  }
) {
  const goalAvailable = useStore(
    (state) =>
      state.selectedTeamName === teamName &&
      state.selectedTeamData?.autonomousGoalAvailable === true
  );
  const goalStatus = useStore((state) =>
    state.selectedTeamName === teamName ? state.selectedTeamData?.autonomousGoal : undefined
  );
  const content = draft.snapshot();
  const original = restoredAutonomousGoalRequest(
    content,
    teamName,
    draft.address.target.kind === 'direct' ? draft.address.target.participant : ''
  );
  const goalEligible =
    isHostTeamSelectionKey(teamName) &&
    (goalAvailable || !!original) &&
    context.isLeadRecipient &&
    !context.isCrossTeam &&
    !!context.isTeamAlive &&
    draft.address.target.kind === 'direct' &&
    draft.revisionContext === null &&
    !context.nativeCommand &&
    draft.actionMode !== 'ask';
  let goalOptionsValid = true;
  if (draft.autonomousGoal) {
    try {
      readAutonomousGoalOptions(draft.autonomousGoal);
    } catch {
      goalOptionsValid = false;
    }
  }
  if (content.restoredOrigin?.autonomousGoalRequest && draft.autonomousGoal && !original)
    goalOptionsValid = false;
  const goalRestrictionReason = !draft.autonomousGoal
    ? null
    : !goalOptionsValid
      ? content.restoredOrigin?.autonomousGoalRequest
        ? 'Restore the unchanged original objective to check its delivery.'
        : 'Choose 1–24 hours and 1–1,000 automatic attempts.'
      : !goalEligible
        ? draft.actionMode === 'ask'
          ? 'Choose Do or Delegate to continue until done.'
          : goalStatus && !goalAvailable
            ? 'This team already has an objective. Use its continuation controls or turn this option off.'
            : 'Continue until done requires a ready team and a direct message to its lead.'
        : null;
  return { goalAvailable, goalStatus, goalEligible, goalOptionsValid, goalRestrictionReason };
}
