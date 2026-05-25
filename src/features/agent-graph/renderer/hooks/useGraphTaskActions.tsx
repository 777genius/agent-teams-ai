import { useCallback, useMemo, useState } from 'react';

import { api } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { ReviewDialog } from '@renderer/components/team/dialogs/ReviewDialog';
import { useStore } from '@renderer/store';
import {
  selectResolvedMembersForTeamName,
  selectTeamDataForName,
} from '@renderer/store/slices/teamSlice';
import { deriveTaskDisplayId, formatTaskDisplayLabel } from '@shared/utils/taskIdentity';
import { useShallow } from 'zustand/react/shallow';

import type { TaskRef } from '@shared/types';

interface GraphTaskActionHandlers {
  onApproveTask: (taskId: string) => void;
  onCancelTask: (taskId: string) => void;
  onCompleteTask: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onMoveBackToDone: (taskId: string) => void;
  onRequestChanges: (taskId: string) => void;
  onRequestReview: (taskId: string) => void;
  onStartTask: (taskId: string) => void;
}

interface UseGraphTaskActionsResult extends GraphTaskActionHandlers {
  dialog: React.ReactNode;
  taskActionHandlers: GraphTaskActionHandlers;
}

export function useGraphTaskActions(teamName: string): UseGraphTaskActionsResult {
  const [requestChangesTaskId, setRequestChangesTaskId] = useState<string | null>(null);
  const {
    teamData,
    members,
    requestReview,
    sendTeamMessage,
    softDeleteTask,
    startTaskByUser,
    updateKanban,
    updateTaskStatus,
  } = useStore(
    useShallow((state) => ({
      teamData: selectTeamDataForName(state, teamName),
      members: selectResolvedMembersForTeamName(state, teamName),
      requestReview: state.requestReview,
      sendTeamMessage: state.sendTeamMessage,
      softDeleteTask: state.softDeleteTask,
      startTaskByUser: state.startTaskByUser,
      updateKanban: state.updateKanban,
      updateTaskStatus: state.updateTaskStatus,
    }))
  );

  const onStartTask = useCallback(
    (taskId: string): void => {
      void (async () => {
        try {
          const result = await startTaskByUser(teamName, taskId);
          if (!teamData?.isAlive) return;

          const task = teamData.tasks.find((candidate) => candidate.id === taskId);
          try {
            if (result.notifiedOwner && task?.owner) {
              await api.teams.processSend(
                teamName,
                `Task ${formatTaskDisplayLabel(task)} "${task.subject}" has started. Please begin working on it.`
              );
              return;
            }

            if (!result.notifiedOwner) {
              const desc = task?.description?.trim()
                ? `\nDescription: ${task.description.trim()}`
                : '';
              await api.teams.processSend(
                teamName,
                `Task #${deriveTaskDisplayId(taskId)} "${task?.subject ?? ''}" has been moved to IN PROGRESS but has no assignee.${desc}\nPlease assign it to an available team member, or take it yourself if everyone is busy.`
              );
            }
          } catch {
            // best-effort notification
          }
        } catch {
          // error via store
        }
      })();
    },
    [startTaskByUser, teamData, teamName]
  );

  const onCompleteTask = useCallback(
    (taskId: string): void => {
      void updateTaskStatus(teamName, taskId, 'completed').catch(() => undefined);
    },
    [teamName, updateTaskStatus]
  );

  const onApproveTask = useCallback(
    (taskId: string): void => {
      void updateKanban(teamName, taskId, { op: 'set_column', column: 'approved' }).catch(
        () => undefined
      );
    },
    [teamName, updateKanban]
  );

  const onRequestReview = useCallback(
    (taskId: string): void => {
      void requestReview(teamName, taskId).catch(() => undefined);
    },
    [requestReview, teamName]
  );

  const onRequestChanges = useCallback((taskId: string): void => {
    setRequestChangesTaskId(taskId);
  }, []);

  const onCancelTask = useCallback(
    (taskId: string): void => {
      void (async () => {
        try {
          const task = teamData?.tasks.find((candidate) => candidate.id === taskId);
          await updateTaskStatus(teamName, taskId, 'pending');

          if (task?.owner) {
            try {
              await sendTeamMessage(teamName, {
                member: task.owner,
                text: `Task ${formatTaskDisplayLabel(task)} "${task.subject}" has been CANCELLED by the user and moved back to TODO. Stop working on it immediately.`,
                summary: `Task ${formatTaskDisplayLabel(task)} cancelled`,
              });
            } catch {
              // best-effort notification
            }
          }

          if (teamData?.isAlive) {
            try {
              const ownerSuffix = task?.owner ? ` ${task.owner} has been notified to stop.` : '';
              await api.teams.processSend(
                teamName,
                `Task #${deriveTaskDisplayId(taskId)} "${task?.subject ?? ''}" has been cancelled and moved back to TODO.${ownerSuffix}`
              );
            } catch {
              // best-effort notification
            }
          }
        } catch {
          // error via store
        }
      })();
    },
    [sendTeamMessage, teamData, teamName, updateTaskStatus]
  );

  const onMoveBackToDone = useCallback(
    (taskId: string): void => {
      void (async () => {
        try {
          await updateKanban(teamName, taskId, { op: 'remove' });
          await updateTaskStatus(teamName, taskId, 'completed');
        } catch {
          // error via store
        }
      })();
    },
    [teamName, updateKanban, updateTaskStatus]
  );

  const onDeleteTask = useCallback(
    (taskId: string): void => {
      void (async () => {
        const confirmed = await confirm({
          title: 'Delete task',
          message: `Move task #${deriveTaskDisplayId(taskId)} to trash?`,
          confirmLabel: 'Delete',
          cancelLabel: 'Cancel',
          variant: 'danger',
        });
        if (!confirmed) return;

        await softDeleteTask(teamName, taskId).catch(() => undefined);
      })();
    },
    [softDeleteTask, teamName]
  );

  const handleSubmitRequestChanges = useCallback(
    (comment?: string, taskRefs?: TaskRef[]): void => {
      if (!requestChangesTaskId) return;
      void (async () => {
        try {
          await updateKanban(teamName, requestChangesTaskId, {
            op: 'request_changes',
            comment,
            taskRefs,
          });
          setRequestChangesTaskId(null);
        } catch {
          // error via store
        }
      })();
    },
    [requestChangesTaskId, teamName, updateKanban]
  );

  const taskActionHandlers = useMemo<GraphTaskActionHandlers>(
    () => ({
      onApproveTask,
      onCancelTask,
      onCompleteTask,
      onDeleteTask,
      onMoveBackToDone,
      onRequestChanges,
      onRequestReview,
      onStartTask,
    }),
    [
      onApproveTask,
      onCancelTask,
      onCompleteTask,
      onDeleteTask,
      onMoveBackToDone,
      onRequestChanges,
      onRequestReview,
      onStartTask,
    ]
  );

  return {
    ...taskActionHandlers,
    taskActionHandlers,
    dialog: (
      <ReviewDialog
        open={requestChangesTaskId !== null}
        teamName={teamName}
        taskId={requestChangesTaskId}
        members={members}
        onCancel={() => setRequestChangesTaskId(null)}
        onSubmit={handleSubmitRequestChanges}
      />
    ),
  };
}
