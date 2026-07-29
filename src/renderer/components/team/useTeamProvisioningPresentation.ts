import { useMemo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { useStore } from '@renderer/store';
import {
  getCurrentProvisioningProgressForTeam,
  selectTeamMemberSnapshotsForName,
} from '@renderer/store/slices/teamSlice';
import { buildTeamMemberLaunchDiagnosticsPayloads } from '@renderer/utils/memberLaunchDiagnostics';
import { buildTeamProvisioningPresentation } from '@renderer/utils/teamProvisioningPresentation';
import { useShallow } from 'zustand/react/shallow';

import type { MemberLaunchDiagnosticsPayload } from '@renderer/utils/memberLaunchDiagnostics';
import type { TeamProvisioningPresentation } from '@renderer/utils/teamProvisioningPresentation';
import type { RetryFailedOpenCodeSecondaryLanesResult } from '@shared/types';

export function useTeamProvisioningPresentation(teamName: string): {
  presentation: TeamProvisioningPresentation | null;
  cancelProvisioning: ((runId: string) => Promise<void>) | null;
  retryFailedOpenCodeSecondaryLanes:
    | ((teamName: string) => Promise<RetryFailedOpenCodeSecondaryLanesResult>)
    | null;
  memberDiagnostics: MemberLaunchDiagnosticsPayload[];
  runInstanceKey: string | null;
} {
  const { t } = useAppTranslation('team');
  const {
    progress,
    cancelProvisioning,
    retryFailedRuntimeLanes,
    teamMembers,
    memberSpawnStatuses,
    memberSpawnSnapshot,
    runtimeSnapshot,
  } = useStore(
    useShallow((s) => ({
      progress: getCurrentProvisioningProgressForTeam(s, teamName),
      cancelProvisioning: s.cancelProvisioning,
      retryFailedRuntimeLanes: s.retryFailedRuntimeLanes,
      teamMembers: selectTeamMemberSnapshotsForName(s, teamName),
      memberSpawnStatuses: s.memberSpawnStatusesByTeam[teamName],
      memberSpawnSnapshot: s.memberSpawnSnapshotsByTeam[teamName],
      runtimeSnapshot: s.teamAgentRuntimeByTeam?.[teamName],
    }))
  );

  const presentation = useMemo(
    () =>
      buildTeamProvisioningPresentation({
        progress,
        members: teamMembers,
        memberSpawnStatuses,
        memberSpawnSnapshot,
        memberRuntimeEntries: runtimeSnapshot?.members,
        t,
      }),
    [memberSpawnSnapshot, memberSpawnStatuses, progress, runtimeSnapshot?.members, teamMembers, t]
  );
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
    retryFailedOpenCodeSecondaryLanes: retryFailedRuntimeLanes ?? null,
    memberDiagnostics,
    runInstanceKey: progress ? `${teamName}:${progress.runId}:${progress.startedAt}` : null,
  };
}
