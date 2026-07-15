import { useCallback, useState } from 'react';

import { api } from '@renderer/api';
import { CreateTaskDialog } from '@renderer/components/team/dialogs/CreateTaskDialog';
import { useStore } from '@renderer/store';
import {
  isTeamProvisioningActive,
  selectResolvedMembersForTeamName,
  selectTeamDataForName,
} from '@renderer/store/slices/teamSlice';
import { useShallow } from 'zustand/react/shallow';

import type { CreateTaskRequest } from '@shared/types';

interface CreateTaskDialogState {
  open: boolean;
  defaultOwner: string;
}

interface UseGraphCreateTaskDialogResult {
  dialog: React.ReactNode;
  openCreateTaskDialog: (owner?: string) => void;
}

export function useGraphCreateTaskDialog(teamName: string): UseGraphCreateTaskDialogResult {
  const [dialogState, setDialogState] = useState<CreateTaskDialogState>({
    open: false,
    defaultOwner: '',
  });
  const [submitting, setSubmitting] = useState(false);

  const { teamData, activeMembers, createTeamTask, isTeamProvisioning } = useStore(
    useShallow((state) => ({
      teamData: selectTeamDataForName(state, teamName),
      activeMembers: selectResolvedMembersForTeamName(state, teamName).filter(
        (member) => !member.removedAt
      ),
      createTeamTask: state.createTeamTask,
      isTeamProvisioning: isTeamProvisioningActive(state, teamName),
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

  const handleCreateTask = useCallback(
    async (request: CreateTaskRequest): Promise<void> => {
      const { owner, prompt, startImmediately, subject } = request;
      setSubmitting(true);
      try {
        await createTeamTask(teamName, request);

        if (
          prompt &&
          owner &&
          teamData?.isAlive &&
          !isTeamProvisioning &&
          startImmediately !== false
        ) {
          const msg = `New task assigned to ${owner}: "${subject}". Instructions:\n${prompt}`;
          try {
            await api.teams.processSend(teamName, msg);
          } catch {
            // best-effort only
          }
        }

        closeCreateTaskDialog();
      } catch {
        // store already exposes the error
      } finally {
        setSubmitting(false);
      }
    },
    [closeCreateTaskDialog, createTeamTask, isTeamProvisioning, teamData?.isAlive, teamName]
  );

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
        onSubmit={handleCreateTask}
        submitting={submitting}
      />
    ),
  };
}
