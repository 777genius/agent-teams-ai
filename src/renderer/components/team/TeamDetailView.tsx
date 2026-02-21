import { useCallback, useEffect, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { useStore } from '@renderer/store';
import { Plus, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { ActivityTimeline } from './activity/ActivityTimeline';
import { MessageComposer } from './activity/MessageComposer';
import { CreateTaskDialog } from './dialogs/CreateTaskDialog';
import { ReviewDialog } from './dialogs/ReviewDialog';
import { KanbanBoard } from './kanban/KanbanBoard';
import { MemberList } from './members/MemberList';
import { CollapsibleTeamSection } from './CollapsibleTeamSection';
import { TeamProvisioningBanner } from './TeamProvisioningBanner';

interface TeamDetailViewProps {
  teamName: string;
}

interface CreateTaskDialogState {
  open: boolean;
  defaultSubject: string;
  defaultDescription: string;
}

export const TeamDetailView = ({ teamName }: TeamDetailViewProps): React.JSX.Element => {
  const [requestChangesTaskId, setRequestChangesTaskId] = useState<string | null>(null);
  const [createTaskDialog, setCreateTaskDialog] = useState<CreateTaskDialogState>({
    open: false,
    defaultSubject: '',
    defaultDescription: '',
  });
  const [creatingTask, setCreatingTask] = useState(false);

  const {
    data,
    loading,
    error,
    selectTeam,
    updateKanban,
    updateTaskStatus,
    sendTeamMessage,
    requestReview,
    createTeamTask,
    deleteTeam,
    openTeamsTab,
    sendingMessage,
    sendMessageError,
    lastSendMessageResult,
    reviewActionError,
  } = useStore(
    useShallow((s) => ({
      data: s.selectedTeamData,
      loading: s.selectedTeamLoading,
      error: s.selectedTeamError,
      selectTeam: s.selectTeam,
      updateKanban: s.updateKanban,
      updateTaskStatus: s.updateTaskStatus,
      sendTeamMessage: s.sendTeamMessage,
      requestReview: s.requestReview,
      createTeamTask: s.createTeamTask,
      deleteTeam: s.deleteTeam,
      openTeamsTab: s.openTeamsTab,
      sendingMessage: s.sendingMessage,
      sendMessageError: s.sendMessageError,
      lastSendMessageResult: s.lastSendMessageResult,
      reviewActionError: s.reviewActionError,
    }))
  );

  useEffect(() => {
    if (!teamName) {
      return;
    }
    void selectTeam(teamName);
  }, [teamName, selectTeam]);

  const openCreateTaskDialog = (subject = '', description = ''): void => {
    setCreateTaskDialog({ open: true, defaultSubject: subject, defaultDescription: description });
  };

  const closeCreateTaskDialog = (): void => {
    setCreateTaskDialog({ open: false, defaultSubject: '', defaultDescription: '' });
  };

  const handleDeleteTeam = useCallback((): void => {
    const confirmed = window.confirm(
      `Удалить команду "${teamName}"? Это действие необратимо. Будут удалены все данные команды и задачи.`
    );
    if (!confirmed) {
      return;
    }
    void (async () => {
      try {
        await deleteTeam(teamName);
        openTeamsTab();
      } catch {
        // error is shown via store
      }
    })();
  }, [teamName, deleteTeam, openTeamsTab]);

  const handleCreateTask = (
    subject: string,
    description: string,
    owner?: string,
    blockedBy?: string[]
  ): void => {
    setCreatingTask(true);
    void (async () => {
      try {
        await createTeamTask(teamName, {
          subject,
          description: description || undefined,
          owner,
          blockedBy,
        });
        closeCreateTaskDialog();
      } catch {
        // error shown via store
      } finally {
        setCreatingTask(false);
      }
    })();
  };

  if (!teamName) {
    return (
      <div className="flex size-full items-center justify-center p-6 text-sm text-red-400">
        Invalid team tab
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="size-full overflow-auto p-4">
        <div className="mb-4 h-10 animate-pulse rounded-md bg-[var(--color-surface-raised)]" />
        <div className="space-y-3">
          <div className="h-24 animate-pulse rounded-md bg-[var(--color-surface-raised)]" />
          <div className="h-48 animate-pulse rounded-md bg-[var(--color-surface-raised)]" />
          <div className="h-48 animate-pulse rounded-md bg-[var(--color-surface-raised)]" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex size-full items-center justify-center p-6">
        <div className="text-center">
          <p className="text-sm font-medium text-red-400">Не удалось загрузить команду</p>
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex size-full items-center justify-center p-6 text-sm text-[var(--color-text-muted)]">
        Нет данных по команде
      </div>
    );
  }

  return (
    <div className="size-full overflow-auto p-4">
      <div className="mb-3">
        <h2 className="text-base font-semibold text-[var(--color-text)]">{data.config.name}</h2>
        {data.config.description && (
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">{data.config.description}</p>
        )}
      </div>

      <TeamProvisioningBanner teamName={teamName} />

      {data.warnings?.some((warning) => warning.toLowerCase().includes('kanban')) ? (
        <div className="mb-3 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200">
          Не удалось полностью загрузить kanban. Отображены безопасные данные.
        </div>
      ) : null}
      {reviewActionError ? (
        <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {reviewActionError}
        </div>
      ) : null}

      <CollapsibleTeamSection title="Участники" badge={data.members.length} defaultOpen>
        <MemberList members={data.members} />
      </CollapsibleTeamSection>

      <CollapsibleTeamSection
        title="Kanban"
        badge={data.tasks.length}
        defaultOpen
        action={
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            onClick={(e) => {
              e.stopPropagation();
              openCreateTaskDialog();
            }}
          >
            <Plus size={12} />
            Задача
          </Button>
        }
      >
        <KanbanBoard
          tasks={data.tasks}
          kanbanState={data.kanbanState}
          onRequestReview={(taskId) => {
            void requestReview(teamName, taskId);
          }}
          onApprove={(taskId) => {
            void updateKanban(teamName, taskId, { op: 'set_column', column: 'approved' });
          }}
          onRequestChanges={(taskId) => {
            setRequestChangesTaskId(taskId);
          }}
          onMoveBackToDone={(taskId) => {
            void updateKanban(teamName, taskId, { op: 'remove' });
          }}
          onCompleteTask={(taskId) => {
            void updateTaskStatus(teamName, taskId, 'completed');
          }}
          onScrollToTask={(taskId) => {
            const el = document.querySelector(`[data-task-id="${taskId}"]`);
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
              el.classList.add('ring-2', 'ring-blue-400/50');
              setTimeout(() => el.classList.remove('ring-2', 'ring-blue-400/50'), 1500);
            }
          }}
        />
      </CollapsibleTeamSection>

      <CollapsibleTeamSection title="Активность" badge={data.messages.length} defaultOpen>
        <div className="flex flex-col gap-3">
          <MessageComposer
            members={data.members}
            sending={sendingMessage}
            sendError={sendMessageError}
            lastResult={lastSendMessageResult}
            onSend={(member, text, summary) => {
              void sendTeamMessage(teamName, { member, text, summary });
            }}
          />
          <div className="rounded-md border border-[var(--color-border)] p-2">
            <ActivityTimeline
              messages={data.messages}
              onCreateTaskFromMessage={(subject, description) => {
                openCreateTaskDialog(subject, description);
              }}
            />
          </div>
        </div>
      </CollapsibleTeamSection>

      <ReviewDialog
        open={requestChangesTaskId !== null}
        taskId={requestChangesTaskId}
        onCancel={() => setRequestChangesTaskId(null)}
        onSubmit={(comment) => {
          if (!requestChangesTaskId) {
            return;
          }
          void (async () => {
            try {
              await updateKanban(teamName, requestChangesTaskId, {
                op: 'request_changes',
                comment,
              });
              setRequestChangesTaskId(null);
            } catch {
              // error state is handled in the store and shown in the view
            }
          })();
        }}
      />

      <CreateTaskDialog
        open={createTaskDialog.open}
        members={data.members}
        tasks={data.tasks}
        defaultSubject={createTaskDialog.defaultSubject}
        defaultDescription={createTaskDialog.defaultDescription}
        onClose={closeCreateTaskDialog}
        onSubmit={handleCreateTask}
        submitting={creatingTask}
      />

      <div className="mt-6 border-t border-[var(--color-border)] pt-4">
        <Button
          variant="outline"
          size="sm"
          className="border-red-500/40 text-red-300 hover:bg-red-500/10 hover:text-red-200"
          onClick={handleDeleteTeam}
        >
          <Trash2 size={14} className="mr-1.5" />
          Удалить команду
        </Button>
      </div>
    </div>
  );
};
