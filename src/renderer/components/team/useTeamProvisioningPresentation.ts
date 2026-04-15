import { useMemo } from 'react';

import { useStore } from '@renderer/store';
import {
  getCurrentProvisioningProgressForTeam,
  selectTeamMemberSnapshotsForName,
} from '@renderer/store/slices/teamSlice';
import { buildTeamProvisioningPresentation } from '@renderer/utils/teamProvisioningPresentation';
import { useShallow } from 'zustand/react/shallow';

import type { TeamProvisioningPresentation } from '@renderer/utils/teamProvisioningPresentation';

export function useTeamProvisioningPresentation(teamName: string): {
  presentation: TeamProvisioningPresentation | null;
  cancelProvisioning: ((runId: string) => Promise<void>) | null;
  runInstanceKey: string | null;
} {
  const { progress, cancelProvisioning, teamMembers, memberSpawnStatuses, memberSpawnSnapshot } =
    useStore(
      useShallow((s) => ({
        progress: getCurrentProvisioningProgressForTeam(s, teamName),
        cancelProvisioning: s.cancelProvisioning,
        teamMembers: selectTeamMemberSnapshotsForName(s, teamName),
        memberSpawnStatuses: s.memberSpawnStatusesByTeam[teamName],
        memberSpawnSnapshot: s.memberSpawnSnapshotsByTeam[teamName],
      }))
    );

  const presentation = useMemo(
    () =>
      buildTeamProvisioningPresentation({
        progress,
        members: teamMembers,
        memberSpawnStatuses,
        memberSpawnSnapshot,
      }),
    [memberSpawnSnapshot, memberSpawnStatuses, progress, teamMembers]
  );

  return {
    presentation,
    cancelProvisioning,
    runInstanceKey: progress ? `${teamName}:${progress.runId}:${progress.startedAt}` : null,
  };
}
