import { useCallback, useMemo, useState } from 'react';

import { api } from '@renderer/api';
import { CreateTaskDialog } from '@renderer/components/team/dialogs/CreateTaskDialog';
import { useStore } from '@renderer/store';
import { isTeamProvisioningActive, selectTeamDataForName } from '@renderer/store/slices/teamSlice';
import { useShallow } from 'zustand/react/shallow';

import type { TaskRef } from '@shared/types';

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

  const { teamData, createTeamTask, isTeamProvisioning } = useStore(
    useShallow((state) => ({
      teamData: selectTeamDataForName(state, teamName),
      createTeamTask: state.createTeamTask,
      isTeamProvisioning: isTeamProvisioningActive(state, teamName),
    }))
  );

  const activeMembers = useMemo(
    () => (teamData?.members ?? []).filter((member) => !member.removedAt),
    [teamData?.members]
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
    (
      subject: string,
      description: string,
      owner?: string,
      blockedBy?: string[],
      related?: string[],
      prompt?: string,
      startImmediately?: boolean,
      descriptionTaskRefs?: TaskRef[],
      promptTaskRefs?: TaskRef[]
    ): void => {
      setSubmitting(true);
      void (async () => {
        try {
          await createTeamTask(teamName, {
            subject,
            description: description || undefined,
            owner,
            blockedBy,
            related,
            prompt,
            descriptionTaskRefs,
            promptTaskRefs,
            startImmediately,
          });

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
      })();
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
