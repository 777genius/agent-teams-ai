import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { SessionContextPanel } from '@renderer/components/chat/SessionContextPanel/index';
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
import { getTeamColorSet, getThemedBadge } from '@renderer/constants/teamColors';
import { useBranchSync } from '@renderer/hooks/useBranchSync';
import { useResizablePanel } from '@renderer/hooks/useResizablePanel';
import { useTabUI } from '@renderer/hooks/useTabUI';
import { useTheme } from '@renderer/hooks/useTheme';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { isTeamProvisioningActive } from '@renderer/store/slices/teamSlice';
import { createChipFromSelection } from '@renderer/utils/chipUtils';
import { formatPercentOfTotal, sumContextInjectionTokens } from '@renderer/utils/contextMath';
import { formatProjectPath } from '@renderer/utils/pathDisplay';
import { buildTaskCountsByOwner, normalizePath } from '@renderer/utils/pathNormalize';
import { nameColorSet } from '@renderer/utils/projectColor';
import { resolveProjectIdByPath } from '@renderer/utils/projectLookup';
import {
  buildTaskChangeRequestOptions,
  type TaskChangeRequestOptions,
} from '@renderer/utils/taskChangeRequest';
import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import { isLeadAgentType, isLeadMember } from '@shared/utils/leadDetection';
import { deriveTaskDisplayId, formatTaskDisplayLabel } from '@shared/utils/taskIdentity';
import {
  AlertTriangle,
  Clock,
  Code,
  Columns3,
  FolderOpen,
  GitBranch,
  History,
  Network,
  Pencil,
  Play,
  Plus,
  Square,
  Terminal,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { AddMemberDialog } from './dialogs/AddMemberDialog';
import { CreateTaskDialog } from './dialogs/CreateTaskDialog';
import { EditTeamDialog } from './dialogs/EditTeamDialog';
import { LaunchTeamDialog } from './dialogs/LaunchTeamDialog';
import { ReviewDialog } from './dialogs/ReviewDialog';
import { SendMessageDialog } from './dialogs/SendMessageDialog';
import { TaskDetailDialog } from './dialogs/TaskDetailDialog';
import { KanbanBoard } from './kanban/KanbanBoard';
import { UNASSIGNED_OWNER } from './kanban/KanbanFilterPopover';
import { KanbanSearchInput } from './kanban/KanbanSearchInput';
import { TrashDialog } from './kanban/TrashDialog';
import { MemberDetailDialog } from './members/MemberDetailDialog';

import type { AddMemberEntry } from './dialogs/AddMemberDialog';

const ProjectEditorOverlay = lazy(() =>
  import('./editor/ProjectEditorOverlay').then((m) => ({ default: m.ProjectEditorOverlay }))
);
const TeamGraphOverlay = lazy(() =>
  import('@renderer/features/agent-graph/ui/TeamGraphOverlay').then((m) => ({
    default: m.TeamGraphOverlay,
  }))
);
import { MemberList } from './members/MemberList';
import { MessagesPanel } from './messages/MessagesPanel';
import { ChangeReviewDialog } from './review/ChangeReviewDialog';
import { ScheduleSection } from './schedule/ScheduleSection';
import { ClaudeLogsSection } from './ClaudeLogsSection';
import { CollapsibleTeamSection } from './CollapsibleTeamSection';
import { ProcessesSection } from './ProcessesSection';
import { TeamSidebarHost } from './sidebar/TeamSidebarHost';
import { TeamSidebarPortalSource } from './sidebar/TeamSidebarPortalSource';
import { TeamSidebarRail } from './sidebar/TeamSidebarRail';
import { TeamProvisioningBanner } from './TeamProvisioningBanner';
import { TeamSessionsSection } from './TeamSessionsSection';

import type { KanbanFilterState } from './kanban/KanbanFilterPopover';
import type { KanbanSortState } from './kanban/KanbanSortPopover';
import type { ContextInjection } from '@renderer/types/contextInjection';
import type { Session } from '@renderer/types/data';
import type { InlineChip } from '@renderer/types/inlineChip';
import type {
  MemberSpawnStatusEntry,
  ResolvedTeamMember,
  TaskRef,
  TeamTaskWithKanban,
} from '@shared/types';
import type { EditorSelectionAction } from '@shared/types/editor';

interface TeamDetailViewProps {
  teamName: string;
  isPaneFocused?: boolean;
}

interface CreateTaskDialogState {
  open: boolean;
  defaultSubject: string;
  defaultDescription: string;
  defaultOwner: string;
  defaultStartImmediately?: boolean;
  defaultChip?: InlineChip;
}

function areResolvedMembersEqual(
  prev: readonly ResolvedTeamMember[],
  next: readonly ResolvedTeamMember[]
): boolean {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;

  for (let i = 0; i < prev.length; i++) {
    const prevMember = prev[i];
    const nextMember = next[i];
    if (
      prevMember.name !== nextMember.name ||
      prevMember.status !== nextMember.status ||
      prevMember.currentTaskId !== nextMember.currentTaskId ||
      prevMember.color !== nextMember.color ||
      prevMember.agentType !== nextMember.agentType ||
      prevMember.role !== nextMember.role ||
      prevMember.workflow !== nextMember.workflow ||
      prevMember.cwd !== nextMember.cwd ||
      prevMember.gitBranch !== nextMember.gitBranch ||
      prevMember.removedAt !== nextMember.removedAt
    ) {
      return false;
    }
  }

  return true;
}

function useStableActiveMembers(
  members: readonly ResolvedTeamMember[] | undefined
): ResolvedTeamMember[] {
  const filteredMembers = useMemo(
    () => (members ?? []).filter((member) => !member.removedAt),
    [members]
  );
  const stableMembersRef = useRef(filteredMembers);

  if (!areResolvedMembersEqual(stableMembersRef.current, filteredMembers)) {
    stableMembersRef.current = filteredMembers;
  }

  return stableMembersRef.current;
}

interface TimeWindow {
  start: number;
  end: number;
}

function filterKanbanTasks(tasks: TeamTaskWithKanban[], query: string): TeamTaskWithKanban[] {
  if (query.startsWith('#')) {
    const id = query.slice(1);
    return tasks.filter((t) => t.id === id || t.displayId === id);
  }
  const lower = query.toLowerCase();
  return tasks.filter(
    (t) =>
      t.id.toLowerCase().includes(lower) ||
      (t.displayId?.toLowerCase().includes(lower) ?? false) ||
      t.subject.toLowerCase().includes(lower) ||
      (t.owner?.toLowerCase().includes(lower) ?? false)
  );
}

export const TeamDetailView = ({
  teamName,
  isPaneFocused = false,
}: TeamDetailViewProps): React.JSX.Element => {
  const { isLight } = useTheme();
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
  const [graphOpen, setGraphOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const provisioningBannerRef = useRef<HTMLDivElement>(null);
  const wasProvisioningRef = useRef(false);

  // Set inert on background content when editor/graph overlay is open (a11y focus trap)
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    if (editorOpen || graphOpen) {
      el.setAttribute('inert', '');
    } else {
      el.removeAttribute('inert');
    }
  }, [editorOpen, graphOpen]);

  // Listen for Cmd+Shift+G keyboard shortcut — opens graph tab
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.teamName === teamName) {
        useStore.getState().openTab({
          type: 'graph',
          label: `${teamName} Graph`,
          teamName,
        });
      }
    };
    window.addEventListener('toggle-team-graph', handler);
    return () => window.removeEventListener('toggle-team-graph', handler);
  }, [teamName]);

  // Listen for graph tab actions (open task, send message)
  useEffect(() => {
    const onOpenTask = (e: Event) => {
      const { teamName: tn, taskId } = (e as CustomEvent).detail ?? {};
      if (tn !== teamName || !data) return;
      const task = data.tasks.find((t: { id: string }) => t.id === taskId);
      if (task) setSelectedTask(task);
    };
    const onSendMsg = (e: Event) => {
      const { teamName: tn, memberName } = (e as CustomEvent).detail ?? {};
      if (tn !== teamName) return;
      setSendDialogRecipient(memberName);
      setSendDialogDefaultText(undefined);
      setSendDialogDefaultChip(undefined);
      setSendDialogOpen(true);
    };
    const onOpenProfile = (e: Event) => {
      const { teamName: tn, memberName } = (e as CustomEvent).detail ?? {};
      if (tn !== teamName || !data) return;
      const member = data.members.find((m: { name: string }) => m.name === memberName);
      if (member) setSelectedMember(member);
    };
    const onCreateTask = (e: Event) => {
      const { teamName: tn, owner } = (e as CustomEvent).detail ?? {};
      if (tn !== teamName) return;
      openCreateTaskDialog('', '', owner ?? '');
    };
    window.addEventListener('graph:open-task', onOpenTask);
    window.addEventListener('graph:send-message', onSendMsg);
    window.addEventListener('graph:open-profile', onOpenProfile);
    window.addEventListener('graph:create-task', onCreateTask);
    return () => {
      window.removeEventListener('graph:open-task', onOpenTask);
      window.removeEventListener('graph:send-message', onSendMsg);
      window.removeEventListener('graph:open-profile', onOpenProfile);
      window.removeEventListener('graph:create-task', onCreateTask);
    };
  });

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
    taskChangeRequestOptions?: TaskChangeRequestOptions;
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
    columns: new Set(),
  });
  const [kanbanSort, setKanbanSort] = useState<KanbanSortState>({ field: 'updatedAt' });

  const {
    data,
    loading,
    error,
    projects,
    repositoryGroups,
    teams,
    fetchSessionDetail,
    initTabUIState,
    selectTeam,
    updateKanban,
    updateKanbanColumnOrder,
    updateTaskStatus,
    updateTaskOwner,
    sendTeamMessage,
    requestReview,
    createTeamTask,
    startTaskByUser,
    deleteTeam,
    openTeamsTab,
    closeTab,
    sendingMessage,
    sendMessageError,
    lastSendMessageResult,
    reviewActionError,
    addMember,
    removeMember,
    updateMemberRole,
    launchTeam,
    provisioningError,
    clearProvisioningError,
    isTeamProvisioning,
    leadActivityByTeam,
    leadContextUpdatedAt,
    memberSpawnStatuses,
    fetchMemberSpawnStatuses,
    refreshTeamData,
    kanbanFilterQuery,
    clearKanbanFilter,
    softDeleteTask,
    restoreTask,
    fetchDeletedTasks,
    deletedTasks,
    launchParams,
    messagesPanelMode,
    messagesPanelWidth,
    setMessagesPanelMode,
    setMessagesPanelWidth,
  } = useStore(
    useShallow((s) => ({
      data: s.selectedTeamData,
      loading: s.selectedTeamLoading,
      error: s.selectedTeamError,
      projects: s.projects,
      repositoryGroups: s.repositoryGroups,
      teams: s.teams,
      fetchSessionDetail: s.fetchSessionDetail,
      initTabUIState: s.initTabUIState,
      selectTeam: s.selectTeam,
      updateKanban: s.updateKanban,
      updateKanbanColumnOrder: s.updateKanbanColumnOrder,
      updateTaskStatus: s.updateTaskStatus,
      updateTaskOwner: s.updateTaskOwner,
      sendTeamMessage: s.sendTeamMessage,
      requestReview: s.requestReview,
      createTeamTask: s.createTeamTask,
      startTaskByUser: s.startTaskByUser,
      deleteTeam: s.deleteTeam,
      openTeamsTab: s.openTeamsTab,
      closeTab: s.closeTab,
      sendingMessage: s.sendingMessage,
      sendMessageError: s.sendMessageError,
      lastSendMessageResult: s.lastSendMessageResult,
      reviewActionError: s.reviewActionError,
      addMember: s.addMember,
      removeMember: s.removeMember,
      updateMemberRole: s.updateMemberRole,
      launchTeam: s.launchTeam,
      provisioningError: teamName ? (s.provisioningErrorByTeam[teamName] ?? null) : null,
      clearProvisioningError: s.clearProvisioningError,
      isTeamProvisioning: teamName ? isTeamProvisioningActive(s, teamName) : false,
      leadActivityByTeam: s.leadActivityByTeam,
      leadContextUpdatedAt: teamName ? s.leadContextByTeam[teamName]?.updatedAt : undefined,
      memberSpawnStatuses: teamName ? s.memberSpawnStatusesByTeam[teamName] : undefined,
      fetchMemberSpawnStatuses: s.fetchMemberSpawnStatuses,
      refreshTeamData: s.refreshTeamData,
      kanbanFilterQuery: s.kanbanFilterQuery,
      clearKanbanFilter: s.clearKanbanFilter,
      softDeleteTask: s.softDeleteTask,
      restoreTask: s.restoreTask,
      fetchDeletedTasks: s.fetchDeletedTasks,
      deletedTasks: s.deletedTasks,
      launchParams: teamName ? s.launchParamsByTeam[teamName] : undefined,
      messagesPanelMode: s.messagesPanelMode,
      messagesPanelWidth: s.messagesPanelWidth,
      setMessagesPanelMode: s.setMessagesPanelMode,
      setMessagesPanelWidth: s.setMessagesPanelWidth,
    }))
  );

  // Per-tab UI state (context panel visibility + selected phase)
  const {
    tabId,
    isContextPanelVisible,
    setContextPanelVisible,
    selectedContextPhase,
    setSelectedContextPhase,
  } = useTabUI();
  const activeTabId = useStore((s) => s.activeTabId);
  const isThisTabActive = tabId ? activeTabId === tabId : false;
  const [isContextButtonHovered, setIsContextButtonHovered] = useState(false);

  // Messages panel resize
  const { isResizing: isMessagesPanelResizing, handleProps: messagesPanelHandleProps } =
    useResizablePanel({
      width: messagesPanelWidth,
      onWidthChange: setMessagesPanelWidth,
      minWidth: 280,
      maxWidth: 600,
      side: 'left',
    });

  const toggleMessagesPanelMode = useCallback(() => {
    setMessagesPanelMode(messagesPanelMode === 'sidebar' ? 'inline' : 'sidebar');
  }, [messagesPanelMode, setMessagesPanelMode]);

  useEffect(() => {
    if (tabId) {
      initTabUIState(tabId);
    }
  }, [tabId, initTabUIState]);

  useEffect(() => {
    const wasProvisioning = wasProvisioningRef.current;
    wasProvisioningRef.current = isTeamProvisioning;
    if (!wasProvisioning && isTeamProvisioning) {
      provisioningBannerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [isTeamProvisioning]);

  // Fetch initial spawn statuses when provisioning starts
  useEffect(() => {
    if (isTeamProvisioning && teamName) {
      void fetchMemberSpawnStatuses(teamName);
    }
  }, [isTeamProvisioning, teamName, fetchMemberSpawnStatuses]);

  // Convert Record<string, MemberSpawnStatusEntry> → Map<string, MemberSpawnEntry>
  const memberSpawnStatusMap = useMemo(() => {
    if (!memberSpawnStatuses) return undefined;
    const map = new Map<string, { status: MemberSpawnStatusEntry['status']; error?: string }>();
    for (const [name, entry] of Object.entries(memberSpawnStatuses)) {
      map.set(name, { status: entry.status, error: entry.error });
    }
    return map.size > 0 ? map : undefined;
  }, [memberSpawnStatuses]);

  const [kanbanSearch, setKanbanSearch] = useState('');

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

  // Recovery: after HMR, all mounted TeamDetailView effects re-run simultaneously.
  // With CSS display-toggle (all tabs stay mounted), the last selectTeam() call wins
  // and other tabs get stuck with mismatched data (permanent skeleton).
  // Re-trigger selectTeam when this tab becomes active and store data is stale.
  const storedTeamName = data?.teamName;
  useEffect(() => {
    if (!isThisTabActive || !teamName || loading) return;
    if (storedTeamName != null && storedTeamName !== teamName) {
      void selectTeam(teamName);
    }
  }, [isThisTabActive, teamName, storedTeamName, loading, selectTeam]);

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

  // Lead session context panel (reuses the same session context pipeline for exact stats)
  const leadSessionId = data?.config.leadSessionId ?? null;
  const leadTabData = useStore(useShallow((s) => (tabId ? s.tabSessionData[tabId] : null)));
  const leadSessionDetail = leadTabData?.sessionDetail ?? null;
  const leadConversation = leadTabData?.conversation ?? null;
  const leadSessionContextStats = leadTabData?.sessionContextStats ?? null;
  const leadSessionPhaseInfo = leadTabData?.sessionPhaseInfo ?? null;
  const leadSessionLoading = leadTabData?.sessionDetailLoading ?? false;
  const leadSessionLoaded = Boolean(
    leadSessionId && leadSessionDetail?.session?.id === leadSessionId
  );

  const leadSubagentCostUsd = useMemo(() => {
    const processes = leadSessionDetail?.processes;
    if (!processes || processes.length === 0) return undefined;
    const total = processes.reduce((sum, p) => sum + (p.metrics.costUsd ?? 0), 0);
    return total > 0 ? total : undefined;
  }, [leadSessionDetail?.processes]);
  const { allContextInjections, lastAiGroupTotalTokens } = useMemo(() => {
    if (!leadSessionLoaded || !leadSessionContextStats || !leadConversation?.items.length) {
      return { allContextInjections: [] as ContextInjection[], lastAiGroupTotalTokens: undefined };
    }

    // Determine which phase to show
    const effectivePhase = selectedContextPhase;

    // If a specific phase is selected, find the last AI group in that phase
    let targetAiGroupId: string | undefined;
    if (effectivePhase !== null && leadSessionPhaseInfo) {
      const phase = leadSessionPhaseInfo.phases.find((p) => p.phaseNumber === effectivePhase);
      if (phase) {
        targetAiGroupId = phase.lastAIGroupId;
      }
    }

    // Default: use the last AI group overall
    if (!targetAiGroupId) {
      const lastAiItem = [...leadConversation.items].reverse().find((item) => item.type === 'ai');
      if (lastAiItem?.type !== 'ai') {
        return {
          allContextInjections: [] as ContextInjection[],
          lastAiGroupTotalTokens: undefined,
        };
      }
      targetAiGroupId = lastAiItem.group.id;
    }

    const stats = leadSessionContextStats.get(targetAiGroupId);
    const injections = stats?.accumulatedInjections ?? [];

    // Get total tokens from the target AI group
    let totalTokens: number | undefined;
    const targetItem = leadConversation.items.find(
      (item) => item.type === 'ai' && item.group.id === targetAiGroupId
    );
    if (targetItem?.type === 'ai') {
      const responses = targetItem.group.responses || [];
      for (let i = responses.length - 1; i >= 0; i--) {
        const msg = responses[i];
        if (msg.type === 'assistant' && msg.usage) {
          const usage = msg.usage;
          totalTokens =
            (usage.input_tokens ?? 0) +
            (usage.output_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0);
          break;
        }
      }
    }

    return { allContextInjections: injections, lastAiGroupTotalTokens: totalTokens };
  }, [
    leadSessionLoaded,
    leadSessionContextStats,
    leadConversation,
    selectedContextPhase,
    leadSessionPhaseInfo,
  ]);

  const visibleContextTokens = useMemo(
    () => sumContextInjectionTokens(allContextInjections),
    [allContextInjections]
  );
  const visibleContextPercentLabel = useMemo(
    () => formatPercentOfTotal(visibleContextTokens, lastAiGroupTotalTokens),
    [visibleContextTokens, lastAiGroupTotalTokens]
  );

  // Keep lead-session context fresh in the background while the team tab is active.
  // This keeps the button value current even when the panel is closed.
  // For offline teams: fetch once on mount so the percentage shows immediately.
  // For alive teams: fetch on mount + periodic refresh every 30s.
  useEffect(() => {
    if (!isThisTabActive) return;
    if (!tabId || !projectId || !leadSessionId) return;

    void fetchSessionDetail(projectId, leadSessionId, tabId, { silent: true });

    if (!data?.isAlive) return;

    const id = window.setInterval(() => {
      void fetchSessionDetail(projectId, leadSessionId, tabId, { silent: true });
    }, 10_000);
    return () => window.clearInterval(id);
  }, [isThisTabActive, tabId, projectId, leadSessionId, data?.isAlive, fetchSessionDetail]);

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

  // Live git branch polling for the team's project path
  const teamProjectPath = data?.config.projectPath?.trim() ?? null;
  const branchSyncPaths = useMemo(
    () => (teamProjectPath ? [teamProjectPath] : []),
    [teamProjectPath]
  );
  // Live branch sync now uses main-side background tracking instead of renderer polling.
  useBranchSync(branchSyncPaths, { live: true });
  const leadBranch = useStore((s) =>
    teamProjectPath ? (s.branchByPath[normalizePath(teamProjectPath)] ?? null) : null
  );

  // Filter sessions to team-only using sessionHistory + leadSessionId
  const teamSessionIds = useMemo(() => {
    const sessionIds = new Set<string>();
    if (data?.config.leadSessionId) {
      sessionIds.add(data.config.leadSessionId);
    }
    if (data?.config.sessionHistory) {
      for (const id of data.config.sessionHistory) {
        sessionIds.add(id);
      }
    }
    return sessionIds;
  }, [data?.config.leadSessionId, data?.config.sessionHistory]);

  const teamSessions = useMemo(() => {
    // If no session IDs known (backward compat), show all sessions
    if (teamSessionIds.size === 0) return sessions;
    return sessions.filter((s) => teamSessionIds.has(s.id));
  }, [sessions, teamSessionIds]);

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

  const activeMembers = useStableActiveMembers(data?.members);

  const kanbanDisplayTasks = useMemo(() => {
    const query = kanbanSearch.trim();
    if (!query) return filteredTasks;
    return filterKanbanTasks(filteredTasks, query);
  }, [filteredTasks, kanbanSearch]);

  const activeTeammateCount = useMemo(
    () => activeMembers.filter((m) => !isLeadMember(m)).length,
    [activeMembers]
  );

  const taskMap = useMemo(() => new Map((data?.tasks ?? []).map((t) => [t.id, t])), [data?.tasks]);

  const memberTaskCounts = useMemo(() => buildTaskCountsByOwner(data?.tasks ?? []), [data?.tasks]);

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

  const handleCreateTaskFromMessage = useCallback((subject: string, description: string) => {
    openCreateTaskDialog(subject, description);
  }, []);

  const handleReplyToMessage = useCallback((message: { from: string; text: string }) => {
    setSendDialogRecipient(message.from);
    setSendDialogDefaultText(undefined);
    setSendDialogDefaultChip(undefined);
    setReplyQuote({ from: message.from, text: stripAgentBlocks(message.text) });
    setSendDialogOpen(true);
  }, []);

  const handleRestartTeam = useCallback(() => {
    setLaunchDialogOpen(true);
  }, []);

  const handleTaskIdClick = useCallback(
    (taskId: string) => {
      const task =
        taskMap.get(taskId) ?? data?.tasks.find((candidate) => candidate.displayId === taskId);
      if (task) setSelectedTask(task);
    },
    [taskMap, data?.tasks]
  );

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
      taskChangeRequestOptions: pendingReviewRequest.requestOptions,
    });
    if (pendingReviewRequest.filePath) {
      selectReviewFile(pendingReviewRequest.filePath);
    }
    setPendingReviewRequest(null);
  }, [pendingReviewRequest, selectReviewFile, setPendingReviewRequest]);

  // Pick up pending member profile request from MemberHoverCard
  const pendingMemberProfile = useStore((s) => s.pendingMemberProfile);
  useEffect(() => {
    if (!pendingMemberProfile || !data) return;
    const member = data.members.find((m) => m.name === pendingMemberProfile);
    if (member) {
      setSelectedMember(member);
    }
    useStore.getState().closeMemberProfile();
  }, [pendingMemberProfile, data]);

  const handleDeleteTask = useCallback(
    (taskId: string) => {
      void (async () => {
        const confirmed = await confirm({
          title: 'Delete task',
          message: `Move task #${deriveTaskDisplayId(taskId)} to trash?`,
          confirmLabel: 'Delete',
          cancelLabel: 'Cancel',
          variant: 'danger',
        });
        if (confirmed) {
          try {
            await softDeleteTask(teamName, taskId);
          } catch {
            // error via store
          }
        }
      })();
    },
    [teamName, softDeleteTask]
  );

  const handleViewChanges = useCallback(
    (taskId: string) => {
      const task = taskMap.get(taskId);
      setReviewDialogState({
        open: true,
        mode: 'task',
        taskId,
        taskChangeRequestOptions: task ? buildTaskChangeRequestOptions(task) : {},
      });
    },
    [taskMap]
  );

  const handleViewChangesForFile = useCallback(
    (taskId: string, filePath?: string) => {
      const task = taskMap.get(taskId);
      setReviewDialogState({
        open: true,
        mode: 'task',
        taskId,
        initialFilePath: filePath,
        taskChangeRequestOptions: task ? buildTaskChangeRequestOptions(task) : {},
      });
      if (filePath) {
        selectReviewFile(filePath);
      }
    },
    [selectReviewFile, taskMap]
  );

  const handleDeleteTeam = useCallback((): void => {
    setDeleteConfirmOpen(true);
  }, []);

  const confirmDeleteTeam = useCallback((): void => {
    setDeleteConfirmOpen(false);
    void (async () => {
      try {
        await deleteTeam(teamName);
        if (tabId) closeTab(tabId);
        openTeamsTab();
      } catch {
        // error is shown via store
      }
    })();
  }, [teamName, deleteTeam, openTeamsTab, closeTab, tabId]);

  const handleCreateTask = (
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
          descriptionTaskRefs,
          promptTaskRefs,
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

  if ((loading && !data) || (data && data.teamName !== teamName)) {
    return (
      <div className="size-full overflow-auto p-4">
        <div className="mb-4 h-10 animate-pulse rounded-md bg-[var(--color-surface-raised)]" />
        <div ref={provisioningBannerRef}>
          <TeamProvisioningBanner teamName={teamName} />
        </div>
        <div className="space-y-3">
          <div className="h-24 animate-pulse rounded-md bg-[var(--color-surface-raised)]" />
          <div className="h-48 animate-pulse rounded-md bg-[var(--color-surface-raised)]" />
          <div className="h-48 animate-pulse rounded-md bg-[var(--color-surface-raised)]" />
        </div>
      </div>
    );
  }

  if (error === 'TEAM_DRAFT') {
    const teamSummary = teams.find((t) => t.teamName === teamName);
    return (
      <>
        <div className="flex size-full items-center justify-center p-6">
          <div className="max-w-md text-center">
            <p className="text-sm font-medium text-text">Team not launched yet</p>
            <p className="mt-2 text-xs text-text-secondary">
              This is a draft team — <strong>{teamSummary?.displayName || teamName}</strong> has
              been configured with {teamSummary?.memberCount ?? 0} member
              {teamSummary?.memberCount === 1 ? '' : 's'} but hasn&apos;t been provisioned by CLI
              yet. Click Launch to select a model and start the team.
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <button
                className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500"
                onClick={() => setLaunchDialogOpen(true)}
              >
                Launch
              </button>
              <button
                className="rounded-md bg-surface-raised px-4 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:text-text"
                onClick={() => {
                  void api.teams.deleteDraft(teamName).catch(() => {});
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
        <LaunchTeamDialog
          mode="launch"
          open={launchDialogOpen}
          teamName={teamName}
          members={[]}
          defaultProjectPath={teamSummary?.projectPath}
          provisioningError={provisioningError}
          clearProvisioningError={clearProvisioningError}
          onClose={() => setLaunchDialogOpen(false)}
          onLaunch={async (request) => {
            await launchTeam(request);
          }}
        />
      </>
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
      <div className="size-full overflow-auto p-4">
        <div ref={provisioningBannerRef}>
          <TeamProvisioningBanner teamName={teamName} />
        </div>
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-[var(--color-text-muted)]">
          Team data will appear once provisioning completes
        </div>
      </div>
    );
  }

  const headerColorSet = data.config.color
    ? getTeamColorSet(data.config.color)
    : nameColorSet(data.config.name);
  const sharedMessagesPanelProps = {
    teamName,
    onTogglePosition: toggleMessagesPanelMode,
    members: activeMembers,
    tasks: data.tasks,
    messages: data.messages,
    isTeamAlive: data.isAlive,
    leadActivity: leadActivityByTeam[teamName],
    leadContextUpdatedAt,
    timeWindow,
    teamSessionIds,
    currentLeadSessionId: data.config.leadSessionId,
    pendingRepliesByMember,
    onPendingReplyChange: setPendingRepliesByMember,
    onMemberClick: setSelectedMember,
    onTaskClick: setSelectedTask,
    onCreateTaskFromMessage: handleCreateTaskFromMessage,
    onReplyToMessage: handleReplyToMessage,
    onRestartTeam: handleRestartTeam,
    onTaskIdClick: handleTaskIdClick,
  };

  return (
    <>
      <div className="flex size-full overflow-hidden">
        {/* Context panel sidebar (left) */}
        {isContextPanelVisible && leadSessionId && (
          <div className="w-80 shrink-0">
            {leadSessionLoaded ? (
              <SessionContextPanel
                injections={allContextInjections}
                onClose={() => setContextPanelVisible(false)}
                projectRoot={leadSessionDetail?.session?.projectPath ?? data.config.projectPath}
                totalSessionTokens={lastAiGroupTotalTokens}
                sessionMetrics={leadSessionDetail?.metrics}
                subagentCostUsd={leadSubagentCostUsd}
                phaseInfo={leadSessionPhaseInfo ?? undefined}
                selectedPhase={selectedContextPhase}
                onPhaseChange={setSelectedContextPhase}
                side="left"
              />
            ) : (
              <div
                className="flex h-full flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]"
                style={{ backgroundColor: 'var(--color-surface)' }}
              >
                <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[var(--color-text)]">Visible Context</p>
                    <p className="text-[10px] text-[var(--color-text-muted)]">
                      {leadSessionLoading ? 'Loading…' : 'No session loaded'}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
                    onClick={() => setContextPanelVisible(false)}
                    aria-label="Close panel"
                  >
                    ×
                  </button>
                </div>
                <div className="flex flex-1 items-center justify-center p-4">
                  <p className="text-xs text-[var(--color-text-muted)]">
                    {leadSessionLoading
                      ? 'Loading context…'
                      : 'Open the team lead session to view context.'}
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Messages sidebar (left, after context panel) */}
        <TeamSidebarHost
          teamName={teamName}
          surface="team"
          isActive={isThisTabActive}
          isFocused={isPaneFocused}
        >
          <TeamSidebarPortalSource
            teamName={teamName}
            isActive={isThisTabActive}
            isFocused={isPaneFocused}
          >
            <TeamSidebarRail
              teamName={teamName}
              messagesPanelProps={sharedMessagesPanelProps}
              isResizing={isMessagesPanelResizing}
              onResizeMouseDown={messagesPanelHandleProps.onMouseDown}
            />
          </TeamSidebarPortalSource>
        </TeamSidebarHost>

        <div
          ref={contentRef}
          className="relative size-full flex-1 overflow-auto p-4"
          data-team-name={teamName}
        >
          {/* Context button pinned to bottom-left of viewport */}
          {leadSessionId && (
            <div
              className="pointer-events-none fixed bottom-4 z-20"
              style={{ left: isContextPanelVisible ? 'calc(20rem + 1rem)' : '1rem' }}
            >
              <button
                onClick={() => {
                  const next = !isContextPanelVisible;
                  setContextPanelVisible(next);
                  if (tabId && projectId && leadSessionId) {
                    void fetchSessionDetail(projectId, leadSessionId, tabId, { silent: true });
                  }
                }}
                onMouseEnter={() => setIsContextButtonHovered(true)}
                onMouseLeave={() => setIsContextButtonHovered(false)}
                className="pointer-events-auto flex w-fit items-center gap-1 rounded-md px-2.5 py-1.5 text-xs shadow-lg backdrop-blur-md transition-colors"
                style={{
                  backgroundColor: isContextPanelVisible
                    ? 'var(--context-btn-active-bg)'
                    : isContextButtonHovered
                      ? 'var(--context-btn-bg-hover)'
                      : 'var(--context-btn-bg)',
                  color: isContextPanelVisible
                    ? 'var(--context-btn-active-text)'
                    : 'var(--color-text-secondary)',
                }}
                title={
                  leadSessionLoaded
                    ? `Session: ${leadSessionId}`
                    : leadSessionLoading
                      ? 'Loading context…'
                      : leadSessionId
                }
              >
                {visibleContextPercentLabel ?? 'Context'}
              </button>
            </div>
          )}

          <div className="relative -mx-4 -mt-4 mb-3 overflow-hidden border-b border-[var(--color-border)] px-4 py-3">
            {headerColorSet ? (
              <div
                className="pointer-events-none absolute inset-0 z-0"
                style={{ backgroundColor: getThemedBadge(headerColorSet, isLight) }}
              />
            ) : null}
            <div
              className={cn(
                'flex items-start justify-between gap-2',
                headerColorSet && 'relative z-10'
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold text-[var(--color-text)]">
                    {data.config.name}
                  </h2>
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
                  {data.isAlive &&
                    launchParams?.model &&
                    (() => {
                      const MODEL_LABELS: Record<string, string> = {
                        default: 'Default',
                        opus: 'Opus 4.6',
                        sonnet: 'Sonnet 4.6',
                        haiku: 'Haiku 4.5',
                      };
                      const modelLabel = MODEL_LABELS[launchParams.model] ?? launchParams.model;
                      const effortLabel = launchParams.effort
                        ? launchParams.effort.charAt(0).toUpperCase() + launchParams.effort.slice(1)
                        : '';
                      const limitLabel = launchParams.limitContext ? '200K' : '';
                      const parts = [modelLabel, effortLabel, limitLabel].filter(Boolean).join(' ');
                      return (
                        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-secondary)]">
                          {parts}
                        </span>
                      );
                    })()}
                </div>
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
                  <span className="flex items-center gap-1 text-[11px] text-[var(--color-text-secondary)]">
                    <FolderOpen size={11} className="shrink-0 text-[var(--color-text-muted)]" />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="max-w-60 truncate font-mono">
                          {data.config.projectPath
                            .replace(/\\/g, '/')
                            .split('/')
                            .filter(Boolean)
                            .pop() ?? data.config.projectPath}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        <span className="font-mono text-xs">
                          {formatProjectPath(data.config.projectPath)}
                        </span>
                      </TooltipContent>
                    </Tooltip>
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
            <div
              className="mb-3 flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              style={{
                backgroundColor: 'var(--warning-bg)',
                borderColor: 'var(--warning-border)',
                color: 'var(--warning-text)',
              }}
            >
              <span className="flex items-center gap-1.5 text-xs">
                <AlertTriangle size={14} className="shrink-0" />
                Team is offline
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 gap-1 px-2 text-xs text-[var(--step-done-text)] hover:bg-[var(--step-done-bg)]"
                onClick={() => setLaunchDialogOpen(true)}
              >
                <Play size={12} />
                Launch
              </Button>
            </div>
          ) : null}

          <div ref={provisioningBannerRef}>
            <TeamProvisioningBanner teamName={teamName} />
          </div>

          {data.warnings?.some((warning) => warning.toLowerCase().includes('kanban')) ? (
            <div className="mb-3 rounded-md border border-[var(--step-warning-border)] bg-[var(--step-warning-bg)] px-3 py-2 text-xs text-[var(--step-warning-text)]">
              Failed to fully load kanban. Displaying safe data.
            </div>
          ) : null}
          {reviewActionError ? (
            <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-[var(--step-error-text)]">
              {reviewActionError}
            </div>
          ) : null}

          <CollapsibleTeamSection
            sectionId="team"
            title="Team"
            icon={<Users size={14} />}
            badge={activeTeammateCount === 0 ? 'Solo' : activeTeammateCount}
            defaultOpen
            action={
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  onClick={(e) => {
                    e.stopPropagation();
                    useStore.getState().openTab({
                      type: 'graph',
                      label: `${data.config.name} Graph`,
                      teamName,
                    });
                  }}
                >
                  <Network size={12} />
                  Graph
                </Button>
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
              </div>
            }
          >
            <MemberList
              members={data.members}
              memberTaskCounts={memberTaskCounts}
              taskMap={taskMap}
              pendingRepliesByMember={pendingRepliesByMember}
              memberSpawnStatuses={memberSpawnStatusMap}
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
            contentClassName="overflow-x-visible"
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
              sort={kanbanSort}
              sessions={teamSessions}
              leadSessionId={data.config.leadSessionId}
              members={activeMembers}
              onFilterChange={setKanbanFilter}
              onSortChange={setKanbanSort}
              toolbarLeft={
                <KanbanSearchInput
                  value={kanbanSearch}
                  onChange={setKanbanSearch}
                  tasks={filteredTasks}
                  members={activeMembers}
                />
              }
              onRequestReview={(taskId) => {
                void (async () => {
                  try {
                    await requestReview(teamName, taskId);
                  } catch {
                    // error via store
                  }
                })();
              }}
              onApprove={(taskId) => {
                void (async () => {
                  try {
                    await updateKanban(teamName, taskId, { op: 'set_column', column: 'approved' });
                  } catch {
                    // error via store
                  }
                })();
              }}
              onRequestChanges={(taskId) => {
                setRequestChangesTaskId(taskId);
              }}
              onMoveBackToDone={(taskId) => {
                void (async () => {
                  try {
                    await updateKanban(teamName, taskId, { op: 'remove' });
                    await updateTaskStatus(teamName, taskId, 'completed');
                  } catch {
                    // error via store
                  }
                })();
              }}
              onStartTask={(taskId) => {
                void (async () => {
                  try {
                    const result = await startTaskByUser(teamName, taskId);
                    if (data?.isAlive) {
                      const task = data.tasks.find((t) => t.id === taskId);
                      try {
                        if (result.notifiedOwner && task?.owner) {
                          await api.teams.processSend(
                            teamName,
                            `Task ${formatTaskDisplayLabel(task)} "${task.subject}" has started. Please begin working on it.`
                          );
                        } else if (!result.notifiedOwner) {
                          const desc = task?.description?.trim()
                            ? `\nDescription: ${task.description.trim()}`
                            : '';
                          await api.teams.processSend(
                            teamName,
                            `Task #${deriveTaskDisplayId(taskId)} "${task?.subject ?? ''}" has been moved to IN PROGRESS but has no assignee.${desc}\nPlease assign it to an available team member, or take it yourself if everyone is busy.`
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
                void (async () => {
                  try {
                    await updateTaskStatus(teamName, taskId, 'completed');
                  } catch {
                    // error via store
                  }
                })();
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
                          text: `Task ${formatTaskDisplayLabel(task)} "${task.subject}" has been CANCELLED by the user and moved back to TODO. Stop working on it immediately.`,
                          summary: `Task ${formatTaskDisplayLabel(task)} cancelled`,
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
                          `Task #${deriveTaskDisplayId(taskId)} "${task?.subject ?? ''}" has been cancelled and moved back to TODO.${ownerSuffix}`
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
                void (async () => {
                  try {
                    await updateKanbanColumnOrder(teamName, columnId, orderedTaskIds);
                  } catch {
                    // error via store
                  }
                })();
              }}
              onScrollToTask={(taskId) => {
                const el = document.querySelector(`[data-task-id="${taskId}"]`);
                if (el) {
                  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                  el.classList.remove('kanban-card-focus-pulse');
                  void (el as HTMLElement).offsetWidth;
                  el.classList.add('kanban-card-focus-pulse');
                  el.addEventListener(
                    'animationend',
                    () => el.classList.remove('kanban-card-focus-pulse'),
                    { once: true }
                  );
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

          <CollapsibleTeamSection
            sectionId="schedules"
            title="Schedules"
            icon={<Clock size={14} />}
            defaultOpen={false}
          >
            <ScheduleSection teamName={teamName} />
          </CollapsibleTeamSection>

          {(data.processes?.length ?? 0) > 0 && (
            <CollapsibleTeamSection
              sectionId="processes"
              title="CLI Processes"
              icon={<Terminal size={14} />}
              badge={data.processes.filter((p) => !p.stoppedAt).length}
              headerExtra={
                data.processes.some((p) => !p.stoppedAt) ? (
                  <span
                    className="pointer-events-none relative inline-flex size-2 shrink-0"
                    title="Active"
                  >
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" />
                    <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
                  </span>
                ) : null
              }
              defaultOpen
            >
              <ProcessesSection />
            </CollapsibleTeamSection>
          )}

          {messagesPanelMode !== 'sidebar' && <ClaudeLogsSection teamName={teamName} />}

          {messagesPanelMode === 'inline' && (
            <MessagesPanel position="inline" {...sharedMessagesPanelProps} />
          )}

          <ReviewDialog
            open={requestChangesTaskId !== null}
            teamName={teamName}
            taskId={requestChangesTaskId}
            members={data?.members ?? []}
            onCancel={() => setRequestChangesTaskId(null)}
            onSubmit={(comment, taskRefs) => {
              if (!requestChangesTaskId) {
                return;
              }
              void (async () => {
                try {
                  await updateKanban(teamName, requestChangesTaskId, {
                    op: 'request_changes',
                    comment,
                    taskRefs,
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
            currentMembers={data.members.filter((m) => !isLeadMember(m))}
            projectPath={data.config.projectPath}
            onClose={() => setEditDialogOpen(false)}
            onSaved={() => void selectTeam(teamName)}
          />

          <AddMemberDialog
            open={addMemberDialogOpen}
            teamName={teamName}
            existingNames={data.members.map((m) => m.name)}
            existingMembers={data.members}
            projectPath={data.config.projectPath}
            adding={addingMemberLoading}
            onClose={() => setAddMemberDialogOpen(false)}
            onAdd={(entries: AddMemberEntry[]) => {
              setAddingMemberLoading(true);
              void (async () => {
                try {
                  for (const entry of entries) {
                    await addMember(teamName, {
                      name: entry.name,
                      role: entry.role,
                      workflow: entry.workflow,
                    });
                  }
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
                  Remove &ldquo;{removeMemberConfirm}&rdquo; from the team? Tasks and messages will
                  be preserved, but this name cannot be reused.
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
                  Delete team &ldquo;{data.config.name}&rdquo;? This action is irreversible. All
                  team data and tasks will be deleted.
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
            mode="launch"
            open={launchDialogOpen}
            teamName={teamName}
            members={data?.members ?? []}
            defaultProjectPath={data.config.projectPath}
            provisioningError={provisioningError}
            clearProvisioningError={clearProvisioningError}
            activeTeams={activeTeamsForLaunch}
            onClose={() => setLaunchDialogOpen(false)}
            onLaunch={async (request) => {
              await launchTeam(request);
            }}
          />

          <SendMessageDialog
            open={sendDialogOpen}
            teamName={teamName}
            members={activeMembers}
            defaultRecipient={sendDialogRecipient}
            defaultText={sendDialogDefaultText}
            defaultChip={sendDialogDefaultChip}
            quotedMessage={replyQuote}
            isTeamAlive={data.isAlive}
            sending={sendingMessage}
            sendError={sendMessageError}
            lastResult={lastSendMessageResult}
            onSend={(member, text, summary, attachments, actionMode, taskRefs) => {
              void (async () => {
                const sentAtMs = Date.now();
                setPendingRepliesByMember((prev) => ({ ...prev, [member]: sentAtMs }));
                try {
                  await sendTeamMessage(teamName, {
                    member,
                    text,
                    summary,
                    attachments,
                    actionMode,
                    taskRefs,
                  });
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
                el.classList.remove('kanban-card-focus-pulse');
                void (el as HTMLElement).offsetWidth;
                el.classList.add('kanban-card-focus-pulse');
                el.addEventListener(
                  'animationend',
                  () => el.classList.remove('kanban-card-focus-pulse'),
                  { once: true }
                );
              }
            }}
            onOwnerChange={(taskId, owner) => {
              void (async () => {
                try {
                  await updateTaskOwner(teamName, taskId, owner);
                } catch {
                  // error via store
                }
              })();
            }}
            onViewChanges={handleViewChangesForFile}
            onOpenInEditor={(filePath) => {
              const { revealFileInEditor } = useStore.getState();
              revealFileInEditor(filePath);
            }}
            onDeleteTask={handleDeleteTask}
          />

          <TrashDialog
            open={trashOpen}
            tasks={deletedTasks}
            onClose={() => setTrashOpen(false)}
            onRestore={(taskId) => {
              void (async () => {
                try {
                  await restoreTask(teamName, taskId);
                } catch {
                  // error via store
                }
              })();
            }}
          />

          <ChangeReviewDialog
            open={reviewDialogState.open}
            onOpenChange={(open) =>
              setReviewDialogState((prev) => ({
                ...prev,
                open,
                ...(open
                  ? {}
                  : { initialFilePath: undefined, taskChangeRequestOptions: undefined }),
              }))
            }
            teamName={teamName}
            mode={reviewDialogState.mode}
            memberName={reviewDialogState.memberName}
            taskId={reviewDialogState.taskId}
            initialFilePath={reviewDialogState.initialFilePath}
            taskChangeRequestOptions={reviewDialogState.taskChangeRequestOptions}
            projectPath={data.config.projectPath}
            onEditorAction={handleEditorAction}
          />
        </div>
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

      {graphOpen && (
        <Suspense fallback={null}>
          <TeamGraphOverlay
            teamName={teamName}
            onClose={() => setGraphOpen(false)}
            onPinAsTab={() => {
              setGraphOpen(false);
              useStore
                .getState()
                .openTab({ type: 'graph', label: `${data.config.name} Graph`, teamName });
            }}
            onSendMessage={(memberName) => {
              setSendDialogRecipient(memberName);
              setSendDialogDefaultText(undefined);
              setSendDialogDefaultChip(undefined);
              setSendDialogOpen(true);
            }}
            onOpenTaskDetail={(taskId) => {
              const task = data.tasks.find((t) => t.id === taskId);
              if (task) setSelectedTask(task);
            }}
            onOpenMemberProfile={(memberName) => {
              setSendDialogRecipient(memberName);
              setSendDialogDefaultText(undefined);
              setSendDialogDefaultChip(undefined);
              setSendDialogOpen(true);
            }}
          />
        </Suspense>
      )}
    </>
  );
};
