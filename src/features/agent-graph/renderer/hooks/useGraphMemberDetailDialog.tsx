import { lazy, Suspense, useCallback, useState } from 'react';

import { useStore } from '@renderer/store';
import {
  isTeamProvisioningActive,
  selectResolvedMembersForTeamName,
  selectTeamDataForName,
} from '@renderer/store/slices/teamSlice';
import { useShallow } from 'zustand/react/shallow';

import type {
  MemberActivityFilter,
  MemberDetailTab,
} from '@renderer/components/team/members/memberDetailTypes';
import type { TeamTaskWithKanban } from '@shared/types';

const MemberDetailDialog = lazy(() =>
  import('@renderer/components/team/members/MemberDetailDialog').then((m) => ({
    default: m.MemberDetailDialog,
  }))
);

interface OpenMemberProfileOptions {
  initialActivityFilter?: MemberActivityFilter;
  initialTab?: MemberDetailTab;
}

interface UseGraphMemberDetailDialogInput {
  onAssignTask: (owner: string) => void;
  onSendMessage: (memberName: string) => void;
  onTaskClick: (taskId: string) => void;
  onViewMemberChanges: (memberName: string, filePath?: string) => void;
}

interface UseGraphMemberDetailDialogResult {
  dialog: React.ReactNode;
  openMemberProfile: (memberName: string, options?: OpenMemberProfileOptions) => void;
}

export function useGraphMemberDetailDialog(
  teamName: string,
  { onAssignTask, onSendMessage, onTaskClick, onViewMemberChanges }: UseGraphMemberDetailDialogInput
): UseGraphMemberDetailDialogResult {
  const [selectedMemberName, setSelectedMemberName] = useState<string | null>(null);
  const [selectedMemberView, setSelectedMemberView] = useState<OpenMemberProfileOptions | null>(
    null
  );
  const {
    isTeamProvisioning,
    launchParams,
    leadActivity,
    members,
    runtimeRunId,
    selectedRuntimeEntry,
    selectedSpawnEntry,
    teamData,
  } = useStore(
    useShallow((state) => ({
      isTeamProvisioning: isTeamProvisioningActive(state, teamName),
      launchParams: state.launchParamsByTeam[teamName],
      leadActivity: state.leadActivityByTeam[teamName],
      members: selectResolvedMembersForTeamName(state, teamName),
      runtimeRunId:
        state.teamAgentRuntimeByTeam[teamName]?.runId ??
        state.memberSpawnSnapshotsByTeam[teamName]?.runId ??
        null,
      selectedRuntimeEntry: selectedMemberName
        ? state.teamAgentRuntimeByTeam[teamName]?.members[selectedMemberName]
        : undefined,
      selectedSpawnEntry: selectedMemberName
        ? state.memberSpawnStatusesByTeam[teamName]?.[selectedMemberName]
        : undefined,
      teamData: selectTeamDataForName(state, teamName),
    }))
  );

  const selectedMember =
    selectedMemberName && members.length > 0
      ? (members.find((member) => member.name === selectedMemberName) ?? null)
      : null;

  const openMemberProfile = useCallback(
    (memberName: string, options?: OpenMemberProfileOptions): void => {
      setSelectedMemberName(memberName);
      setSelectedMemberView(options ?? null);
    },
    []
  );

  const closeMemberProfile = useCallback((): void => {
    setSelectedMemberName(null);
    setSelectedMemberView(null);
  }, []);

  return {
    openMemberProfile,
    dialog:
      selectedMemberName && teamData ? (
        <Suspense fallback={null}>
          <MemberDetailDialog
            open
            member={selectedMember}
            teamName={teamName}
            members={members}
            tasks={teamData.tasks}
            initialTab={selectedMemberView?.initialTab}
            initialActivityFilter={selectedMemberView?.initialActivityFilter}
            isTeamAlive={teamData.isAlive}
            isTeamProvisioning={isTeamProvisioning}
            leadActivity={leadActivity}
            spawnEntry={selectedSpawnEntry}
            runtimeEntry={selectedRuntimeEntry}
            runtimeRunId={runtimeRunId}
            launchParams={launchParams}
            onClose={closeMemberProfile}
            onSendMessage={() => {
              if (!selectedMemberName) return;
              closeMemberProfile();
              onSendMessage(selectedMemberName);
            }}
            onAssignTask={() => {
              if (!selectedMemberName) return;
              closeMemberProfile();
              onAssignTask(selectedMemberName);
            }}
            onTaskClick={(task: TeamTaskWithKanban) => {
              closeMemberProfile();
              onTaskClick(task.id);
            }}
            onViewMemberChanges={(memberName, filePath) => {
              closeMemberProfile();
              onViewMemberChanges(memberName, filePath);
            }}
          />
        </Suspense>
      ) : null,
  };
}
