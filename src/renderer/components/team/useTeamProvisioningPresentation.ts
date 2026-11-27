import { useMemo } from 'react';

import {
  isHostTeamSelectionKey,
  parseHostTeamRunId,
  parseHostTeamSelectionKey,
} from '@features/agent-backend/contracts';
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

export function useTeamProvisioningPresentation(
  teamName: string,
  runtimeTeamName = teamName
): {
  presentation: TeamProvisioningPresentation | null;
  cancelProvisioning: ((runId: string) => Promise<void>) | null;
  retryFailedOpenCodeTeammates: (() => Promise<FailedOpenCodeRetryResult>) | null;
  memberDiagnostics: MemberLaunchDiagnosticsPayload[];
  runInstanceKey: string | null;
  diagnosticsTeamName: string;
} {
  const { t } = useAppTranslation('team');
  const splitHost =
    teamName !== runtimeTeamName &&
    isHostTeamSelectionKey(teamName) &&
    isHostTeamSelectionKey(runtimeTeamName);
  const executionTeamName = splitHost ? runtimeTeamName : teamName;
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
    runtimeCurrent,
  } = useStore(
    useShallow((s) => {
      let progress = getCurrentProvisioningProgressForTeam(s, teamName);
      if (splitHost) {
        try {
          if (
            !progress ||
            progress.teamName !== teamName ||
            parseHostTeamRunId(progress.runId).handleId !==
              parseHostTeamSelectionKey(executionTeamName)
          )
            progress = null;
        } catch {
          progress = null;
        }
      }
      const currentRuntimeRunId = s.currentRuntimeRunIdByTeam?.[executionTeamName];
      const runtimeCurrent =
        !splitHost || Boolean(progress && currentRuntimeRunId === progress.runId);
      const spawn = s.memberSpawnSnapshotsByTeam[teamName];
      const spawnCurrent = !splitHost || Boolean(progress && spawn?.runId === progress.runId);
      const runtime = s.teamAgentRuntimeByTeam?.[executionTeamName];
      const runtimeSnapshot =
        runtimeCurrent &&
        (!splitHost ||
          (runtime?.teamName === executionTeamName && runtime.runId === progress?.runId))
          ? runtime
          : undefined;
      return {
        progress,
        runtimeCurrent,
        isTeamAlive: selectTeamIsAliveForName(s, runtimeCurrent ? executionTeamName : undefined),
        cancelProvisioning: s.cancelProvisioning,
        retryFailedOpenCodeSecondaryLanes: s.retryFailedOpenCodeSecondaryLanes,
        restartMember: s.restartMember,
        contextId: s.activeContextId,
        teamMembers: selectTeamMemberSnapshotsForName(
          s,
          runtimeCurrent ? executionTeamName : undefined
        ),
        memberSpawnStatuses: spawnCurrent
          ? splitHost
            ? spawn?.statuses
            : s.memberSpawnStatusesByTeam[teamName]
          : undefined,
        memberSpawnSnapshot: spawnCurrent ? spawn : undefined,
        runtimeSnapshot,
        leadActivity:
          !splitHost || runtimeSnapshot ? s.leadActivityByTeam?.[executionTeamName] : undefined,
        currentRuntimeRunId: runtimeCurrent ? currentRuntimeRunId : undefined,
      };
    })
  );

  const presentation = useMemo(() => {
    if (progress?.state === 'ready' && (!runtimeCurrent || isTeamAlive === false)) return null;
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
    runtimeCurrent,
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
        teamName: executionTeamName,
        runId: splitHost
          ? progress?.runId
          : (runtimeSnapshot?.runId ?? memberSpawnSnapshot?.runId ?? progress?.runId),
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
      executionTeamName,
      splitHost,
    ]
  );

  return {
    presentation,
    diagnosticsTeamName: executionTeamName,
    cancelProvisioning,
    retryFailedOpenCodeTeammates: isHostTeamSelectionKey(teamName)
      ? presentation && runtimeCurrent && typeof restartMember === 'function'
        ? createHostFailedMemberRetry({
            teamName: executionTeamName,
            provisioningTeamName: teamName,
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
          executionTeamName,
          captureTeamLocalStateEpoch(executionTeamName),
          progress.runId,
          progress.startedAt,
        ])
      : null,
  };
}
