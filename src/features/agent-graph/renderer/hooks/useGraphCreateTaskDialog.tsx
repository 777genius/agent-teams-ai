import { useCallback, useState } from 'react';

import { CreateTaskDialog } from '@renderer/components/team/dialogs/CreateTaskDialog';
import { getDesktopCreateTaskInteraction } from '@renderer/composition/team/desktopCreateTaskSessions';
import { useStore } from '@renderer/store';
import {
  isTeamProvisioningActive,
  selectResolvedMembersForTeamName,
  selectTeamDataForName,
} from '@renderer/store/slices/teamSlice';
import { useShallow } from 'zustand/react/shallow';

import type { TeamGraphTaskNotificationPort } from '../ports/TeamGraphTaskNotificationPort';

interface CreateTaskDialogState {
  open: boolean;
  defaultOwner: string;
}

interface UseGraphCreateTaskDialogResult {
  dialog: React.ReactNode;
  openCreateTaskDialog: (owner?: string) => void;
}

export function useGraphCreateTaskDialog(
  teamName: string,
  _taskNotificationPort: TeamGraphTaskNotificationPort
): UseGraphCreateTaskDialogResult {
  const [dialogState, setDialogState] = useState<CreateTaskDialogState>({
    open: false,
    defaultOwner: '',
  });
  const { teamData, activeMembers, isTeamProvisioning, activeContextId } = useStore(
    useShallow((state) => ({
      teamData: selectTeamDataForName(state, teamName),
      activeMembers: selectResolvedMembersForTeamName(state, teamName).filter(
        (member) => !member.removedAt
      ),
      isTeamProvisioning: isTeamProvisioningActive(state, teamName),
      activeContextId: state.activeContextId,
    }))
  );

  const openCreateTaskDialog = useCallback((owner = ''): void => {
    setDialogState({
      open: true,
      defaultOwner: owner,
    });
  }, []);

  const closeCreateTaskDialog = useCallback((): void => {
    setDialogState({
      open: false,
      defaultOwner: '',
    });
  }, []);

  const createTaskInteraction = getDesktopCreateTaskInteraction(teamName, activeContextId);

  return {
    openCreateTaskDialog,
    dialog: (
      <CreateTaskDialog
        open={dialogState.open}
        teamName={teamName}
        members={activeMembers}
        tasks={teamData?.tasks ?? []}
        isTeamAlive={Boolean(teamData?.isAlive && !isTeamProvisioning)}
        defaultOwner={dialogState.defaultOwner}
        onClose={closeCreateTaskDialog}
        interaction={createTaskInteraction}
      />
    ),
  };
}
