import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react';

import { MessagesPanel } from '@renderer/components/team/messages/MessagesPanel';
import {
  getTeamPendingRepliesState,
  setTeamPendingRepliesState,
} from '@renderer/components/team/sidebar/teamSidebarUiState';
import { useStore } from '@renderer/store';
import {
  selectResolvedMembersForTeamName,
  selectTeamDataForName,
} from '@renderer/store/slices/teamSlice';
import { useShallow } from 'zustand/react/shallow';

interface UseGraphMessagesPanelInput {
  teamName: string;
  enabled?: boolean;
  mountPoint?: Element | null;
  onOpenMemberProfile: (memberName: string) => void;
  onOpenTaskDetail: (taskId: string) => void;
}

export function useGraphMessagesPanel({
  teamName,
  enabled = true,
  mountPoint,
  onOpenMemberProfile,
  onOpenTaskDetail,
}: UseGraphMessagesPanelInput): ReactElement {
  const [pendingRepliesByMember, setPendingRepliesByMember] = useState(() =>
    getTeamPendingRepliesState(teamName)
  );
  const { messagesPanelMode, setMessagesPanelMode, members, tasks, isTeamAlive } = useStore(
    useShallow((state) => {
      const teamData = selectTeamDataForName(state, teamName);
      return {
        messagesPanelMode: state.messagesPanelMode,
        setMessagesPanelMode: state.setMessagesPanelMode,
        members: selectResolvedMembersForTeamName(state, teamName),
        tasks: teamData?.tasks ?? [],
        isTeamAlive: teamData?.isAlive,
      };
    })
  );
  const activeMembers = useMemo(() => members.filter((member) => !member.removedAt), [members]);

  useEffect(() => {
    setPendingRepliesByMember(getTeamPendingRepliesState(teamName));
  }, [teamName]);

  useEffect(() => {
    setTeamPendingRepliesState(teamName, pendingRepliesByMember);
  }, [pendingRepliesByMember, teamName]);

  const handlePendingReplyChange = useCallback(
    (updater: (prev: Record<string, number>) => Record<string, number>) => {
      setPendingRepliesByMember(updater);
    },
    []
  );

  if (
    !enabled ||
    (messagesPanelMode !== 'floating-composer' && messagesPanelMode !== 'bottom-sheet')
  ) {
    return <></>;
  }

  return (
    <MessagesPanel
      teamName={teamName}
      position={messagesPanelMode}
      onPositionChange={setMessagesPanelMode}
      mountPoint={messagesPanelMode === 'bottom-sheet' ? mountPoint : undefined}
      members={activeMembers}
      tasks={tasks}
      isTeamAlive={isTeamAlive}
      timeWindow={null}
      pendingRepliesByMember={pendingRepliesByMember}
      onPendingReplyChange={handlePendingReplyChange}
      onMemberClick={(member) => onOpenMemberProfile(member.name)}
      onTaskClick={(task) => onOpenTaskDetail(task.id)}
      onTaskIdClick={onOpenTaskDetail}
    />
  );
}
