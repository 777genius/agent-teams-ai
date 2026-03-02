import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useTeamMessagesRead } from '@renderer/hooks/useTeamMessagesRead';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { createChipFromSelection } from '@renderer/utils/chipUtils';
import { formatProjectPath } from '@renderer/utils/pathDisplay';
import { buildTaskCountsByOwner } from '@renderer/utils/pathNormalize';
import { nameColorSet } from '@renderer/utils/projectColor';
import { resolveProjectIdByPath } from '@renderer/utils/projectLookup';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import {
  AlertTriangle,
  Bell,
  CheckCheck,
  Code,
  Columns3,
  FolderOpen,
  GitBranch,
  History,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  Search,
  Square,
  Terminal,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { ActiveTasksBlock } from './activity/ActiveTasksBlock';
import { ActivityTimeline } from './activity/ActivityTimeline';
import { PendingRepliesBlock } from './activity/PendingRepliesBlock';
import { AddMemberDialog } from './dialogs/AddMemberDialog';
import { CreateTaskDialog } from './dialogs/CreateTaskDialog';
import { EditTeamDialog } from './dialogs/EditTeamDialog';
import { LaunchTeamDialog } from './dialogs/LaunchTeamDialog';
import { ReviewDialog } from './dialogs/ReviewDialog';
import { SendMessageDialog } from './dialogs/SendMessageDialog';
import { TaskDetailDialog } from './dialogs/TaskDetailDialog';
import { KanbanBoard } from './kanban/KanbanBoard';
import { UNASSIGNED_OWNER } from './kanban/KanbanFilterPopover';
import { TrashDialog } from './kanban/TrashDialog';
import { MemberDetailDialog } from './members/MemberDetailDialog';

const ProjectEditorOverlay = lazy(() =>
  import('./editor/ProjectEditorOverlay').then((m) => ({ default: m.ProjectEditorOverlay }))
);
import { MemberList } from './members/MemberList';
import { MessageComposer } from './messages/MessageComposer';
import { MessagesFilterPopover } from './messages/MessagesFilterPopover';
import { ChangeReviewDialog } from './review/ChangeReviewDialog';
import { CollapsibleTeamSection } from './CollapsibleTeamSection';
import { ProcessesSection } from './ProcessesSection';
import { TeamProvisioningBanner } from './TeamProvisioningBanner';
import { TeamSessionsSection } from './TeamSessionsSection';

import type { KanbanFilterState } from './kanban/KanbanFilterPopover';
import type { MessagesFilterState } from './messages/MessagesFilterPopover';
import type { Session } from '@renderer/types/data';
import type { InlineChip } from '@renderer/types/inlineChip';
import type { InboxMessage, ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';
import type { EditorSelectionAction } from '@shared/types/editor';

interface TeamDetailViewProps {
  teamName: string;
}

const ACTIVE_PROVISIONING_STATES = new Set(['validating', 'spawning', 'monitoring', 'verifying']);

interface CreateTaskDialogState {
  open: boolean;
  defaultSubject: string;
  defaultDescription: string;
  defaultOwner: string;
  defaultStartImmediately?: boolean;
  defaultChip?: InlineChip;
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
  const [addMemberDialogOpen, setAddMemberDialogOpen] = useState(false);
  const [addingMemberLoading, setAddingMemberLoading] = useState(false);
  const [removeMemberConfirm, setRemoveMemberConfirm] = useState<string | null>(null);
  const [updatingRoleLoading, setUpdatingRoleLoading] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [launchDialogOpen, setLaunchDialogOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Set inert on background content when editor overlay is open (a11y focus trap)
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    if (editorOpen) {
      el.setAttribute('inert', '');
    } else {
      el.removeAttribute('inert');
    }
  }, [editorOpen]);

  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [stoppingTeam, setStoppingTeam] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [sendDialogRecipient, setSendDialogRecipient] = useState<string | undefined>(undefined);
  const [sendDialogDefaultText, setSendDialogDefaultText] = useState<string | undefined>(undefined);
  const [sendDialogDefaultChip, setSendDialogDefaultChip] = useState<InlineChip | undefined>(
    undefined
  );
  const [replyQuote, setReplyQuote] = useState<{ from: string; text: string } | undefined>(
    undefined
  );
  const [reviewDialogState, setReviewDialogState] = useState<{
    open: boolean;
    mode: 'agent' | 'task';
    memberName?: string;
    taskId?: string;
    initialFilePath?: string;
  }>({ open: false, mode: 'task' });

  // Active teams for conflict warning in LaunchTeamDialog
  const [activeTeamsForLaunch, setActiveTeamsForLaunch] = useState<
    { teamName: string; displayName: string; projectPath: string }[]
  >([]);

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
    repositoryGroups,
    teams,
    selectTeam,
    updateKanban,
    updateKanbanColumnOrder,
    updateTaskStatus,
    updateTaskOwner,
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
    addMember,
    removeMember,
    updateMemberRole,
    launchTeam,
    provisioningError,
    isTeamProvisioning,
    leadActivityByTeam,
    refreshTeamData,
    kanbanFilterQuery,
    clearKanbanFilter,
    softDeleteTask,
    restoreTask,
    fetchDeletedTasks,
    deletedTasks,
  } = useStore(
    useShallow((s) => ({
      data: s.selectedTeamData,
      loading: s.selectedTeamLoading,
      error: s.selectedTeamError,
      projects: s.projects,
      repositoryGroups: s.repositoryGroups,
      teams: s.teams,
      selectTeam: s.selectTeam,
      updateKanban: s.updateKanban,
      updateKanbanColumnOrder: s.updateKanbanColumnOrder,
      updateTaskStatus: s.updateTaskStatus,
      updateTaskOwner: s.updateTaskOwner,
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
      addMember: s.addMember,
      removeMember: s.removeMember,
      updateMemberRole: s.updateMemberRole,
      launchTeam: s.launchTeam,
      provisioningError: s.provisioningError,
      isTeamProvisioning: Object.values(s.provisioningRuns).some(
        (run) => run.teamName === teamName && ACTIVE_PROVISIONING_STATES.has(run.state)
      ),
      leadActivityByTeam: s.leadActivityByTeam,
      refreshTeamData: s.refreshTeamData,
      kanbanFilterQuery: s.kanbanFilterQuery,
      clearKanbanFilter: s.clearKanbanFilter,
      softDeleteTask: s.softDeleteTask,
      restoreTask: s.restoreTask,
      fetchDeletedTasks: s.fetchDeletedTasks,
      deletedTasks: s.deletedTasks,
    }))
  );

  const [kanbanSearch, setKanbanSearch] = useState('');
  const [messagesSearchQuery, setMessagesSearchQuery] = useState('');
  const [messagesFilter, setMessagesFilter] = useState<MessagesFilterState>({
    from: new Set(),
    to: new Set(),
  });
  const [messagesFilterOpen, setMessagesFilterOpen] = useState(false);

  // Open editor overlay when a file reveal is requested (e.g. from chip click)
  const pendingRevealFile = useStore((s) => s.editorPendingRevealFile);
  useEffect(() => {
    if (pendingRevealFile && data?.config.projectPath) {
      setEditorOpen(true);
    }
  }, [pendingRevealFile, data?.config.projectPath]);

  useEffect(() => {
    if (!teamName) {
      return;
    }
    void selectTeam(teamName);
    void fetchDeletedTasks(teamName);
  }, [teamName, selectTeam, fetchDeletedTasks]);

  // Fetch active teams when launch dialog opens (for conflict warning)
  useEffect(() => {
    if (!launchDialogOpen) return;
    let cancelled = false;
    void (async () => {
      try {
        const aliveList = await api.teams.aliveList();
        if (cancelled) return;
        const aliveSet = new Set(aliveList);
        const refs = teams
          .filter((t) => aliveSet.has(t.teamName) && t.projectPath)
          .map((t) => ({
            teamName: t.teamName,
            displayName: t.displayName,
            projectPath: t.projectPath!,
          }));
        setActiveTeamsForLaunch(refs);
      } catch {
        // best-effort
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [launchDialogOpen, teams]);

  useEffect(() => {
    if (kanbanFilterQuery) {
      setKanbanSearch(kanbanFilterQuery);
      clearKanbanFilter();
    }
  }, [kanbanFilterQuery, clearKanbanFilter]);

  // Load sessions for the team's project
  const projectId = useMemo(
    () => resolveProjectIdByPath(data?.config.projectPath, projects, repositoryGroups),
    [projects, repositoryGroups, data?.config.projectPath]
  );

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

  // Resolve lead's git branch from project path
  const [leadBranch, setLeadBranch] = useState<string | null>(null);
  useEffect(() => {
    const projectPath = data?.config.projectPath?.trim();
    if (!projectPath || typeof api.teams?.getProjectBranch !== 'function') {
      setLeadBranch(null);
      return;
    }
    let cancelled = false;
    void api.teams.getProjectBranch(projectPath).then(
      (branch) => {
        if (!cancelled) setLeadBranch(branch);
      },
      () => {
        if (!cancelled) setLeadBranch(null);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [data?.config.projectPath]);

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

  const { readSet, markRead, markAllRead } = useTeamMessagesRead(teamName ?? '');
  const messagesUnreadCount = useMemo(
    () => filteredMessages.filter((m) => !m.read && !readSet.has(toMessageKey(m))).length,
    [filteredMessages, readSet]
  );
  const handleMessageVisible = useCallback(
    (message: InboxMessage) => markRead(toMessageKey(message)),
    [markRead]
  );
  const handleMarkAllRead = useCallback(() => {
    const keys = filteredMessages
      .filter((m) => !m.read && !readSet.has(toMessageKey(m)))
      .map((m) => toMessageKey(m));
    markAllRead(keys);
  }, [filteredMessages, readSet, markAllRead]);

  const kanbanDisplayTasks = useMemo(() => {
    const query = kanbanSearch.trim();
    if (!query) return filteredTasks;
    return filterKanbanTasks(filteredTasks, query);
  }, [filteredTasks, kanbanSearch]);

  const activeMembers = useMemo(
    () => (data?.members ?? []).filter((m) => !m.removedAt),
    [data?.members]
  );

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

  const openCreateTaskDialog = (
    subject = '',
    description = '',
    owner = '',
    startImmediately?: boolean
  ): void => {
    setCreateTaskDialog({
      open: true,
      defaultSubject: subject,
      defaultDescription: description,
      defaultOwner: owner,
      defaultStartImmediately: startImmediately,
    });
  };

  const closeCreateTaskDialog = (): void => {
    setCreateTaskDialog({
      open: false,
      defaultSubject: '',
      defaultDescription: '',
      defaultOwner: '',
      defaultStartImmediately: undefined,
    });
  };

  const handleEditorAction = useCallback(
    (action: EditorSelectionAction) => {
      const chip = createChipFromSelection(action, []) ?? undefined;
      if (action.type === 'sendMessage') {
        setSendDialogDefaultText(chip ? undefined : action.formattedContext);
        setSendDialogDefaultChip(chip);
        setSendDialogRecipient(undefined);
        setReplyQuote(undefined);
        setSendDialogOpen(true);
      } else if (action.type === 'createTask') {
        if (chip) {
          setCreateTaskDialog({
            open: true,
            defaultSubject: '',
            defaultDescription: '',
            defaultOwner: '',
            defaultStartImmediately: undefined,
            defaultChip: chip,
          });
        } else {
          openCreateTaskDialog('', action.formattedContext);
        }
      }
    },

    []
  );

  const handleStopTeam = useCallback(async (): Promise<void> => {
    setStoppingTeam(true);
    try {
      await api.teams.stop(teamName);
      // Backend sends 'disconnected' progress which triggers store refresh,
      // but refresh here too as a safety net (e.g. if progress event is missed).
      await refreshTeamData(teamName);
    } catch (err) {
      console.error('Failed to stop team:', err);
    } finally {
      setStoppingTeam(false);
    }
  }, [teamName, refreshTeamData]);

  const selectReviewFile = useStore((s) => s.selectReviewFile);
  const pendingReviewRequest = useStore((s) => s.pendingReviewRequest);
  const setPendingReviewRequest = useStore((s) => s.setPendingReviewRequest);

  // Pick up pending review request from GlobalTaskDetailDialog
  useEffect(() => {
    if (!pendingReviewRequest) return;
    setReviewDialogState({
      open: true,
      mode: 'task',
      taskId: pendingReviewRequest.taskId,
      initialFilePath: pendingReviewRequest.filePath,
    });
    if (pendingReviewRequest.filePath) {
      selectReviewFile(pendingReviewRequest.filePath);
    }
    setPendingReviewRequest(null);
  }, [pendingReviewRequest, selectReviewFile, setPendingReviewRequest]);

  const handleDeleteTask = useCallback(
    (taskId: string) => {
      void (async () => {
        const confirmed = await confirm({
          title: 'Delete task',
          message: `Move task #${taskId} to trash?`,
          confirmLabel: 'Delete',
          cancelLabel: 'Cancel',
          variant: 'danger',
        });
        if (confirmed) {
          void softDeleteTask(teamName, taskId);
        }
      })();
    },
    [teamName, softDeleteTask]
  );

  const handleViewChanges = useCallback((taskId: string) => {
    setReviewDialogState({ open: true, mode: 'task', taskId });
  }, []);

  const handleViewChangesForFile = useCallback(
    (taskId: string, filePath?: string) => {
      setReviewDialogState({ open: true, mode: 'task', taskId });
      if (filePath) {
        selectReviewFile(filePath);
      }
    },
    [selectReviewFile]
  );

  const handleDeleteTeam = useCallback((): void => {
    setDeleteConfirmOpen(true);
  }, []);

  const confirmDeleteTeam = useCallback((): void => {
    setDeleteConfirmOpen(false);
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

  const headerColorSet = data.config.color
    ? getTeamColorSet(data.config.color)
    : nameColorSet(data.config.name);

  return (
    <>
      <div ref={contentRef} className="size-full overflow-auto p-4" data-team-name={teamName}>
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
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-[var(--color-text)]">
                {data.config.name}
              </h2>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {data.isAlive && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 px-2 text-xs text-red-400 hover:bg-red-500/10 hover:text-red-300"
                      disabled={stoppingTeam}
                      onClick={() => void handleStopTeam()}
                    >
                      <Square size={12} className={stoppingTeam ? 'animate-pulse' : ''} />
                      Stop
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Stop team</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                    onClick={() => setEditDialogOpen(true)}
                  >
                    <Pencil size={12} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Edit team</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs text-red-400 hover:bg-red-500/10 hover:text-red-300"
                    onClick={handleDeleteTeam}
                  >
                    <Trash2 size={12} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Delete team</TooltipContent>
              </Tooltip>
            </div>
          </div>
          {data.config.description && (
            <p
              className={cn(
                'min-w-0 truncate text-xs text-[var(--color-text-muted)]',
                headerColorSet && 'relative z-10'
              )}
            >
              {data.config.description}
            </p>
          )}
          {(data.config.projectPath || leadBranch) && (
            <div
              className={cn(
                'mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5',
                headerColorSet && 'relative z-10'
              )}
            >
              {data.config.projectPath && (
                <span
                  className="flex items-center gap-1 text-[11px] text-[var(--color-text-secondary)]"
                  title={data.config.projectPath}
                >
                  <FolderOpen size={11} className="shrink-0 text-[var(--color-text-muted)]" />
                  <span className="max-w-60 truncate font-mono">
                    {formatProjectPath(data.config.projectPath)}
                  </span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => setEditorOpen(true)}
                        className="ml-1 flex items-center gap-0.5 rounded border border-[var(--color-border-emphasis)] bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-border-emphasis)] hover:text-[var(--color-text)]"
                      >
                        <Code size={10} className="shrink-0" /> Edit code
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Open project in built-in editor</TooltipContent>
                  </Tooltip>
                </span>
              )}
              {leadBranch && (
                <span
                  className="flex items-center gap-1 text-[11px] text-[var(--color-text-secondary)]"
                  title={leadBranch}
                >
                  <GitBranch size={11} className="shrink-0 text-[var(--color-text-muted)]" />
                  <span className="max-w-32 truncate">{leadBranch}</span>
                </span>
              )}
              {data.isAlive && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
                  <span className="size-1.5 rounded-full bg-emerald-400" />
                  Running
                </span>
              )}
              {!data.isAlive && isTeamProvisioning && (
                <span className="inline-flex items-center gap-1 rounded-full bg-yellow-500/15 px-1.5 py-0.5 text-[10px] font-medium text-yellow-400">
                  <span className="size-1.5 animate-pulse rounded-full bg-yellow-400" />
                  Launching...
                </span>
              )}
            </div>
          )}
          {(() => {
            const currentPath = data.config.projectPath;
            const history = data.config.projectPathHistory?.filter((p) => p !== currentPath);
            if (!history || history.length === 0) return null;
            return (
              <div
                className={cn(
                  'mt-0.5 flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]',
                  headerColorSet && 'relative z-10'
                )}
              >
                <History size={10} className="shrink-0" />
                <span className="truncate">
                  Previous: {history.map((p) => formatProjectPath(p)).join(', ')}
                </span>
              </div>
            );
          })()}
        </div>

        {!data.isAlive && !isTeamProvisioning ? (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
            <span className="flex items-center gap-1.5 text-xs text-amber-200">
              <AlertTriangle size={14} className="shrink-0 text-amber-400" />
              Team is offline
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1 px-2 text-xs text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
              onClick={() => setLaunchDialogOpen(true)}
            >
              <Play size={12} />
              Launch
            </Button>
          </div>
        ) : null}

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

        <CollapsibleTeamSection
          sectionId="team"
          title="Team"
          icon={<Users size={14} />}
          badge={activeMembers.length}
          defaultOpen
          action={
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              onClick={(e) => {
                e.stopPropagation();
                setAddMemberDialogOpen(true);
              }}
            >
              <UserPlus size={12} />
              Member
            </Button>
          }
        >
          <MemberList
            members={data.members}
            memberTaskCounts={memberTaskCounts}
            taskMap={taskMap}
            pendingRepliesByMember={pendingRepliesByMember}
            isTeamAlive={data.isAlive}
            isTeamProvisioning={isTeamProvisioning}
            leadActivity={leadActivityByTeam[teamName]}
            onMemberClick={setSelectedMember}
            onSendMessage={(member) => {
              setSendDialogRecipient(member.name);
              setSendDialogDefaultText(undefined);
              setSendDialogDefaultChip(undefined);
              setReplyQuote(undefined);
              setSendDialogOpen(true);
            }}
            onAssignTask={(member) => {
              openCreateTaskDialog('', '', member.name);
            }}
            onOpenTask={(task) => setSelectedTask(task)}
          />
        </CollapsibleTeamSection>

        <CollapsibleTeamSection
          sectionId="sessions"
          title="Sessions"
          icon={<History size={14} />}
          defaultOpen={false}
        >
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
          sectionId="kanban"
          title="Kanban"
          icon={<Columns3 size={14} />}
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
          <KanbanBoard
            tasks={kanbanDisplayTasks}
            teamName={teamName}
            kanbanState={data.kanbanState}
            filter={kanbanFilter}
            sessions={teamSessions}
            leadSessionId={data.config.leadSessionId}
            members={activeMembers}
            onFilterChange={setKanbanFilter}
            toolbarLeft={
              <div className="relative max-w-[240px]">
                <Search
                  size={14}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
                />
                <input
                  type="text"
                  placeholder="Search tasks… (#id or text)"
                  value={kanbanSearch}
                  onChange={(e) => setKanbanSearch(e.target.value)}
                  className="h-8 w-full min-w-[140px] max-w-[240px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-8 text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-border-emphasis)] focus:outline-none"
                />
                {kanbanSearch && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                        onClick={() => setKanbanSearch('')}
                      >
                        <X size={14} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Clear search</TooltipContent>
                  </Tooltip>
                )}
              </div>
            }
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
                  const result = await startTask(teamName, taskId);
                  if (data?.isAlive) {
                    const task = data.tasks.find((t) => t.id === taskId);
                    try {
                      if (result.notifiedOwner && task?.owner) {
                        await api.teams.processSend(
                          teamName,
                          `Task #${taskId} "${task.subject}" has started. Please begin working on it.`
                        );
                      } else if (!result.notifiedOwner) {
                        const desc = task?.description?.trim()
                          ? `\nDescription: ${task.description.trim()}`
                          : '';
                        await api.teams.processSend(
                          teamName,
                          `Task #${taskId} "${task?.subject ?? ''}" has been moved to IN PROGRESS but has no assignee.${desc}\nPlease assign it to an available team member, or take it yourself if everyone is busy.`
                        );
                      }
                    } catch {
                      // best-effort
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
            onCancelTask={(taskId) => {
              void (async () => {
                try {
                  const task = data?.tasks.find((t) => t.id === taskId);
                  await updateTaskStatus(teamName, taskId, 'pending');

                  // Notify assignee directly via inbox — they'll see it immediately
                  if (task?.owner) {
                    try {
                      await api.teams.sendMessage(teamName, {
                        member: task.owner,
                        text: `Task #${taskId} "${task.subject}" has been CANCELLED by the user and moved back to TODO. Stop working on it immediately.`,
                        summary: `Task #${taskId} cancelled`,
                      });
                    } catch {
                      // best-effort
                    }
                  }

                  // Also notify team lead so they can reassign/coordinate
                  if (data?.isAlive) {
                    try {
                      const ownerSuffix = task?.owner
                        ? ` ${task.owner} has been notified to stop.`
                        : '';
                      await api.teams.processSend(
                        teamName,
                        `Task #${taskId} "${task?.subject ?? ''}" has been cancelled and moved back to TODO.${ownerSuffix}`
                      );
                    } catch {
                      // best-effort
                    }
                  }
                } catch {
                  // error via store
                }
              })();
            }}
            onColumnOrderChange={(columnId, orderedTaskIds) => {
              void updateKanbanColumnOrder(teamName, columnId, orderedTaskIds);
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
            onViewChanges={handleViewChanges}
            onAddTask={(startImmediately) => openCreateTaskDialog('', '', '', startImmediately)}
            onDeleteTask={handleDeleteTask}
            deletedTaskCount={deletedTasks.length}
            onOpenTrash={() => setTrashOpen(true)}
          />
        </CollapsibleTeamSection>

        {(data.processes?.length ?? 0) > 0 && (
          <CollapsibleTeamSection
            sectionId="processes"
            title="CLI Processes"
            icon={<Terminal size={14} />}
            badge={data.processes.filter((p) => !p.stoppedAt).length}
            defaultOpen
          >
            <ProcessesSection />
          </CollapsibleTeamSection>
        )}

        <CollapsibleTeamSection
          sectionId="messages"
          title="Messages"
          icon={<MessageSquare size={14} />}
          badge={filteredMessages.length}
          secondaryBadge={
            filteredMessages.length > 0 && messagesUnreadCount > 0 ? messagesUnreadCount : undefined
          }
          headerExtra={
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="pointer-events-auto size-6 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                  onClick={(e) => {
                    e.stopPropagation();
                    void window.electronAPI.openExternal(
                      'https://github.com/777genius/claude-notifications-go'
                    );
                  }}
                >
                  <Bell size={12} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Desktop notifications plugin</TooltipContent>
            </Tooltip>
          }
          defaultOpen
          action={
            <div className="flex items-center gap-2 pl-2">
              {messagesUnreadCount > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="pointer-events-auto flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-blue-400 transition-colors hover:bg-blue-500/10"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleMarkAllRead();
                      }}
                    >
                      <CheckCheck size={12} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Mark all as read</TooltipContent>
                </Tooltip>
              )}
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
            </div>
          }
        >
          <MessageComposer
            teamName={teamName}
            members={activeMembers}
            isTeamAlive={data.isAlive}
            sending={sendingMessage}
            sendError={sendMessageError}
            onSend={(member, text, summary, attachments) => {
              const sentAtMs = Date.now();
              setPendingRepliesByMember((prev) => ({ ...prev, [member]: sentAtMs }));
              void sendTeamMessage(teamName, { member, text, summary, attachments }).catch(() => {
                setPendingRepliesByMember((prev) => {
                  if (prev[member] !== sentAtMs) return prev;
                  const next = { ...prev };
                  delete next[member];
                  return next;
                });
              });
            }}
          />
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
            teamName={teamName}
            members={data.members}
            readState={{ readSet, getMessageKey: toMessageKey }}
            onMemberClick={setSelectedMember}
            onCreateTaskFromMessage={(subject, description) => {
              openCreateTaskDialog(subject, description);
            }}
            onReplyToMessage={(message) => {
              setSendDialogRecipient(message.from);
              setSendDialogDefaultText(undefined);
              setSendDialogDefaultChip(undefined);
              setReplyQuote({ from: message.from, text: stripAgentBlocks(message.text) });
              setSendDialogOpen(true);
            }}
            onMessageVisible={handleMessageVisible}
            onTaskIdClick={(taskId) => {
              const task = taskMap.get(taskId);
              if (task) setSelectedTask(task);
            }}
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
          leadActivity={leadActivityByTeam[teamName]}
          onClose={() => setSelectedMember(null)}
          onSendMessage={() => {
            const name = selectedMember?.name ?? '';
            setSelectedMember(null);
            setSendDialogRecipient(name || undefined);
            setSendDialogDefaultText(undefined);
            setSendDialogDefaultChip(undefined);
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
          onUpdateRole={async (memberName, role) => {
            setUpdatingRoleLoading(true);
            try {
              await updateMemberRole(teamName, memberName, role);
              // Optimistically update local selectedMember to reflect new role
              setSelectedMember((prev) => {
                if (prev?.name !== memberName) return prev;
                const normalized =
                  typeof role === 'string' && role.trim() ? role.trim() : undefined;
                return { ...prev, role: normalized };
              });
            } finally {
              setUpdatingRoleLoading(false);
            }
          }}
          updatingRole={updatingRoleLoading}
          onRemoveMember={() => {
            const name = selectedMember?.name;
            if (!name) return;
            setRemoveMemberConfirm(name);
          }}
          onViewMemberChanges={(memberName, filePath) => {
            setSelectedMember(null);
            setReviewDialogState({
              open: true,
              mode: 'agent',
              memberName,
              initialFilePath: filePath,
            });
          }}
        />

        <CreateTaskDialog
          open={createTaskDialog.open}
          teamName={teamName}
          members={activeMembers}
          tasks={data.tasks}
          isTeamAlive={data.isAlive && !isTeamProvisioning}
          defaultSubject={createTaskDialog.defaultSubject}
          defaultDescription={createTaskDialog.defaultDescription}
          defaultOwner={createTaskDialog.defaultOwner}
          defaultStartImmediately={createTaskDialog.defaultStartImmediately}
          defaultChip={createTaskDialog.defaultChip}
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

        <AddMemberDialog
          open={addMemberDialogOpen}
          teamName={teamName}
          existingNames={data.members.map((m) => m.name)}
          adding={addingMemberLoading}
          onClose={() => setAddMemberDialogOpen(false)}
          onAdd={(name, role) => {
            setAddingMemberLoading(true);
            void (async () => {
              try {
                await addMember(teamName, { name, role });
                setAddMemberDialogOpen(false);
              } catch {
                // error shown via store
              } finally {
                setAddingMemberLoading(false);
              }
            })();
          }}
        />

        <Dialog
          open={removeMemberConfirm !== null}
          onOpenChange={(open) => {
            if (!open) setRemoveMemberConfirm(null);
          }}
        >
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Remove member</DialogTitle>
              <DialogDescription>
                Remove &ldquo;{removeMemberConfirm}&rdquo; from the team? Tasks and messages will be
                preserved, but this name cannot be reused.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setRemoveMemberConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  const name = removeMemberConfirm;
                  setRemoveMemberConfirm(null);
                  setSelectedMember(null);
                  if (name) void removeMember(teamName, name);
                }}
              >
                Remove
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Delete team</DialogTitle>
              <DialogDescription>
                Delete team &ldquo;{data.config.name}&rdquo;? This action is irreversible. All team
                data and tasks will be deleted.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setDeleteConfirmOpen(false)}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={confirmDeleteTeam}>
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <LaunchTeamDialog
          open={launchDialogOpen}
          teamName={teamName}
          members={data?.members ?? []}
          defaultProjectPath={data.config.projectPath}
          provisioningError={provisioningError}
          activeTeams={activeTeamsForLaunch}
          onClose={() => setLaunchDialogOpen(false)}
          onLaunch={async (request) => {
            await launchTeam(request);
          }}
        />

        <SendMessageDialog
          open={sendDialogOpen}
          members={activeMembers}
          defaultRecipient={sendDialogRecipient}
          defaultText={sendDialogDefaultText}
          defaultChip={sendDialogDefaultChip}
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
            setSendDialogDefaultText(undefined);
            setSendDialogDefaultChip(undefined);
          }}
        />

        <TaskDetailDialog
          open={selectedTask !== null}
          task={selectedTask}
          teamName={teamName}
          kanbanTaskState={selectedTask ? data?.kanbanState.tasks[selectedTask.id] : undefined}
          taskMap={taskMap}
          members={activeMembers}
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
          onOwnerChange={(taskId, owner) => {
            void updateTaskOwner(teamName, taskId, owner);
          }}
          onViewChanges={handleViewChangesForFile}
          onDeleteTask={handleDeleteTask}
        />

        <TrashDialog
          open={trashOpen}
          tasks={deletedTasks}
          onClose={() => setTrashOpen(false)}
          onRestore={(taskId) => {
            void restoreTask(teamName, taskId);
          }}
        />

        <ChangeReviewDialog
          open={reviewDialogState.open}
          onOpenChange={(open) =>
            setReviewDialogState((prev) => ({
              ...prev,
              open,
              ...(open ? {} : { initialFilePath: undefined }),
            }))
          }
          teamName={teamName}
          mode={reviewDialogState.mode}
          memberName={reviewDialogState.memberName}
          taskId={reviewDialogState.taskId}
          initialFilePath={reviewDialogState.initialFilePath}
          projectPath={data.config.projectPath}
          onEditorAction={handleEditorAction}
        />
      </div>

      {editorOpen && data.config.projectPath && (
        <Suspense fallback={null}>
          <ProjectEditorOverlay
            projectPath={data.config.projectPath}
            onClose={() => setEditorOpen(false)}
            onEditorAction={handleEditorAction}
          />
        </Suspense>
      )}
    </>
  );
};
