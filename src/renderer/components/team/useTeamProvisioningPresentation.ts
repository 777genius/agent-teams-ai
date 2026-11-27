import { useMemo } from 'react';

import { isHostTeamSelectionKey } from '@features/agent-backend/contracts';
import { useAppTranslation } from '@features/localization/renderer';
import { useStore } from '@renderer/store';
import {
  getCurrentProvisioningProgressForTeam,
  selectTeamIsAliveForName,
  selectTeamMemberSnapshotsForName,
} from '@renderer/store/slices/teamSlice';
import { captureTeamLocalStateEpoch } from '@renderer/store/team/teamLocalStateEpoch';
import { captureContextScopedRequestEpoch } from '@renderer/store/utils/contextScopedRequestEpoch';
import { buildTeamMemberLaunchDiagnosticsPayloads } from '@renderer/utils/memberLaunchDiagnostics';
import { applyLeadActivityToProvisioningPresentation } from '@renderer/utils/teamProvisioningLeadActivityPresentation';
import { buildTeamProvisioningPresentation } from '@renderer/utils/teamProvisioningPresentation';
import { useShallow } from 'zustand/react/shallow';

import { createHostFailedMemberRetry } from './createHostFailedMemberRetry';

import type { FailedOpenCodeRetryResult } from './createHostFailedMemberRetry';
import type { MemberLaunchDiagnosticsPayload } from '@renderer/utils/memberLaunchDiagnostics';
import type { TeamProvisioningPresentation } from '@renderer/utils/teamProvisioningPresentation';

export function useTeamProvisioningPresentation(teamName: string): {
  presentation: TeamProvisioningPresentation | null;
  cancelProvisioning: ((runId: string) => Promise<void>) | null;
  retryFailedOpenCodeTeammates: (() => Promise<FailedOpenCodeRetryResult>) | null;
  memberDiagnostics: MemberLaunchDiagnosticsPayload[];
  runInstanceKey: string | null;
} {
  const { t } = useAppTranslation('team');
  const {
    progress,
    isTeamAlive,
    cancelProvisioning,
    retryFailedOpenCodeSecondaryLanes,
    restartMember,
    contextId,
    teamMembers,
    memberSpawnStatuses,
    memberSpawnSnapshot,
    runtimeSnapshot,
    leadActivity,
    currentRuntimeRunId,
  } = useStore(
    useShallow((s) => ({
      progress: getCurrentProvisioningProgressForTeam(s, teamName),
      isTeamAlive: selectTeamIsAliveForName(s, teamName),
      cancelProvisioning: s.cancelProvisioning,
      retryFailedOpenCodeSecondaryLanes: s.retryFailedOpenCodeSecondaryLanes,
      restartMember: s.restartMember,
      contextId: s.activeContextId,
      teamMembers: selectTeamMemberSnapshotsForName(s, teamName),
      memberSpawnStatuses: s.memberSpawnStatusesByTeam[teamName],
      memberSpawnSnapshot: s.memberSpawnSnapshotsByTeam[teamName],
      runtimeSnapshot: s.teamAgentRuntimeByTeam?.[teamName],
      leadActivity: s.leadActivityByTeam?.[teamName],
      currentRuntimeRunId: s.currentRuntimeRunIdByTeam?.[teamName],
    }))
  );

  const presentation = useMemo(() => {
    if (progress?.state === 'ready' && isTeamAlive === false) return null;
    return applyLeadActivityToProvisioningPresentation(
      buildTeamProvisioningPresentation({
        progress,
        members: teamMembers,
        memberSpawnStatuses,
        memberSpawnSnapshot,
        memberRuntimeEntries: runtimeSnapshot?.members,
        t,
      }),
      {
        leadActivity,
        currentRuntimeRunId,
        title: t('provisioning.presentation.panel.completingStartupChecks', {
          defaultValue: 'Completing startup checks',
        }),
        detail: t('provisioning.presentation.active.leadWorking', {
          defaultValue: 'Lead is working while startup checks finish.',
        }),
      }
    );
  }, [
    isTeamAlive,
    memberSpawnSnapshot,
    memberSpawnStatuses,
    progress,
    runtimeSnapshot?.members,
    teamMembers,
    leadActivity,
    currentRuntimeRunId,
    t,
  ]);
  const memberDiagnostics = useMemo(
    () =>
      buildTeamMemberLaunchDiagnosticsPayloads({
        teamName,
        runId: runtimeSnapshot?.runId ?? memberSpawnSnapshot?.runId ?? progress?.runId,
        members: teamMembers,
        memberSpawnStatuses,
        memberSpawnSnapshot,
        runtimeEntries: runtimeSnapshot?.members,
      }),
    [
      memberSpawnSnapshot,
      memberSpawnStatuses,
      progress?.runId,
      runtimeSnapshot,
      teamMembers,
      teamName,
    ]
  );

  return {
    presentation,
    cancelProvisioning,
    retryFailedOpenCodeTeammates: isHostTeamSelectionKey(teamName)
      ? presentation && typeof restartMember === 'function'
        ? createHostFailedMemberRetry({
            teamName,
            runId: presentation.progress.runId,
            contextId,
            memberNames: presentation.retryableOpenCodeSecondaryFailedNames,
            failedSelections: Object.fromEntries(
              presentation.retryableOpenCodeSecondaryFailedNames.map((name) => [
                name,
                memberSpawnSnapshot?.statuses[name]?.hostFailedMemberRetry,
              ])
            ),
            getState: useStore.getState,
            restartMember,
          })
        : null
      : retryFailedOpenCodeSecondaryLanes
        ? () => retryFailedOpenCodeSecondaryLanes(teamName)
        : null,
    memberDiagnostics,
    runInstanceKey: progress
      ? JSON.stringify([
          contextId,
          captureContextScopedRequestEpoch(),
          teamName,
          captureTeamLocalStateEpoch(teamName),
          progress.runId,
          progress.startedAt,
        ])
      : null,
  };
}
