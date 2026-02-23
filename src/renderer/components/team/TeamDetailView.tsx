import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useTeamMessagesRead } from '@renderer/hooks/useTeamMessagesRead';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { buildTaskCountsByOwner } from '@renderer/utils/pathNormalize';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import { MessageSquare, Pencil, Play, Plus, Search, Trash2, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { ActiveTasksBlock } from './activity/ActiveTasksBlock';
import { ActivityTimeline } from './activity/ActivityTimeline';
import { PendingRepliesBlock } from './activity/PendingRepliesBlock';
import { CreateTaskDialog } from './dialogs/CreateTaskDialog';
import { EditTeamDialog } from './dialogs/EditTeamDialog';
import { LaunchTeamDialog } from './dialogs/LaunchTeamDialog';
import { ReviewDialog } from './dialogs/ReviewDialog';
import { SendMessageDialog } from './dialogs/SendMessageDialog';
import { TaskDetailDialog } from './dialogs/TaskDetailDialog';
import { KanbanBoard } from './kanban/KanbanBoard';
import { UNASSIGNED_OWNER } from './kanban/KanbanFilterPopover';
import { MemberDetailDialog } from './members/MemberDetailDialog';
import { MemberList } from './members/MemberList';
import { MessagesFilterPopover } from './messages/MessagesFilterPopover';
import { CollapsibleTeamSection } from './CollapsibleTeamSection';
import { TeamProvisioningBanner } from './TeamProvisioningBanner';
import { TeamSessionsSection } from './TeamSessionsSection';

import type { KanbanFilterState } from './kanban/KanbanFilterPopover';
import type { MessagesFilterState } from './messages/MessagesFilterPopover';
import type { Session } from '@renderer/types/data';
import type { InboxMessage, ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

interface TeamDetailViewProps {
  teamName: string;
}

const ACTIVE_PROVISIONING_STATES = new Set(['validating', 'spawning', 'monitoring', 'verifying']);

interface CreateTaskDialogState {
  open: boolean;
  defaultSubject: string;
  defaultDescription: string;
  defaultOwner: string;
}

interface TimeWindow {
  start: number;
  end: number;
}

function filterKanbanTasks(tasks: TeamTaskWithKanban[], query: string): TeamTaskWithKanban[] {
  if (query.startsWith('#')) {
    const id = query.slice(1);
    return tasks.filter((t) => t.id === id);
  }
  const lower = query.toLowerCase();
  return tasks.filter(
    (t) =>
      t.id.toLowerCase().includes(lower) ||
      t.subject.toLowerCase().includes(lower) ||
      (t.owner?.toLowerCase().includes(lower) ?? false)
  );
}

export const TeamDetailView = ({ teamName }: TeamDetailViewProps): React.JSX.Element => {
  const [requestChangesTaskId, setRequestChangesTaskId] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<TeamTaskWithKanban | null>(null);
  const [selectedMember, setSelectedMember] = useState<ResolvedTeamMember | null>(null);
  const [pendingRepliesByMember, setPendingRepliesByMember] = useState<Record<string, number>>({});
  const [createTaskDialog, setCreateTaskDialog] = useState<CreateTaskDialogState>({
    open: false,
    defaultSubject: '',
    defaultDescription: '',
    defaultOwner: '',
  });
  const [creatingTask, setCreatingTask] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [launchDialogOpen, setLaunchDialogOpen] = useState(false);
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [sendDialogRecipient, setSendDialogRecipient] = useState<string | undefined>(undefined);
  const [replyQuote, setReplyQuote] = useState<{ from: string; text: string } | undefined>(
    undefined
  );

  // Session loading and filtering state
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [kanbanFilter, setKanbanFilter] = useState<KanbanFilterState>({
    sessionId: null,
    selectedOwners: new Set(),
  });

  const {
    data,
    loading,
    error,
    projects,
    selectTeam,
    updateKanban,
    updateTaskStatus,
    sendTeamMessage,
    requestReview,
    createTeamTask,
    startTask,
    deleteTeam,
    openTeamsTab,
    sendingMessage,
    sendMessageError,
    lastSendMessageResult,
    reviewActionError,
    launchTeam,
    provisioningError,
    isTeamProvisioning,
    kanbanFilterQuery,
    clearKanbanFilter,
  } = useStore(
    useShallow((s) => ({
      data: s.selectedTeamData,
      loading: s.selectedTeamLoading,
      error: s.selectedTeamError,
      projects: s.projects,
      selectTeam: s.selectTeam,
      updateKanban: s.updateKanban,
      updateTaskStatus: s.updateTaskStatus,
      sendTeamMessage: s.sendTeamMessage,
      requestReview: s.requestReview,
      createTeamTask: s.createTeamTask,
      startTask: s.startTask,
      deleteTeam: s.deleteTeam,
      openTeamsTab: s.openTeamsTab,
      sendingMessage: s.sendingMessage,
      sendMessageError: s.sendMessageError,
      lastSendMessageResult: s.lastSendMessageResult,
      reviewActionError: s.reviewActionError,
      launchTeam: s.launchTeam,
      provisioningError: s.provisioningError,
      isTeamProvisioning: Object.values(s.provisioningRuns).some(
        (run) => run.teamName === teamName && ACTIVE_PROVISIONING_STATES.has(run.state)
      ),
      kanbanFilterQuery: s.kanbanFilterQuery,
      clearKanbanFilter: s.clearKanbanFilter,
    }))
  );

  const [kanbanSearch, setKanbanSearch] = useState('');
  const [messagesSearchQuery, setMessagesSearchQuery] = useState('');
  const [messagesFilter, setMessagesFilter] = useState<MessagesFilterState>({
    from: new Set(),
    to: new Set(),
  });
  const [messagesFilterOpen, setMessagesFilterOpen] = useState(false);

  useEffect(() => {
    if (!teamName) {
      return;
    }
    void selectTeam(teamName);
  }, [teamName, selectTeam]);

  useEffect(() => {
    if (kanbanFilterQuery) {
      setKanbanSearch(kanbanFilterQuery);
      clearKanbanFilter();
    }
  }, [kanbanFilterQuery, clearKanbanFilter]);

  // Load sessions for the team's project
  const projectId = useMemo(() => {
    if (!data?.config.projectPath) return null;
    return projects.find((p) => p.path === data.config.projectPath)?.id ?? null;
  }, [projects, data?.config.projectPath]);

  useEffect(() => {
    if (!projectId) return;

    let cancelled = false;
    setSessionsLoading(true);
    setSessionsError(null);

    void (async () => {
      try {
        const result = await api.getSessions(projectId);
        if (!cancelled) {
          setSessions(result);
        }
      } catch (e) {
        if (!cancelled) {
          setSessionsError(e instanceof Error ? e.message : 'Failed to load sessions');
        }
      } finally {
        if (!cancelled) {
          setSessionsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Filter sessions to team-only using sessionHistory + leadSessionId
  const teamSessions = useMemo(() => {
    const sessionIds = new Set<string>();
    if (data?.config.leadSessionId) {
      sessionIds.add(data.config.leadSessionId);
    }
    if (data?.config.sessionHistory) {
      for (const id of data.config.sessionHistory) {
        sessionIds.add(id);
      }
    }
    // If no session IDs known (backward compat), show all sessions
    if (sessionIds.size === 0) return sessions;
    return sessions.filter((s) => sessionIds.has(s.id));
  }, [sessions, data?.config.leadSessionId, data?.config.sessionHistory]);

  // Auto-reset session filter if the selected session is no longer in teamSessions
  useEffect(() => {
    if (
      kanbanFilter.sessionId !== null &&
      !teamSessions.some((s) => s.id === kanbanFilter.sessionId)
    ) {
      setKanbanFilter((prev) => ({ ...prev, sessionId: null }));
    }
  }, [kanbanFilter.sessionId, teamSessions]);

  // Compute time-window for session filtering
  const timeWindow = useMemo<TimeWindow | null>(() => {
    if (kanbanFilter.sessionId === null) return null;

    const sorted = [...teamSessions].sort((a, b) => a.createdAt - b.createdAt);
    const idx = sorted.findIndex((s) => s.id === kanbanFilter.sessionId);
    if (idx === -1) return null;

    const start = sorted[idx].createdAt;
    const end = idx + 1 < sorted.length ? sorted[idx + 1].createdAt : Infinity;
    return { start, end };
  }, [kanbanFilter.sessionId, teamSessions]);

  // Filter tasks by time-window and owner
  const filteredTasks = useMemo(() => {
    if (!data) return [];
    let result = data.tasks;

    // Session time-window filter
    if (timeWindow) {
      result = result.filter((t) => {
        if (!t.createdAt) return true; // legacy tasks always included
        const ts = new Date(t.createdAt).getTime();
        return ts >= timeWindow.start && ts < timeWindow.end;
      });
    }

    // Owner filter
    if (kanbanFilter.selectedOwners.size > 0) {
      result = result.filter((t) =>
        t.owner
          ? kanbanFilter.selectedOwners.has(t.owner)
          : kanbanFilter.selectedOwners.has(UNASSIGNED_OWNER)
      );
    }

    return result;
  }, [data, timeWindow, kanbanFilter.selectedOwners]);

  const filteredMessages = useMemo(() => {
    if (!data) return [];
    let list = data.messages;
    if (timeWindow) {
      list = list.filter((m) => {
        const ts = new Date(m.timestamp).getTime();
        return ts >= timeWindow.start && ts < timeWindow.end;
      });
    }
    if (messagesFilter.from.size > 0) {
      list = list.filter((m) => m.from?.trim() && messagesFilter.from.has(m.from.trim()));
    }
    if (messagesFilter.to.size > 0) {
      list = list.filter((m) => m.to?.trim() && messagesFilter.to.has(m.to.trim()));
    }
    const q = messagesSearchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter((m) => {
        const text = (m.text ?? '').toLowerCase();
        const summary = (m.summary ?? '').toLowerCase();
        const from = (m.from ?? '').toLowerCase();
        const to = (m.to ?? '').toLowerCase();
        return text.includes(q) || summary.includes(q) || from.includes(q) || to.includes(q);
      });
    }
    return list;
  }, [data, timeWindow, messagesFilter, messagesSearchQuery]);

  const { readSet, markRead } = useTeamMessagesRead(teamName ?? '');
  const messagesUnreadCount = useMemo(
    () => filteredMessages.filter((m) => !readSet.has(toMessageKey(m))).length,
    [filteredMessages, readSet]
  );
  const handleMessageVisible = useCallback(
    (message: InboxMessage) => markRead(toMessageKey(message)),
    [markRead]
  );

  const kanbanDisplayTasks = useMemo(() => {
    const query = kanbanSearch.trim();
    if (!query) return filteredTasks;
    return filterKanbanTasks(filteredTasks, query);
  }, [filteredTasks, kanbanSearch]);

  const taskMap = useMemo(() => new Map((data?.tasks ?? []).map((t) => [t.id, t])), [data?.tasks]);

  const memberTaskCounts = useMemo(() => buildTaskCountsByOwner(data?.tasks ?? []), [data?.tasks]);

  useEffect(() => {
    if (!data || Object.keys(pendingRepliesByMember).length === 0) return;
    const next = { ...pendingRepliesByMember };
    let changed = false;
    for (const [memberName, sentAtMs] of Object.entries(pendingRepliesByMember)) {
      const hasReply = data.messages.some((m) => {
        if (m.from !== memberName) return false;
        const ts = Date.parse(m.timestamp);
        return Number.isFinite(ts) && ts > sentAtMs;
      });
      if (hasReply) {
        delete next[memberName];
        changed = true;
      }
    }
    if (changed) setPendingRepliesByMember(next);
  }, [data, pendingRepliesByMember]);

  const openCreateTaskDialog = (subject = '', description = '', owner = ''): void => {
    setCreateTaskDialog({
      open: true,
      defaultSubject: subject,
      defaultDescription: description,
      defaultOwner: owner,
    });
  };

  const closeCreateTaskDialog = (): void => {
    setCreateTaskDialog({
      open: false,
      defaultSubject: '',
      defaultDescription: '',
      defaultOwner: '',
    });
  };

  const handleDeleteTeam = useCallback((): void => {
    const confirmed = window.confirm(
      `Delete team "${teamName}"? This action is irreversible. All team data and tasks will be deleted.`
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
    blockedBy?: string[],
    related?: string[],
    prompt?: string,
    startImmediately?: boolean
  ): void => {
    setCreatingTask(true);
    void (async () => {
      try {
        await createTeamTask(teamName, {
          subject,
          description: description || undefined,
          owner,
          blockedBy,
          related,
          prompt,
          startImmediately,
        });

        if (prompt && owner && data?.isAlive && !isTeamProvisioning && startImmediately !== false) {
          const msg = `New task assigned to ${owner}: "${subject}". Instructions:\n${prompt}`;
          try {
            await api.teams.processSend(teamName, msg);
          } catch {
            // best-effort
          }
        }

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
        <TeamProvisioningBanner teamName={teamName} />
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
          <p className="text-sm font-medium text-red-400">Failed to load team</p>
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex size-full items-center justify-center p-6 text-sm text-[var(--color-text-muted)]">
        No team data available
      </div>
    );
  }

  const headerColorSet = data.config.color ? getTeamColorSet(data.config.color) : null;

  return (
    <div className="size-full overflow-auto p-4">
      <div
        className="relative mb-3 overflow-hidden rounded-lg border border-[var(--color-border)] px-4 py-3"
        style={
          headerColorSet
            ? { borderLeftWidth: '3px', borderLeftColor: headerColorSet.border }
            : undefined
        }
      >
        {headerColorSet ? (
          <div
            className="pointer-events-none absolute inset-0 z-0 rounded-lg"
            style={{ backgroundColor: headerColorSet.badge }}
          />
        ) : null}
        <div
          className={cn(
            'flex items-start justify-between gap-2',
            headerColorSet && 'relative z-10'
          )}
        >
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-[var(--color-text)]">{data.config.name}</h2>
            {data.config.description && (
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                {data.config.description}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {!data.isAlive ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
                onClick={() => setLaunchDialogOpen(true)}
              >
                <Play size={12} />
                Launch
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              onClick={() => setEditDialogOpen(true)}
            >
              <Pencil size={12} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs text-red-400 hover:bg-red-500/10 hover:text-red-300"
              onClick={handleDeleteTeam}
            >
              <Trash2 size={12} />
            </Button>
          </div>
        </div>
      </div>

      <TeamProvisioningBanner teamName={teamName} />

      {data.warnings?.some((warning) => warning.toLowerCase().includes('kanban')) ? (
        <div className="mb-3 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200">
          Failed to fully load kanban. Displaying safe data.
        </div>
      ) : null}
      {reviewActionError ? (
        <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {reviewActionError}
        </div>
      ) : null}

      <CollapsibleTeamSection title="Members" badge={data.members.length} defaultOpen>
        <MemberList
          members={data.members}
          memberTaskCounts={memberTaskCounts}
          taskMap={taskMap}
          pendingRepliesByMember={pendingRepliesByMember}
          isTeamAlive={data.isAlive}
          isTeamProvisioning={isTeamProvisioning}
          onMemberClick={setSelectedMember}
          onSendMessage={(member) => {
            setSendDialogRecipient(member.name);
            setReplyQuote(undefined);
            setSendDialogOpen(true);
          }}
          onAssignTask={(member) => {
            openCreateTaskDialog('', '', member.name);
          }}
          onOpenTask={(task) => setSelectedTask(task)}
        />
      </CollapsibleTeamSection>

      <CollapsibleTeamSection title="Sessions" defaultOpen={false}>
        <TeamSessionsSection
          sessions={teamSessions}
          sessionsLoading={sessionsLoading}
          sessionsError={sessionsError}
          leadSessionId={data.config.leadSessionId}
          selectedSessionId={kanbanFilter.sessionId}
          onSelectSession={(id) => setKanbanFilter((prev) => ({ ...prev, sessionId: id }))}
          projectPath={data.config.projectPath}
        />
      </CollapsibleTeamSection>

      <CollapsibleTeamSection
        title="Kanban"
        badge={filteredTasks.length}
        defaultOpen
        forceOpen={kanbanSearch.trim().length > 0}
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
            Task
          </Button>
        }
      >
        <div className="relative mb-2">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
          />
          <input
            type="text"
            placeholder="Search tasks… (#id or text)"
            value={kanbanSearch}
            onChange={(e) => setKanbanSearch(e.target.value)}
            className="h-8 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-8 text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-border-emphasis)] focus:outline-none"
          />
          {kanbanSearch && (
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              onClick={() => setKanbanSearch('')}
            >
              <X size={14} />
            </button>
          )}
        </div>
        <KanbanBoard
          tasks={kanbanDisplayTasks}
          teamName={teamName}
          kanbanState={data.kanbanState}
          filter={kanbanFilter}
          sessions={teamSessions}
          leadSessionId={data.config.leadSessionId}
          members={data.members}
          onFilterChange={setKanbanFilter}
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
            void (async () => {
              await updateKanban(teamName, taskId, { op: 'remove' });
              await updateTaskStatus(teamName, taskId, 'completed');
            })();
          }}
          onStartTask={(taskId) => {
            void (async () => {
              try {
                await startTask(teamName, taskId);
                if (data?.isAlive) {
                  const task = data.tasks.find((t) => t.id === taskId);
                  if (task?.owner) {
                    try {
                      await api.teams.processSend(
                        teamName,
                        `Task #${taskId} "${task.subject}" has started. Please begin working on it.`
                      );
                    } catch {
                      // best-effort
                    }
                  }
                }
              } catch {
                // error via store
              }
            })();
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
          onTaskClick={(task) => setSelectedTask(task)}
        />
      </CollapsibleTeamSection>

      <CollapsibleTeamSection
        title="Messages"
        badge={filteredMessages.length}
        secondaryBadge={
          filteredMessages.length > 0 && messagesUnreadCount > 0 ? messagesUnreadCount : undefined
        }
        defaultOpen
        action={
          <div className="flex items-center gap-2 pl-2">
            <div className="flex w-36 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1">
              <Search size={12} className="shrink-0 text-[var(--color-text-muted)]" />
              <input
                type="search"
                placeholder="Search..."
                value={messagesSearchQuery}
                onChange={(e) => setMessagesSearchQuery(e.target.value)}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                className="min-w-0 flex-1 bg-transparent text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none"
              />
            </div>
            <MessagesFilterPopover
              filter={messagesFilter}
              messages={data?.messages ?? []}
              open={messagesFilterOpen}
              onOpenChange={setMessagesFilterOpen}
              onApply={setMessagesFilter}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0 gap-1.5 px-2.5 text-xs font-medium text-[var(--color-text)]"
              onClick={(e) => {
                e.stopPropagation();
                setSendDialogRecipient(undefined);
                setReplyQuote(undefined);
                setSendDialogOpen(true);
              }}
            >
              <MessageSquare size={12} />
              Message
            </Button>
          </div>
        }
      >
        <PendingRepliesBlock
          members={data.members}
          pendingRepliesByMember={pendingRepliesByMember}
          onMemberClick={setSelectedMember}
        />
        <ActiveTasksBlock
          members={data.members}
          tasks={data.tasks}
          onMemberClick={setSelectedMember}
          onTaskClick={setSelectedTask}
        />
        <ActivityTimeline
          messages={filteredMessages}
          members={data.members}
          readSet={readSet}
          getMessageKey={toMessageKey}
          onMemberClick={setSelectedMember}
          onCreateTaskFromMessage={(subject, description) => {
            openCreateTaskDialog(subject, description);
          }}
          onReplyToMessage={(message) => {
            setSendDialogRecipient(message.from);
            setReplyQuote({ from: message.from, text: message.text });
            setSendDialogOpen(true);
          }}
          onMessageVisible={handleMessageVisible}
        />
      </CollapsibleTeamSection>

      <ReviewDialog
        open={requestChangesTaskId !== null}
        teamName={teamName}
        taskId={requestChangesTaskId}
        members={data?.members ?? []}
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

      <MemberDetailDialog
        open={selectedMember !== null}
        member={selectedMember}
        teamName={teamName}
        tasks={data.tasks}
        messages={data.messages}
        isTeamAlive={data.isAlive}
        isTeamProvisioning={isTeamProvisioning}
        onClose={() => setSelectedMember(null)}
        onSendMessage={() => {
          const name = selectedMember?.name ?? '';
          setSelectedMember(null);
          setSendDialogRecipient(name || undefined);
          setReplyQuote(undefined);
          setSendDialogOpen(true);
        }}
        onAssignTask={() => {
          const name = selectedMember?.name ?? '';
          setSelectedMember(null);
          openCreateTaskDialog('', '', name);
        }}
        onTaskClick={(task) => {
          setSelectedMember(null);
          setSelectedTask(task);
        }}
      />

      <CreateTaskDialog
        open={createTaskDialog.open}
        teamName={teamName}
        members={data.members}
        tasks={data.tasks}
        isTeamAlive={data.isAlive && !isTeamProvisioning}
        defaultSubject={createTaskDialog.defaultSubject}
        defaultDescription={createTaskDialog.defaultDescription}
        defaultOwner={createTaskDialog.defaultOwner}
        onClose={closeCreateTaskDialog}
        onSubmit={handleCreateTask}
        submitting={creatingTask}
      />

      <EditTeamDialog
        open={editDialogOpen}
        teamName={teamName}
        currentName={data.config.name}
        currentDescription={data.config.description ?? ''}
        currentColor={data.config.color ?? ''}
        onClose={() => setEditDialogOpen(false)}
        onSaved={() => void selectTeam(teamName)}
      />

      <LaunchTeamDialog
        open={launchDialogOpen}
        teamName={teamName}
        members={data?.members ?? []}
        defaultProjectPath={data.config.projectPath}
        provisioningError={provisioningError}
        onClose={() => setLaunchDialogOpen(false)}
        onLaunch={async (request) => {
          await launchTeam(request);
        }}
      />

      <SendMessageDialog
        open={sendDialogOpen}
        members={data.members}
        defaultRecipient={sendDialogRecipient}
        quotedMessage={replyQuote}
        sending={sendingMessage}
        sendError={sendMessageError}
        lastResult={lastSendMessageResult}
        onSend={(member, text, summary) => {
          void (async () => {
            const sentAtMs = Date.now();
            setPendingRepliesByMember((prev) => ({ ...prev, [member]: sentAtMs }));
            try {
              await sendTeamMessage(teamName, { member, text, summary });
            } catch {
              setPendingRepliesByMember((prev) => {
                if (prev[member] !== sentAtMs) return prev;
                const next = { ...prev };
                delete next[member];
                return next;
              });
            }
          })();
        }}
        onClose={() => {
          setSendDialogOpen(false);
          setReplyQuote(undefined);
        }}
      />

      <TaskDetailDialog
        open={selectedTask !== null}
        task={selectedTask}
        teamName={teamName}
        kanbanTaskState={selectedTask ? data?.kanbanState.tasks[selectedTask.id] : undefined}
        taskMap={taskMap}
        members={data?.members ?? []}
        onClose={() => setSelectedTask(null)}
        onScrollToTask={(taskId) => {
          setSelectedTask(null);
          const el = document.querySelector(`[data-task-id="${taskId}"]`);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            el.classList.add('ring-2', 'ring-blue-400/50');
            setTimeout(() => el.classList.remove('ring-2', 'ring-blue-400/50'), 1500);
          }
        }}
      />
    </div>
  );
};
