import {
  forwardRef,
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { TerminalWorkspaceFloatingLauncher } from '@features/terminal-workspace/renderer';
import { api } from '@renderer/api';
import { SessionPanel } from '@renderer/components/chat/session-panel';
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
import { useOptionalTabId } from '@renderer/hooks/useOptionalTabId';
import { useResizablePanel } from '@renderer/hooks/useResizablePanel';
import { useTheme } from '@renderer/hooks/useTheme';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import {
  getCurrentProvisioningProgressForTeam,
  isTeamProvisioningActive,
  selectResolvedMemberForTeamName,
  selectResolvedMembersForTeamName,
  selectTeamMemberSnapshotsForName,
} from '@renderer/store/slices/teamSlice';
import { createChipFromSelection } from '@renderer/utils/chipUtils';
import * as tokenMath from '@renderer/utils/contextMath';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import {
  hasUnresolvedMemberSpawnStatus,
  MEMBER_SPAWN_STATUS_REFRESH_MS,
} from '@renderer/utils/memberSpawnStatusPolling';
import { shouldClearPendingReplyForOpenCodeRuntimeDelivery } from '@renderer/utils/openCodeRuntimeDeliveryDiagnostics';
import { formatProjectPath } from '@renderer/utils/pathDisplay';
import { buildTaskCountsByOwner, normalizePath } from '@renderer/utils/pathNormalize';
import { nameColorSet } from '@renderer/utils/projectColor';
import { resolveProjectIdByPath } from '@renderer/utils/projectLookup';
import { scheduleStartupIdleTask } from '@renderer/utils/startupIdleTask';
import {
  buildTaskChangeRequestOptions,
  type TaskChangeRequestOptions,
} from '@renderer/utils/taskChangeRequest';
import { buildPendingRuntimeSummaryCopy } from '@renderer/utils/teamLaunchSummaryCopy';
import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import { isLeadMember } from '@shared/utils/leadDetection';
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
import { EditTeamDialog } from './dialogs/EditTeamDialog';
import { LaunchTeamDialogLoadingFallback } from './dialogs/LaunchTeamDialogLoadingFallback';
import { ReviewDialog } from './dialogs/ReviewDialog';
import { executeTeamRelaunch } from './dialogs/teamRelaunchFlow';
import { KanbanBoard } from './kanban/KanbanBoard';
import { UNASSIGNED_OWNER } from './kanban/KanbanFilterPopover';
import { KanbanSearchInput } from './kanban/KanbanSearchInput';
import { TrashDialog } from './kanban/TrashDialog';
import { MemberDetailDialog } from './members/MemberDetailDialog';
import { type MemberActivityFilter, type MemberDetailTab } from './members/memberDetailTypes';
import { deriveMetrics } from './context-metric-alias';

import type { AddMemberEntry } from './dialogs/AddMemberDialog';
import type { TeamLaunchDialogMode } from './dialogs/LaunchTeamDialog';
import type { TeamMessagesPanelMode } from '@renderer/types/teamMessagesPanelMode';
import type { ComponentProps, CSSProperties } from 'react';

const sumInjectionTokens = tokenMath[
  ['sum', 'Con' + 'text', 'InjectionTokens'].join('') as keyof typeof tokenMath
] as (injections: readonly unknown[]) => number;
const LaunchTeamDialog = lazy(() =>
  import('./dialogs/LaunchTeamDialog').then((m) => ({ default: m.LaunchTeamDialog }))
);
const ProjectEditorOverlay = lazy(() =>
  import('./editor/ProjectEditorOverlay').then((m) => ({ default: m.ProjectEditorOverlay }))
);
const TeamGraphOverlay = lazy(() =>
  import('@features/agent-graph/renderer').then((m) => ({
    default: m.TeamGraphOverlay,
  }))
);
type TaskDetailDialogComponent = typeof import('./dialogs/TaskDetailDialog').TaskDetailDialog;
let loadedTaskDetailDialogComponent: TaskDetailDialogComponent | null = null;
let taskDetailDialogImportPromise: Promise<{ default: TaskDetailDialogComponent }> | null = null;
function loadTaskDetailDialog(): Promise<{ default: TaskDetailDialogComponent }> {
  taskDetailDialogImportPromise ??= import('./dialogs/TaskDetailDialog')
    .then((m) => {
      loadedTaskDetailDialogComponent = m.TaskDetailDialog;
      return { default: m.TaskDetailDialog };
    })
    .catch((error) => {
      taskDetailDialogImportPromise = null;
      throw error;
    });
  return taskDetailDialogImportPromise;
}
function preloadTaskDetailDialog(): void {
  void loadTaskDetailDialog().catch(() => undefined);
}
const LazyTaskDetailDialog = lazy(loadTaskDetailDialog);
const SendMessageDialog = lazy(() =>
  import('./dialogs/SendMessageDialog').then((m) => ({ default: m.SendMessageDialog }))
);
const CreateTaskDialog = lazy(() =>
  import('./dialogs/CreateTaskDialog').then((m) => ({ default: m.CreateTaskDialog }))
);
const ChangeReviewDialog = lazy(() =>
  import('./review/ChangeReviewDialog').then((m) => ({ default: m.ChangeReviewDialog }))
);
import { MemberList } from './members/MemberList';
import { MessagesPanel } from './messages/MessagesPanel';
import { ScheduleSection } from './schedule/ScheduleSection';
import { TeamSidebarHost } from './sidebar/TeamSidebarHost';
import { TeamSidebarPortalSource } from './sidebar/TeamSidebarPortalSource';
import { TeamSidebarRail } from './sidebar/TeamSidebarRail';
import {
  getTeamPendingRepliesState,
  setTeamPendingRepliesState,
} from './sidebar/teamSidebarUiState';
import { ClaudeLogsSection } from './ClaudeLogsSection';
import { CollapsibleTeamSection } from './CollapsibleTeamSection';
import { deriveLeadLoadButtonLabel } from './lead-load-guards';
import { LeadSessionDetailGate } from './LeadSessionDetailGate';
import { LiveRuntimeStatusBridge } from './LiveRuntimeStatusBridge';
import { ProcessesSection } from './ProcessesSection';
import { getLaunchJoinMilestonesFromMembers, getLaunchJoinState } from './provisioningSteps';
import { TeamChangesSection } from './TeamChangesSection';
import { TeamLoadingSkeleton } from './TeamLoadingSkeleton';
import { TeamProvisioningBanner } from './TeamProvisioningBanner';
import { loadTeamSessionMetadata } from './teamSessionFetchGuards';
import { TeamSessionsSection } from './TeamSessionsSection';
import { useTeamAgentRuntimeWatcher } from './useTeamAgentRuntimeWatcher';

import type { UsageLike } from './context-metric-alias';
import type { KanbanFilterState } from './kanban/KanbanFilterPopover';
import type { KanbanSortState } from './kanban/KanbanSortPopover';
import type { SessionInjection } from './session-injection-types';
import type { Session } from '@renderer/types/data';
import type { InlineChip } from '@renderer/types/inlineChip';
import type {
  KanbanColumnId,
  KanbanTaskState,
  MemberSpawnStatusEntry,
  ResolvedTeamMember,
  TaskRef,
  TeamAgentRuntimeEntry,
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamProviderId,
  TeamSummary,
  TeamTaskWithKanban,
} from '@shared/types';
import type { EditorSelectionAction } from '@shared/types/editor';

interface TaskDetailDialogHostHandle {
  openTask: (task: TeamTaskWithKanban) => void;
  close: () => void;
}

interface TaskDetailDialogHostProps {
  teamName: string;
  kanbanTaskStateByTaskId: Record<string, KanbanTaskState>;
  taskMap: Map<string, TeamTaskWithKanban>;
  members: ResolvedTeamMember[];
  onOwnerChange: (taskId: string, owner: string | null) => void;
  onViewChanges: (taskId: string, filePath?: string) => void;
  onOpenInEditor: (filePath: string) => void;
  onDeleteTask: (taskId: string) => void;
}

const TaskDetailDialogHost = memo(
  forwardRef<TaskDetailDialogHostHandle, TaskDetailDialogHostProps>(function TaskDetailDialogHost(
    {
      teamName,
      kanbanTaskStateByTaskId,
      taskMap,
      members,
      onOwnerChange,
      onViewChanges,
      onOpenInEditor,
      onDeleteTask,
    },
    ref
  ) {
    const [selectedTask, setSelectedTask] = useState<TeamTaskWithKanban | null>(null);
    const [loadedTask, setLoadedTask] = useState<TeamTaskWithKanban | null>(null);
    const selectedTaskId = selectedTask?.id ?? null;
    const selectedTaskSnapshot =
      selectedTaskId !== null ? (taskMap.get(selectedTaskId) ?? selectedTask) : null;
    const selectedTaskUpdatedAt = selectedTaskSnapshot?.updatedAt ?? null;
    const currentTask =
      loadedTask && loadedTask.id === selectedTaskId ? loadedTask : selectedTaskSnapshot;
    const dialogTaskMap = useMemo(() => {
      if (!currentTask) {
        return taskMap;
      }
      const next = new Map(taskMap);
      next.set(currentTask.id, currentTask);
      return next;
    }, [currentTask, taskMap]);

    useImperativeHandle(
      ref,
      () => ({
        openTask: (task) => {
          setLoadedTask(null);
          setSelectedTask(task);
        },
        close: () => {
          setLoadedTask(null);
          setSelectedTask(null);
        },
      }),
      []
    );

    useEffect(() => {
      if (!selectedTaskId) {
        setLoadedTask(null);
        return undefined;
      }

      let cancelled = false;
      setLoadedTask(null);
      void api.teams
        .getTask(teamName, selectedTaskId)
        .then((task) => {
          if (!cancelled && task?.id === selectedTaskId) {
            setLoadedTask(task);
          }
        })
        .catch(() => undefined);

      return () => {
        cancelled = true;
      };
    }, [selectedTaskId, selectedTaskUpdatedAt, teamName]);

    const handleScrollToTask = useCallback((taskId: string) => {
      setSelectedTask(null);
      setLoadedTask(null);
      const el = document.querySelector(`[data-task-id="${taskId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        el.classList.remove('kanban-card-focus-pulse');
        void (el as HTMLElement).offsetWidth;
        el.classList.add('kanban-card-focus-pulse');
        el.addEventListener('animationend', () => el.classList.remove('kanban-card-focus-pulse'), {
          once: true,
        });
      }
    }, []);

    if (currentTask === null) {
      return null;
    }

    const DialogComponent = loadedTaskDetailDialogComponent ?? LazyTaskDetailDialog;
    const dialog = (
      <DialogComponent
        open
        task={currentTask}
        teamName={teamName}
        kanbanTaskState={kanbanTaskStateByTaskId[currentTask.id]}
        taskMap={dialogTaskMap}
        members={members}
        onClose={() => {
          setLoadedTask(null);
          setSelectedTask(null);
        }}
        onScrollToTask={handleScrollToTask}
        onOwnerChange={onOwnerChange}
        onViewChanges={onViewChanges}
        onOpenInEditor={onOpenInEditor}
        onDeleteTask={onDeleteTask}
      />
    );

    if (loadedTaskDetailDialogComponent) {
      return dialog;
    }

    return <Suspense fallback={null}>{dialog}</Suspense>;
  })
);
TaskDetailDialogHost.displayName = 'TaskDetailDialogHost';

interface TeamDetailViewProps {
  teamName: string;
  isActive?: boolean;
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

const TEAM_PENDING_REPLY_REFRESH_DELAY_MS = 10_000;
const EMPTY_SESSION_HISTORY: readonly string[] = [];
const MEMBER_ROSTER_HYDRATION_RETRY_DELAY_MS = 1_200;
const FLOATING_COMPOSER_SCROLL_RESERVE_BASE_PX = 200;

function getSummaryKnownTeammateCount(summary: TeamSummary | undefined): number {
  if (!summary) {
    return 0;
  }

  const normalizedLeadName = summary.leadName?.trim().toLowerCase();
  const rosterNames = new Set<string>();
  for (const member of summary.members ?? []) {
    const name = member.name?.trim();
    if (!name) {
      continue;
    }
    const normalizedName = name.toLowerCase();
    if (
      normalizedName === 'user' ||
      isLeadMember({ name }) ||
      (normalizedLeadName && normalizedName === normalizedLeadName)
    ) {
      continue;
    }
    rosterNames.add(normalizedName);
  }

  const launchNames = new Set<string>();
  for (const rawName of [...(summary.missingMembers ?? []), ...(summary.skippedMembers ?? [])]) {
    const name = rawName.trim();
    if (!name) {
      continue;
    }
    const normalizedName = name.toLowerCase();
    if (
      normalizedName === 'user' ||
      isLeadMember({ name }) ||
      (normalizedLeadName && normalizedName === normalizedLeadName)
    ) {
      continue;
    }
    launchNames.add(normalizedName);
  }

  const activeRosterCount = Math.max(summary.memberCount, rosterNames.size);
  if (activeRosterCount > 0) {
    return activeRosterCount;
  }

  return Math.max(
    summary.expectedMemberCount ?? 0,
    launchNames.size,
    (summary.confirmedCount ?? 0) +
      (summary.pendingCount ?? 0) +
      (summary.failedCount ?? 0) +
      (summary.skippedCount ?? 0)
  );
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
      prevMember.agentId !== nextMember.agentId ||
      prevMember.status !== nextMember.status ||
      prevMember.currentTaskId !== nextMember.currentTaskId ||
      prevMember.taskCount !== nextMember.taskCount ||
      prevMember.lastActiveAt !== nextMember.lastActiveAt ||
      prevMember.messageCount !== nextMember.messageCount ||
      prevMember.color !== nextMember.color ||
      prevMember.agentType !== nextMember.agentType ||
      prevMember.role !== nextMember.role ||
      prevMember.workflow !== nextMember.workflow ||
      prevMember.isolation !== nextMember.isolation ||
      prevMember.providerId !== nextMember.providerId ||
      prevMember.providerBackendId !== nextMember.providerBackendId ||
      prevMember.model !== nextMember.model ||
      prevMember.effort !== nextMember.effort ||
      prevMember.selectedFastMode !== nextMember.selectedFastMode ||
      prevMember.resolvedFastMode !== nextMember.resolvedFastMode ||
      prevMember.laneId !== nextMember.laneId ||
      prevMember.laneKind !== nextMember.laneKind ||
      prevMember.laneOwnerProviderId !== nextMember.laneOwnerProviderId ||
      prevMember.cwd !== nextMember.cwd ||
      prevMember.gitBranch !== nextMember.gitBranch ||
      prevMember.removedAt !== nextMember.removedAt ||
      !areMemberMcpPoliciesEqual(prevMember.mcpPolicy, nextMember.mcpPolicy) ||
      prevMember.runtimeAdvisory?.kind !== nextMember.runtimeAdvisory?.kind ||
      prevMember.runtimeAdvisory?.observedAt !== nextMember.runtimeAdvisory?.observedAt ||
      prevMember.runtimeAdvisory?.retryUntil !== nextMember.runtimeAdvisory?.retryUntil ||
      prevMember.runtimeAdvisory?.retryDelayMs !== nextMember.runtimeAdvisory?.retryDelayMs ||
      prevMember.runtimeAdvisory?.reasonCode !== nextMember.runtimeAdvisory?.reasonCode ||
      prevMember.runtimeAdvisory?.message !== nextMember.runtimeAdvisory?.message
    ) {
      return false;
    }
  }

  return true;
}

function areMemberMcpPoliciesEqual(
  prev: ResolvedTeamMember['mcpPolicy'],
  next: ResolvedTeamMember['mcpPolicy']
): boolean {
  if (prev === next) return true;
  if (!prev || !next) return prev === next;
  return (
    prev.mode === next.mode &&
    prev.scopes?.user === next.scopes?.user &&
    prev.scopes?.project === next.scopes?.project &&
    prev.scopes?.local === next.scopes?.local &&
    (prev.serverNames ?? []).length === (next.serverNames ?? []).length &&
    (prev.serverNames ?? []).every((serverName, index) => serverName === next.serverNames?.[index])
  );
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

const TeamOfflineStatusBanner = memo(function TeamOfflineStatusBanner({
  teamName,
  onLaunch,
}: {
  teamName: string;
  onLaunch: () => void;
}): React.JSX.Element {
  const { t } = useAppTranslation('team');
  const summary = useStore(
    useShallow((s) => {
      const team = s.teamByName[teamName];
      if (!team) {
        return null;
      }

      return {
        memberCount: team.memberCount,
        expectedMemberCount: team.expectedMemberCount,
        confirmedCount: team.confirmedCount,
        runtimeProcessPendingCount: team.runtimeProcessPendingCount,
        teamLaunchState: team.teamLaunchState,
        partialLaunchFailure: team.partialLaunchFailure,
        missingMemberCount: team.missingMembers?.length ?? 0,
      };
    })
  );

  const message =
    summary?.teamLaunchState === 'partial_pending'
      ? summary.runtimeProcessPendingCount != null && summary.runtimeProcessPendingCount > 0
        ? buildPendingRuntimeSummaryCopy({
            confirmedCount: summary.confirmedCount,
            expectedMemberCount: summary.expectedMemberCount,
            memberCount: summary.memberCount,
            runtimeProcessPendingCount: summary.runtimeProcessPendingCount,
          })
        : t('detail.offline.reconciling')
      : summary?.partialLaunchFailure
        ? summary.missingMemberCount > 0
          ? t('detail.offline.partialMissing', {
              missing: summary.missingMemberCount,
              expected: summary.expectedMemberCount ?? summary.missingMemberCount,
            })
          : t('detail.offline.partialFailed')
        : t('detail.offline.offline');

  return (
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
        {message}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 gap-1 px-2 text-xs text-[var(--step-done-text)] hover:bg-[var(--step-done-bg)]"
        onClick={onLaunch}
      >
        <Play size={12} />
        {t('detail.actions.launch')}
      </Button>
    </div>
  );
});

type LeadUpdatedKey = `lead${'Con'}${'text'}UpdatedAt`;
type TeamMessagesPanelBridgeProps = Omit<
  ComponentProps<typeof MessagesPanel>,
  'leadActivity' | LeadUpdatedKey | 'pendingRepliesByMember' | 'onPendingReplyChange'
>;
type SendMessageDialogBridgeProps = Omit<
  ComponentProps<typeof SendMessageDialog>,
  'sending' | 'sendError' | 'sendWarning' | 'sendDebugDetails' | 'lastResult' | 'onSend'
>;
type SendMessageDialogOnSend = ComponentProps<typeof SendMessageDialog>['onSend'];
type PendingRepliesUpdater =
  | Record<string, number>
  | ((current: Record<string, number>) => Record<string, number>);
type SharedTeamMessagesPanelProps = Omit<TeamMessagesPanelBridgeProps, 'position'>;
type TeamMemberListBridgeProps = Omit<
  ComponentProps<typeof MemberList>,
  'leadActivity' | 'memberSpawnStatuses' | 'pendingRepliesByMember'
> & {
  teamName: string;
};
type TeamMemberDetailDialogBridgeProps = Omit<
  ComponentProps<typeof MemberDetailDialog>,
  'leadActivity' | 'spawnEntry' | 'runtimeEntry'
>;
type TeamKanbanBoardBridgeProps = Omit<ComponentProps<typeof KanbanBoard>, 'activeTaskLogActivity'>;
type TeamSidebarRailBridgeProps = Omit<
  ComponentProps<typeof TeamSidebarRail>,
  'messagesPanelProps'
> & {
  messagesPanelProps: SharedTeamMessagesPanelProps;
};
interface LeadLoadBridgeProps {
  teamName: string;
  tabId: string | null;
  projectId: string | null;
  leadSessionId: string | null;
  leadProviderId?: TeamProviderId;
  fallbackProjectRoot?: string;
  isThisTabActive: boolean;
}

const pendingRepliesCacheByTeam = new Map<string, Record<string, number>>();
const pendingRepliesListenersByTeam = new Map<string, Set<() => void>>();

function getPendingRepliesSnapshot(teamName: string): Record<string, number> {
  let snapshot = pendingRepliesCacheByTeam.get(teamName);
  if (!snapshot) {
    snapshot = getTeamPendingRepliesState(teamName);
    pendingRepliesCacheByTeam.set(teamName, snapshot);
  }
  return snapshot;
}

function subscribePendingReplies(teamName: string, listener: () => void): () => void {
  let listeners = pendingRepliesListenersByTeam.get(teamName);
  if (!listeners) {
    listeners = new Set();
    pendingRepliesListenersByTeam.set(teamName, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) {
      pendingRepliesListenersByTeam.delete(teamName);
    }
  };
}

function setPendingRepliesForTeam(teamName: string, updater: PendingRepliesUpdater): void {
  const current = getPendingRepliesSnapshot(teamName);
  const next = typeof updater === 'function' ? updater(current) : updater;
  if (next === current) {
    return;
  }
  pendingRepliesCacheByTeam.set(teamName, next);
  setTeamPendingRepliesState(teamName, next);
  pendingRepliesListenersByTeam.get(teamName)?.forEach((listener) => listener());
}

function useTeamPendingReplies(teamName: string): Record<string, number> {
  const subscribe = useCallback(
    (listener: () => void) => subscribePendingReplies(teamName, listener),
    [teamName]
  );
  const getSnapshot = useCallback(() => getPendingRepliesSnapshot(teamName), [teamName]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const EMPTY_MESSAGES_PANEL_TASKS: TeamTaskWithKanban[] = [];

function buildMessagesPanelTasksSignature(tasks: readonly TeamTaskWithKanban[]): string {
  return JSON.stringify(
    tasks.map((task) => [
      task.id,
      task.displayId ?? '',
      task.subject,
      task.owner ?? '',
      task.reviewer ?? '',
      task.status,
      task.reviewState ?? '',
      task.kanbanColumn ?? '',
    ])
  );
}

function useStableMessagesPanelTasks(
  tasks: TeamTaskWithKanban[] | undefined
): TeamTaskWithKanban[] {
  const sourceTasks = tasks ?? EMPTY_MESSAGES_PANEL_TASKS;
  const signature = useMemo(() => buildMessagesPanelTasksSignature(sourceTasks), [sourceTasks]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- sourceTasks identity is gated by render-relevant task fields.
  return useMemo(() => sourceTasks, [signature]);
}

// Codex/OpenCode lead sessions do not expose the Claude-style context data this panel expects yet.
const LEAD_LOAD_UNSUPPORTED_PROVIDER_IDS = new Set<TeamProviderId>(['codex', 'opencode']);

function canShowLeadLoadUi(providerId: TeamProviderId | undefined): boolean {
  return providerId === undefined || !LEAD_LOAD_UNSUPPORTED_PROVIDER_IDS.has(providerId);
}

function buildMemberSpawnStatusMap(
  memberSpawnStatuses: Record<string, MemberSpawnStatusEntry> | undefined
): Map<string, MemberSpawnStatusEntry> | undefined {
  if (!memberSpawnStatuses) {
    return undefined;
  }

  const map = new Map<string, MemberSpawnStatusEntry>(Object.entries(memberSpawnStatuses));
  return map.size > 0 ? map : undefined;
}

function buildTeamAgentRuntimeMap(
  runtimeSnapshot: Record<string, TeamAgentRuntimeEntry> | undefined
): Map<string, TeamAgentRuntimeEntry> | undefined {
  if (!runtimeSnapshot) {
    return undefined;
  }

  const map = new Map<string, TeamAgentRuntimeEntry>(Object.entries(runtimeSnapshot));
  return map.size > 0 ? map : undefined;
}

const TeamSpawnStatusWatcher = memo(function TeamSpawnStatusWatcher({
  teamName,
  isTeamProvisioning,
  isTeamAlive,
  isThisTabActive,
}: {
  teamName: string;
  isTeamProvisioning: boolean;
  isTeamAlive?: boolean;
  isThisTabActive: boolean;
}): null {
  const { leadActivity, memberSpawnStatuses, memberSpawnSnapshot, fetchMemberSpawnStatuses } =
    useStore(
      useShallow((s) => ({
        leadActivity: s.leadActivityByTeam[teamName],
        memberSpawnStatuses: s.memberSpawnStatusesByTeam[teamName],
        memberSpawnSnapshot: s.memberSpawnSnapshotsByTeam[teamName],
        fetchMemberSpawnStatuses: s.fetchMemberSpawnStatuses,
      }))
    );

  useEffect(() => {
    if (!isThisTabActive) return;

    const hasUnresolvedSpawn = hasUnresolvedMemberSpawnStatus(
      memberSpawnStatuses,
      memberSpawnSnapshot
    );
    const shouldFetchSpawnStatuses =
      isTeamProvisioning ||
      hasUnresolvedSpawn ||
      (memberSpawnStatuses == null &&
        (isTeamAlive === true || leadActivity === 'active' || leadActivity === 'idle'));
    if (shouldFetchSpawnStatuses) {
      void fetchMemberSpawnStatuses(teamName);
    }

    if (!isTeamProvisioning && !hasUnresolvedSpawn) {
      return;
    }

    const interval = window.setInterval(() => {
      void fetchMemberSpawnStatuses(teamName);
    }, MEMBER_SPAWN_STATUS_REFRESH_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [
    fetchMemberSpawnStatuses,
    isTeamAlive,
    isTeamProvisioning,
    isThisTabActive,
    leadActivity,
    memberSpawnSnapshot,
    memberSpawnStatuses,
    teamName,
  ]);

  return null;
});

const TeamAgentRuntimeWatcher = memo(function TeamAgentRuntimeWatcher({
  teamName,
  isTeamProvisioning,
  isTeamAlive,
  isThisTabActive,
}: {
  teamName: string;
  isTeamProvisioning: boolean;
  isTeamAlive?: boolean;
  isThisTabActive: boolean;
}): null {
  useTeamAgentRuntimeWatcher({
    teamName,
    enabled: isThisTabActive,
    isTeamAlive,
    isTeamProvisioning,
  });

  return null;
});

const LeadLoadBridge = memo(function LeadLoadBridge({
  teamName,
  tabId,
  projectId,
  leadSessionId,
  leadProviderId,
  fallbackProjectRoot,
  isThisTabActive,
}: LeadLoadBridgeProps): React.JSX.Element | null {
  const { t } = useAppTranslation('team');
  const {
    leadTabData,
    leadContextSnapshot,
    isContextPanelVisible,
    selectedContextPhase,
    setContextPanelVisibleForTab,
    setSelectedContextPhaseForTab,
  } = useStore(
    useShallow((s) => ({
      leadTabData: tabId ? (s.tabSessionData[tabId] ?? null) : null,
      leadContextSnapshot: s.leadContextByTeam[teamName] ?? null,
      isContextPanelVisible: tabId ? (s.tabUIStates.get(tabId)?.showContextPanel ?? false) : false,
      selectedContextPhase: tabId ? (s.tabUIStates.get(tabId)?.selectedContextPhase ?? null) : null,
      setContextPanelVisibleForTab: s.setContextPanelVisibleForTab,
      setSelectedContextPhaseForTab: s.setSelectedContextPhaseForTab,
    }))
  );
  const [isContextButtonHovered, setIsContextButtonHovered] = useState(false);

  const setContextPanelVisible = useCallback(
    (visible: boolean) => {
      if (!tabId) return;
      setContextPanelVisibleForTab(tabId, visible);
    },
    [setContextPanelVisibleForTab, tabId]
  );
  const setSelectedContextPhase = useCallback(
    (phase: number | null) => {
      if (!tabId) return;
      setSelectedContextPhaseForTab(tabId, phase);
    },
    [setSelectedContextPhaseForTab, tabId]
  );

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
  const { allContextInjections, lastAssistantUsage, lastAssistantModelName } = useMemo(() => {
    if (!leadSessionLoaded || !leadSessionContextStats || !leadConversation?.items.length) {
      return {
        allContextInjections: [] as SessionInjection[],
        lastAssistantUsage: null as UsageLike | null,
        lastAssistantModelName: undefined as string | undefined,
      };
    }

    const effectivePhase = selectedContextPhase;

    let targetAiGroupId: string | undefined;
    if (effectivePhase !== null && leadSessionPhaseInfo) {
      const phase = leadSessionPhaseInfo.phases.find((p) => p.phaseNumber === effectivePhase);
      if (phase) {
        targetAiGroupId = phase.lastAIGroupId;
      }
    }

    if (!targetAiGroupId) {
      const lastAiItem = [...leadConversation.items].reverse().find((item) => item.type === 'ai');
      if (lastAiItem?.type !== 'ai') {
        return {
          allContextInjections: [] as SessionInjection[],
          lastAssistantUsage: null,
          lastAssistantModelName: undefined,
        };
      }
      targetAiGroupId = lastAiItem.group.id;
    }

    const stats = leadSessionContextStats.get(targetAiGroupId);
    const injections = stats?.accumulatedInjections ?? [];

    let lastUsage: UsageLike | null = null;
    let lastModelName: string | undefined;
    const targetItem = leadConversation.items.find(
      (item) => item.type === 'ai' && item.group.id === targetAiGroupId
    );
    if (targetItem?.type === 'ai') {
      const responses = targetItem.group.responses || [];
      for (let i = responses.length - 1; i >= 0; i--) {
        const msg = responses[i];
        if (msg.type === 'assistant' && msg.usage) {
          lastUsage = msg.usage;
          lastModelName = msg.model;
          break;
        }
      }
    }

    return {
      allContextInjections: injections,
      lastAssistantUsage: lastUsage,
      lastAssistantModelName: lastModelName,
    };
  }, [
    leadConversation,
    leadSessionContextStats,
    leadSessionLoaded,
    leadSessionPhaseInfo,
    selectedContextPhase,
  ]);
  const visibleContextTokens = useMemo(
    () => sumInjectionTokens(allContextInjections),
    [allContextInjections]
  );
  const contextMetrics = useMemo(
    () =>
      deriveMetrics({
        usage: lastAssistantUsage,
        modelName: lastAssistantModelName,
        contextWindowTokens: leadContextSnapshot?.contextWindowTokens ?? null,
        visibleContextTokens,
      }),
    [
      lastAssistantModelName,
      lastAssistantUsage,
      leadContextSnapshot?.contextWindowTokens,
      visibleContextTokens,
    ]
  );
  const contextUsedPercentLabel = useMemo(
    () =>
      deriveLeadLoadButtonLabel({
        liveContextUsedPercent: leadContextSnapshot?.contextUsedPercent,
        fullContextUsedPercent: contextMetrics.contextUsedPercentOfContextWindow,
        contextPanelOpen: isContextPanelVisible,
      }),
    [
      contextMetrics.contextUsedPercentOfContextWindow,
      isContextPanelVisible,
      leadContextSnapshot?.contextUsedPercent,
    ]
  );
  const shouldShowLeadContextUi = canShowLeadLoadUi(leadProviderId);
  const shouldLoadFullLeadDetail = Boolean(
    leadSessionId && shouldShowLeadContextUi && isThisTabActive && isContextPanelVisible
  );

  useEffect(() => {
    if (!shouldShowLeadContextUi && isContextPanelVisible) {
      setContextPanelVisible(false);
    }
  }, [isContextPanelVisible, setContextPanelVisible, shouldShowLeadContextUi]);

  if (!leadSessionId || !shouldShowLeadContextUi) {
    return null;
  }

  return (
    <>
      <LeadSessionDetailGate
        tabId={tabId}
        projectId={projectId}
        leadSessionId={leadSessionId}
        enabled={shouldLoadFullLeadDetail}
      />

      {isContextPanelVisible && (
        <div className="w-80 shrink-0">
          {leadSessionLoaded ? (
            <SessionPanel
              injections={allContextInjections}
              onClose={() => setContextPanelVisible(false)}
              projectRoot={leadSessionDetail?.session?.projectPath ?? fallbackProjectRoot}
              contextMetrics={contextMetrics}
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
                  <p className="text-sm font-medium text-[var(--color-text)]">
                    {t('detail.context.title')}
                  </p>
                  <p className="text-[10px] text-[var(--color-text-muted)]">
                    {leadSessionLoading
                      ? t('detail.context.loading')
                      : t('detail.context.noSessionLoaded')}
                  </p>
                </div>
                <button
                  type="button"
                  className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
                  onClick={() => setContextPanelVisible(false)}
                  aria-label={t('detail.context.closePanel', { team: teamName })}
                >
                  ×
                </button>
              </div>
              <div className="flex flex-1 items-center justify-center p-4">
                <p className="text-xs text-[var(--color-text-muted)]">
                  {leadSessionLoading
                    ? t('detail.context.loadingContext')
                    : t('detail.context.openLeadSession')}
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      <div
        className="pointer-events-none fixed bottom-4 z-20"
        style={{ left: isContextPanelVisible ? 'calc(20rem + 1rem)' : '1rem' }}
      >
        <button
          onClick={() => {
            setContextPanelVisible(!isContextPanelVisible);
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
                ? t('detail.context.loadingContext')
                : leadSessionId
          }
        >
          {contextUsedPercentLabel}
        </button>
      </div>
    </>
  );
});

const TeamMemberListBridge = memo(function TeamMemberListBridge({
  teamName,
  ...props
}: TeamMemberListBridgeProps): React.JSX.Element {
  const pendingRepliesByMember = useTeamPendingReplies(teamName);
  const { leadActivity, progress, memberSpawnStatuses, memberSpawnSnapshot, runtimeSnapshot } =
    useStore(
      useShallow((s) => ({
        leadActivity: s.leadActivityByTeam[teamName],
        progress: getCurrentProvisioningProgressForTeam(s, teamName),
        memberSpawnStatuses: s.memberSpawnStatusesByTeam[teamName],
        memberSpawnSnapshot: s.memberSpawnSnapshotsByTeam[teamName],
        runtimeSnapshot: s.teamAgentRuntimeByTeam[teamName],
      }))
    );
  const memberSpawnStatusMap = useMemo(
    () => buildMemberSpawnStatusMap(memberSpawnStatuses),
    [memberSpawnStatuses]
  );
  const memberRuntimeMap = useMemo(
    () => buildTeamAgentRuntimeMap(runtimeSnapshot?.members),
    [runtimeSnapshot?.members]
  );
  const runtimeEntries = runtimeSnapshot?.members;
  const runtimeRunId = runtimeSnapshot?.runId ?? memberSpawnSnapshot?.runId ?? progress?.runId;
  const isLaunchSettling = useMemo(() => {
    if (progress?.state !== 'ready') {
      return false;
    }
    return getLaunchJoinState(
      getLaunchJoinMilestonesFromMembers({
        members: props.members,
        memberSpawnStatuses,
        memberSpawnSnapshot,
        memberRuntimeEntries: runtimeEntries,
      })
    ).hasMembersStillJoining;
  }, [memberSpawnSnapshot, memberSpawnStatuses, progress?.state, props.members, runtimeEntries]);

  return (
    <MemberList
      {...props}
      teamName={teamName}
      leadActivity={leadActivity}
      pendingRepliesByMember={pendingRepliesByMember}
      memberSpawnStatuses={memberSpawnStatusMap}
      memberRuntimeEntries={memberRuntimeMap}
      runtimeRunId={runtimeRunId}
      isLaunchSettling={isLaunchSettling}
    />
  );
});

const TeamMessagesPanelBridge = memo(function TeamMessagesPanelBridge({
  teamName,
  isTeamAlive,
  ...props
}: TeamMessagesPanelBridgeProps): React.JSX.Element {
  const pendingRepliesByMember = useTeamPendingReplies(teamName);
  const pendingReplyRefreshSourceId = useId();
  const pendingReplyRefreshSourceKey = `team-messages:${pendingReplyRefreshSourceId}`;
  const { leadActivity, leadContextUpdatedAt, syncTeamPendingReplyRefresh } = useStore(
    useShallow((s) => ({
      leadActivity: s.leadActivityByTeam[teamName],
      leadContextUpdatedAt: s.leadContextByTeam[teamName]?.updatedAt,
      syncTeamPendingReplyRefresh: s.syncTeamPendingReplyRefresh,
    }))
  );

  useEffect(() => {
    const hasPendingReplies = Object.keys(pendingRepliesByMember).length > 0;
    syncTeamPendingReplyRefresh(
      teamName,
      pendingReplyRefreshSourceKey,
      Boolean(isTeamAlive) && hasPendingReplies,
      TEAM_PENDING_REPLY_REFRESH_DELAY_MS
    );

    return () => {
      syncTeamPendingReplyRefresh(teamName, pendingReplyRefreshSourceKey, false);
    };
  }, [
    isTeamAlive,
    pendingRepliesByMember,
    pendingReplyRefreshSourceKey,
    syncTeamPendingReplyRefresh,
    teamName,
  ]);

  const handlePendingReplyChange = useCallback(
    (updater: PendingRepliesUpdater) => {
      setPendingRepliesForTeam(teamName, updater);
    },
    [teamName]
  );

  return (
    <MessagesPanel
      {...props}
      teamName={teamName}
      isTeamAlive={isTeamAlive}
      leadActivity={leadActivity}
      leadContextUpdatedAt={leadContextUpdatedAt}
      pendingRepliesByMember={pendingRepliesByMember}
      onPendingReplyChange={handlePendingReplyChange}
    />
  );
});

const TeamSidebarRailBridge = memo(function TeamSidebarRailBridge({
  messagesPanelProps,
  ...props
}: TeamSidebarRailBridgeProps): React.JSX.Element {
  const teamName = messagesPanelProps.teamName;
  const pendingRepliesByMember = useTeamPendingReplies(teamName);
  const pendingReplyRefreshSourceId = useId();
  const pendingReplyRefreshSourceKey = `team-sidebar:${pendingReplyRefreshSourceId}`;
  const { leadActivity, leadContextUpdatedAt, syncTeamPendingReplyRefresh } = useStore(
    useShallow((s) => ({
      leadActivity: s.leadActivityByTeam[teamName],
      leadContextUpdatedAt: s.leadContextByTeam[teamName]?.updatedAt,
      syncTeamPendingReplyRefresh: s.syncTeamPendingReplyRefresh,
    }))
  );
  useEffect(() => {
    const hasPendingReplies = Object.keys(pendingRepliesByMember).length > 0;
    syncTeamPendingReplyRefresh(
      teamName,
      pendingReplyRefreshSourceKey,
      Boolean(messagesPanelProps.isTeamAlive) && hasPendingReplies,
      TEAM_PENDING_REPLY_REFRESH_DELAY_MS
    );

    return () => {
      syncTeamPendingReplyRefresh(teamName, pendingReplyRefreshSourceKey, false);
    };
  }, [
    messagesPanelProps.isTeamAlive,
    pendingRepliesByMember,
    pendingReplyRefreshSourceKey,
    syncTeamPendingReplyRefresh,
    teamName,
  ]);

  const handlePendingReplyChange = useCallback(
    (updater: PendingRepliesUpdater) => {
      setPendingRepliesForTeam(teamName, updater);
    },
    [teamName]
  );
  const bridgedMessagesPanelProps = useMemo(
    () => ({
      ...messagesPanelProps,
      leadActivity,
      leadContextUpdatedAt,
      pendingRepliesByMember,
      onPendingReplyChange: handlePendingReplyChange,
    }),
    [
      handlePendingReplyChange,
      leadActivity,
      leadContextUpdatedAt,
      messagesPanelProps,
      pendingRepliesByMember,
    ]
  );

  return <TeamSidebarRail {...props} messagesPanelProps={bridgedMessagesPanelProps} />;
});

const SendMessageDialogBridge = memo(function SendMessageDialogBridge({
  teamName,
  ...props
}: SendMessageDialogBridgeProps): React.JSX.Element {
  const {
    sendTeamMessage,
    sendingMessage,
    sendMessageError,
    sendMessageWarning,
    sendMessageDebugDetails,
    lastSendMessageResult,
  } = useStore(
    useShallow((s) => ({
      sendTeamMessage: s.sendTeamMessage,
      sendingMessage: s.sendingMessage,
      sendMessageError: s.sendMessageError,
      sendMessageWarning: s.sendMessageWarning,
      sendMessageDebugDetails: s.sendMessageDebugDetails,
      lastSendMessageResult: s.lastSendMessageResult,
    }))
  );

  const handleSend = useCallback<SendMessageDialogOnSend>(
    async (member, text, summary, attachments, actionMode, taskRefs) => {
      const sentAtMs = Date.now();
      setPendingRepliesForTeam(teamName, (prev) => ({ ...prev, [member]: sentAtMs }));
      try {
        const result = await sendTeamMessage(teamName, {
          member,
          text,
          summary,
          attachments,
          actionMode,
          taskRefs,
        });
        if (shouldClearPendingReplyForOpenCodeRuntimeDelivery(result?.runtimeDelivery)) {
          setPendingRepliesForTeam(teamName, (prev) => {
            if (prev[member] !== sentAtMs) return prev;
            const next = { ...prev };
            delete next[member];
            return next;
          });
        }
        return result;
      } catch (error) {
        setPendingRepliesForTeam(teamName, (prev) => {
          if (prev[member] !== sentAtMs) return prev;
          const next = { ...prev };
          delete next[member];
          return next;
        });
        throw error;
      }
    },
    [sendTeamMessage, teamName]
  );

  return (
    <SendMessageDialog
      {...props}
      teamName={teamName}
      sending={sendingMessage}
      sendError={sendMessageError}
      sendWarning={sendMessageWarning}
      sendDebugDetails={sendMessageDebugDetails}
      lastResult={lastSendMessageResult}
      onSend={handleSend}
    />
  );
});

const TeamMemberDetailDialogBridge = memo(function TeamMemberDetailDialogBridge({
  teamName,
  member,
  ...props
}: TeamMemberDetailDialogBridgeProps): React.JSX.Element | null {
  const {
    leadActivity,
    liveMember,
    progress,
    launchMembers,
    memberSpawnStatuses,
    memberSpawnSnapshot,
    spawnEntry,
    runtimeRunId,
    runtimeEntries,
    runtimeEntry,
  } = useStore(
    useShallow((s) => ({
      leadActivity: s.leadActivityByTeam[teamName],
      liveMember: member ? selectResolvedMemberForTeamName(s, teamName, member.name) : null,
      progress: getCurrentProvisioningProgressForTeam(s, teamName),
      launchMembers: selectTeamMemberSnapshotsForName(s, teamName),
      memberSpawnStatuses: s.memberSpawnStatusesByTeam[teamName],
      memberSpawnSnapshot: s.memberSpawnSnapshotsByTeam[teamName],
      spawnEntry: member ? s.memberSpawnStatusesByTeam[teamName]?.[member.name] : undefined,
      runtimeRunId:
        s.teamAgentRuntimeByTeam[teamName]?.runId ??
        s.memberSpawnSnapshotsByTeam[teamName]?.runId ??
        getCurrentProvisioningProgressForTeam(s, teamName)?.runId,
      runtimeEntries: s.teamAgentRuntimeByTeam[teamName]?.members,
      runtimeEntry: member ? s.teamAgentRuntimeByTeam[teamName]?.members[member.name] : undefined,
    }))
  );
  const isLaunchSettling = useMemo(() => {
    if (progress?.state !== 'ready') {
      return false;
    }
    return getLaunchJoinState(
      getLaunchJoinMilestonesFromMembers({
        members: launchMembers,
        memberSpawnStatuses,
        memberSpawnSnapshot,
        memberRuntimeEntries: runtimeEntries,
      })
    ).hasMembersStillJoining;
  }, [launchMembers, memberSpawnSnapshot, memberSpawnStatuses, progress?.state, runtimeEntries]);

  return (
    <MemberDetailDialog
      {...props}
      teamName={teamName}
      member={liveMember ?? member}
      isLaunchSettling={isLaunchSettling}
      leadActivity={leadActivity}
      spawnEntry={spawnEntry}
      runtimeEntry={runtimeEntry}
      runtimeRunId={runtimeRunId}
    />
  );
});

const TeamKanbanBoardBridge = memo(function TeamKanbanBoardBridge({
  teamName,
  ...props
}: TeamKanbanBoardBridgeProps): React.JSX.Element {
  const activeTaskLogActivity = useStore((s) => s.activeTaskLogActivityByTeam[teamName]);

  return (
    <KanbanBoard {...props} teamName={teamName} activeTaskLogActivity={activeTaskLogActivity} />
  );
});

export const TeamDetailView = memo(function TeamDetailView({
  teamName,
  isActive = true,
  isPaneFocused = false,
}: TeamDetailViewProps): React.JSX.Element {
  const { t } = useAppTranslation('team');
  const { isLight } = useTheme();
  const [requestChangesTaskId, setRequestChangesTaskId] = useState<string | null>(null);
  const [selectedMember, setSelectedMember] = useState<ResolvedTeamMember | null>(null);
  const [selectedMemberView, setSelectedMemberView] = useState<{
    initialTab?: MemberDetailTab;
    initialActivityFilter?: MemberActivityFilter;
  } | null>(null);
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
  const [launchDialogState, setLaunchDialogState] = useState<{
    open: boolean;
    mode: TeamLaunchDialogMode;
  }>({
    open: false,
    mode: 'launch',
  });
  const [editorOpen, setEditorOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const visualizeButtonAnchorRef = useRef<HTMLDivElement>(null);
  const taskDetailDialogRef = useRef<TaskDetailDialogHostHandle>(null);
  const taskDetailDialogPreloadScheduledRef = useRef(false);
  const [pinnedVisualizeButtonPosition, setPinnedVisualizeButtonPosition] = useState<{
    right: number;
    top: number;
  } | null>(null);
  const [messagesPanelMountPoint, setMessagesPanelMountPoint] = useState<HTMLDivElement | null>(
    null
  );
  const [floatingComposerHeight, setFloatingComposerHeight] = useState(0);
  const provisioningBannerRef = useRef<HTMLDivElement>(null);
  const wasProvisioningRef = useRef(false);
  const handleFloatingComposerHeightChange = useCallback((height: number) => {
    setFloatingComposerHeight((currentHeight) =>
      currentHeight === height ? currentHeight : height
    );
  }, []);
  const handleOpenGraphTab = useCallback(() => {
    const state = useStore.getState();
    const displayName = state.teamByName[teamName]?.displayName ?? teamName;
    state.openTab({
      type: 'graph',
      label: `${displayName} Graph`,
      teamName,
    });
  }, [teamName]);
  const visualizeButtonStyle = useMemo<CSSProperties>(
    () =>
      isLight
        ? {
            background:
              'linear-gradient(135deg, rgba(59,130,246,0.14) 0%, rgba(34,197,94,0.16) 100%)',
            borderColor: 'rgba(59,130,246,0.30)',
            color: '#0f172a',
            boxShadow: '0 10px 24px rgba(59,130,246,0.12)',
          }
        : {
            background:
              'linear-gradient(135deg, rgba(56,189,248,0.18) 0%, rgba(16,185,129,0.16) 100%)',
            borderColor: 'rgba(56,189,248,0.34)',
            color: 'rgba(236,253,255,0.96)',
            boxShadow: '0 12px 28px rgba(8,145,178,0.22)',
          },
    [isLight]
  );

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
        handleOpenGraphTab();
      }
    };
    window.addEventListener('toggle-team-graph', handler);
    return () => window.removeEventListener('toggle-team-graph', handler);
  }, [handleOpenGraphTab, teamName]);

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
  const launchDialogOpen = launchDialogState.open;

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
    members,
    loading,
    error,
    projects,
    repositoryGroups,
    initTabUIState,
    selectTeam,
    updateKanban,
    updateKanbanColumnOrder,
    updateTaskStatus,
    updateTaskOwner,
    requestReview,
    createTeamTask,
    startTaskByUser,
    deleteTeam,
    openTeamsTab,
    closeTab,
    reviewActionError,
    addMember,
    restartMember,
    skipMemberForLaunch,
    removeMember,
    restoreMember,
    updateMemberRole,
    launchTeam,
    provisioningError,
    clearProvisioningError,
    isTeamProvisioning,
    refreshTeamData,
    refreshTeamMessagesHead,
    refreshMemberActivityMeta,
    kanbanFilterQuery,
    clearKanbanFilter,
    softDeleteTask,
    restoreTask,
    fetchDeletedTasks,
    deletedTasks,
    launchParams,
    messagesPanelMode,
    messagesPanelWidth,
    sidebarLogsHeight,
    setMessagesPanelMode,
    setMessagesPanelWidth,
    setSidebarLogsHeight,
    selectReviewFile,
    pendingReviewRequest,
    setPendingReviewRequest,
    summaryKnownTeammateCount,
    teamSummaryColor,
    teamSummaryDisplayName,
  } = useStore(
    useShallow((s) => ({
      projects: s.projects,
      repositoryGroups: s.repositoryGroups,
      initTabUIState: s.initTabUIState,
      selectTeam: s.selectTeam,
      updateKanban: s.updateKanban,
      updateKanbanColumnOrder: s.updateKanbanColumnOrder,
      updateTaskStatus: s.updateTaskStatus,
      updateTaskOwner: s.updateTaskOwner,
      requestReview: s.requestReview,
      createTeamTask: s.createTeamTask,
      startTaskByUser: s.startTaskByUser,
      deleteTeam: s.deleteTeam,
      openTeamsTab: s.openTeamsTab,
      closeTab: s.closeTab,
      reviewActionError: s.reviewActionError,
      addMember: s.addMember,
      restartMember: s.restartMember,
      skipMemberForLaunch: s.skipMemberForLaunch,
      removeMember: s.removeMember,
      restoreMember: s.restoreMember,
      updateMemberRole: s.updateMemberRole,
      launchTeam: s.launchTeam,
      provisioningError: teamName ? (s.provisioningErrorByTeam[teamName] ?? null) : null,
      clearProvisioningError: s.clearProvisioningError,
      isTeamProvisioning: teamName ? isTeamProvisioningActive(s, teamName) : false,
      data: s.selectedTeamName === teamName ? s.selectedTeamData : null,
      members: selectResolvedMembersForTeamName(s, teamName),
      summaryKnownTeammateCount: teamName
        ? getSummaryKnownTeammateCount(s.teamByName[teamName])
        : 0,
      teamSummaryColor: teamName ? s.teamByName[teamName]?.color : undefined,
      teamSummaryDisplayName: teamName ? s.teamByName[teamName]?.displayName : undefined,
      loading: s.selectedTeamName === teamName ? s.selectedTeamLoading : false,
      error: s.selectedTeamName === teamName ? s.selectedTeamError : null,
      refreshTeamData: s.refreshTeamData,
      refreshTeamMessagesHead: s.refreshTeamMessagesHead,
      refreshMemberActivityMeta: s.refreshMemberActivityMeta,
      kanbanFilterQuery: s.kanbanFilterQuery,
      clearKanbanFilter: s.clearKanbanFilter,
      softDeleteTask: s.softDeleteTask,
      restoreTask: s.restoreTask,
      fetchDeletedTasks: s.fetchDeletedTasks,
      deletedTasks: s.deletedTasks,
      launchParams: teamName ? s.launchParamsByTeam[teamName] : undefined,
      messagesPanelMode: s.messagesPanelMode,
      messagesPanelWidth: s.messagesPanelWidth,
      sidebarLogsHeight: s.sidebarLogsHeight,
      setMessagesPanelMode: s.setMessagesPanelMode,
      setMessagesPanelWidth: s.setMessagesPanelWidth,
      setSidebarLogsHeight: s.setSidebarLogsHeight,
      selectReviewFile: s.selectReviewFile,
      pendingReviewRequest: s.pendingReviewRequest,
      setPendingReviewRequest: s.setPendingReviewRequest,
    }))
  );

  const tabId = useOptionalTabId();
  const isThisTabActive = isActive;
  const wasInteractiveRef = useRef(false);
  const memberRosterHydrationRetryRef = useRef<string | null>(null);
  const loadingHeaderColorSet = useMemo(
    () =>
      teamSummaryColor
        ? getTeamColorSet(teamSummaryColor)
        : nameColorSet(teamSummaryDisplayName || teamName),
    [teamName, teamSummaryColor, teamSummaryDisplayName]
  );
  const canTrackVisualizeButton = data?.teamName === teamName;

  // Messages panel resize
  const { isResizing: isMessagesPanelResizing, handleProps: messagesPanelHandleProps } =
    useResizablePanel({
      width: messagesPanelWidth,
      onWidthChange: setMessagesPanelWidth,
      minWidth: 280,
      maxWidth: 600,
      side: 'left',
    });
  const { isResizing: isLogsPanelResizing, handleProps: logsPanelHandleProps } = useResizablePanel({
    height: sidebarLogsHeight,
    onHeightChange: setSidebarLogsHeight,
    minHeight: 120,
    maxHeight: 520,
    side: 'top',
  });

  const changeMessagesPanelMode = useCallback(
    (mode: TeamMessagesPanelMode) => {
      setMessagesPanelMode(mode);
    },
    [setMessagesPanelMode]
  );
  useEffect(() => {
    if (tabId) {
      initTabUIState(tabId);
    }
  }, [tabId, initTabUIState]);

  useEffect(() => {
    const wasProvisioning = wasProvisioningRef.current;
    wasProvisioningRef.current = isTeamProvisioning;
    if (!isThisTabActive) return;
    if (!wasProvisioning && isTeamProvisioning) {
      provisioningBannerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [isTeamProvisioning, isThisTabActive]);

  useEffect(() => {
    const container = contentRef.current;
    if (!container || !canTrackVisualizeButton || graphOpen) {
      setPinnedVisualizeButtonPosition(null);
      return undefined;
    }

    const updatePinnedButton = (): void => {
      const anchor = visualizeButtonAnchorRef.current;
      const currentContainer = contentRef.current;
      if (!anchor || !currentContainer) {
        setPinnedVisualizeButtonPosition(null);
        return;
      }

      const containerRect = currentContainer.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      const top = Math.round(containerRect.top + 12);
      const right = Math.round(Math.max(window.innerWidth - containerRect.right + 16, 16));
      const shouldPin = currentContainer.scrollTop > 0 && anchorRect.top <= top;

      setPinnedVisualizeButtonPosition((current) => {
        if (!shouldPin) return current === null ? current : null;
        if (current?.top === top && current.right === right) return current;
        return { right, top };
      });
    };

    updatePinnedButton();
    container.addEventListener('scroll', updatePinnedButton, { passive: true });
    window.addEventListener('resize', updatePinnedButton);

    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePinnedButton);
    resizeObserver?.observe(container);

    return () => {
      container.removeEventListener('scroll', updatePinnedButton);
      window.removeEventListener('resize', updatePinnedButton);
      resizeObserver?.disconnect();
    };
  }, [canTrackVisualizeButton, graphOpen]);

  const [kanbanSearch, setKanbanSearch] = useState('');

  // Open editor overlay when a file reveal is requested (e.g. from chip click)
  const pendingRevealFile = useStore((s) => s.editorPendingRevealFile);
  useEffect(() => {
    if (!isThisTabActive) return;
    if (pendingRevealFile && data?.config.projectPath) {
      setEditorOpen(true);
    }
  }, [isThisTabActive, pendingRevealFile, data?.config.projectPath]);

  useEffect(() => {
    if (!isThisTabActive || !teamName) {
      return;
    }
    void selectTeam(teamName);
    void fetchDeletedTasks(teamName);
  }, [isThisTabActive, teamName, selectTeam, fetchDeletedTasks]);

  // Re-trigger selectTeam when this visible tab becomes active and store data is stale.
  const storedTeamName = data?.teamName;
  useEffect(() => {
    if (!isThisTabActive || !teamName || loading) return;
    if (storedTeamName != null && storedTeamName !== teamName) {
      void selectTeam(teamName);
    }
  }, [isThisTabActive, teamName, storedTeamName, loading, selectTeam]);

  useEffect(() => {
    const isInteractive = isThisTabActive && isPaneFocused;
    const justBecameInteractive = isInteractive && !wasInteractiveRef.current;
    wasInteractiveRef.current = isInteractive;
    if (!justBecameInteractive || !teamName) {
      return;
    }

    void (async () => {
      try {
        const headResult = await refreshTeamMessagesHead(teamName);
        if (headResult.feedChanged) {
          await refreshMemberActivityMeta(teamName);
        }
      } catch {
        // Best-effort refresh on tab focus.
      }
    })();
  }, [
    isPaneFocused,
    isThisTabActive,
    refreshMemberActivityMeta,
    refreshTeamMessagesHead,
    teamName,
  ]);

  // Fetch active teams when launch dialog opens (for conflict warning)
  useEffect(() => {
    if (!isThisTabActive || !launchDialogOpen) return;
    let cancelled = false;
    const teamsSnapshot = useStore.getState().teams;
    void (async () => {
      try {
        const aliveList = await api.teams.aliveList();
        if (cancelled) return;
        const aliveSet = new Set(aliveList);
        const refs = teamsSnapshot
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
  }, [isThisTabActive, launchDialogOpen]);

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

  const leadSessionId = data?.config.leadSessionId ?? null;
  const sessionHistorySource = data?.config.sessionHistory;
  const sessionHistoryKey = useMemo(
    () => (sessionHistorySource ?? EMPTY_SESSION_HISTORY).join('|'),
    [sessionHistorySource]
  );
  const sessionHistoryCacheRef = useRef<{ key: string; value: readonly string[] }>({
    key: '',
    value: EMPTY_SESSION_HISTORY,
  });
  const sessionHistory = useMemo(() => {
    if (!sessionHistorySource || sessionHistorySource.length === 0) {
      return EMPTY_SESSION_HISTORY;
    }
    const cached = sessionHistoryCacheRef.current;
    if (cached.key === sessionHistoryKey) {
      return cached.value;
    }
    const value = [...sessionHistorySource];
    sessionHistoryCacheRef.current = { key: sessionHistoryKey, value };
    return value;
  }, [sessionHistoryKey, sessionHistorySource]);

  useEffect(() => {
    if (!isThisTabActive || !projectId) return;

    let cancelled = false;
    setSessionsLoading(true);
    setSessionsError(null);

    void (async () => {
      try {
        const result = await loadTeamSessionMetadata(api, projectId, {
          leadSessionId,
          sessionHistory,
        });
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
  }, [isThisTabActive, leadSessionId, projectId, sessionHistory]);

  // Live git branch tracking for the lead project and member worktrees
  const teamProjectPath = data?.config.projectPath?.trim() ?? null;
  const leadProjectPath = useMemo(() => {
    const explicitLeadPath = members.find((member) => isLeadMember(member))?.cwd?.trim();
    return explicitLeadPath && explicitLeadPath.length > 0 ? explicitLeadPath : teamProjectPath;
  }, [members, teamProjectPath]);
  const branchSyncPaths = useMemo(() => {
    const uniquePaths = new Map<string, string>();
    const addPath = (candidate: string | null | undefined): void => {
      const trimmed = candidate?.trim();
      if (!trimmed) return;
      const key = normalizePath(trimmed);
      if (!key || uniquePaths.has(key)) return;
      uniquePaths.set(key, trimmed);
    };

    addPath(leadProjectPath);
    for (const member of members) {
      addPath(member.cwd);
    }

    return Array.from(uniquePaths.values());
  }, [members, leadProjectPath]);
  const activeBranchSyncPaths = useMemo(
    () => (isThisTabActive ? branchSyncPaths : []),
    [branchSyncPaths, isThisTabActive]
  );
  useBranchSync(activeBranchSyncPaths, { live: isThisTabActive });
  const trackedBranches = useStore(
    useShallow((s) =>
      Object.fromEntries(
        branchSyncPaths.map((projectPath) => {
          const normalizedPath = normalizePath(projectPath);
          return [normalizedPath, s.branchByPath[normalizedPath] ?? null] as const;
        })
      )
    )
  );
  const leadBranch = leadProjectPath
    ? (trackedBranches[normalizePath(leadProjectPath)] ?? null)
    : null;
  const hasSelectedTeamData = data !== null;
  const membersWithLiveBranches = useMemo(() => {
    if (!hasSelectedTeamData) return [];

    return members.map((member) => {
      const memberPath = member.cwd?.trim();
      const nextGitBranch =
        memberPath && !isLeadMember(member) && leadBranch !== null
          ? (() => {
              const branch = trackedBranches[normalizePath(memberPath)] ?? null;
              return branch && branch !== leadBranch ? branch : undefined;
            })()
          : undefined;

      if (member.gitBranch === nextGitBranch) {
        return member;
      }

      const nextMember: ResolvedTeamMember = { ...member };
      if (nextGitBranch) {
        nextMember.gitBranch = nextGitBranch;
      } else {
        delete nextMember.gitBranch;
      }
      return nextMember;
    });
  }, [hasSelectedTeamData, leadBranch, members, trackedBranches]);
  const resolvedMemberColorMap = useMemo(
    () => buildMemberColorMap(membersWithLiveBranches),
    [membersWithLiveBranches]
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

  const activeMembers = useStableActiveMembers(membersWithLiveBranches);

  const kanbanSearchQuery = kanbanSearch.trim();
  const isKanbanSearchActive = kanbanSearchQuery.length > 0;
  const kanbanDisplayTasks = useMemo(() => {
    if (!kanbanSearchQuery) return filteredTasks;
    return filterKanbanTasks(filteredTasks, kanbanSearchQuery);
  }, [filteredTasks, kanbanSearchQuery]);

  useEffect(() => {
    if (taskDetailDialogPreloadScheduledRef.current) {
      return;
    }

    taskDetailDialogPreloadScheduledRef.current = true;
    // Start this with the team page, before slow task data can delay the first task click.
    scheduleStartupIdleTask(preloadTaskDetailDialog, {
      minDelayMs: 250,
      maxDelayMs: 2500,
    });
  }, []);

  const resolvedActiveTeammateCount = useMemo(
    () => activeMembers.filter((m) => !isLeadMember(m)).length,
    [activeMembers]
  );
  const activeTeammateCount = useMemo(() => {
    if (membersWithLiveBranches.some((m) => m.removedAt)) {
      return resolvedActiveTeammateCount;
    }
    return resolvedActiveTeammateCount > 0
      ? resolvedActiveTeammateCount
      : summaryKnownTeammateCount;
  }, [membersWithLiveBranches, resolvedActiveTeammateCount, summaryKnownTeammateCount]);

  const memberRosterHydrationRetryKey = useMemo(() => {
    if (
      !isThisTabActive ||
      !teamName ||
      !data ||
      summaryKnownTeammateCount <= 0 ||
      resolvedActiveTeammateCount > 0
    ) {
      return null;
    }

    return [
      teamName,
      data.teamName,
      data.members.length,
      data.config.members?.length ?? 0,
      data.config.sessionHistory?.join(',') ?? '',
      summaryKnownTeammateCount,
      loading ? 'loading' : 'settled',
      isTeamProvisioning ? 'provisioning' : 'ready',
    ].join('|');
  }, [
    data,
    isTeamProvisioning,
    isThisTabActive,
    loading,
    resolvedActiveTeammateCount,
    summaryKnownTeammateCount,
    teamName,
  ]);

  useEffect(() => {
    if (!memberRosterHydrationRetryKey) {
      return;
    }
    if (memberRosterHydrationRetryRef.current === memberRosterHydrationRetryKey) {
      return;
    }

    const timer = window.setTimeout(() => {
      const state = useStore.getState();
      if (state.selectedTeamName !== teamName) {
        return;
      }

      const currentMembers = selectResolvedMembersForTeamName(state, teamName);
      const hasResolvedTeammate = currentMembers.some(
        (member) => !member.removedAt && !isLeadMember(member)
      );
      const expectedTeammateCount = getSummaryKnownTeammateCount(state.teamByName[teamName]);
      if (!hasResolvedTeammate && expectedTeammateCount > 0) {
        memberRosterHydrationRetryRef.current = memberRosterHydrationRetryKey;
        void refreshTeamData(teamName, { withDedup: false });
      }
    }, MEMBER_ROSTER_HYDRATION_RETRY_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [memberRosterHydrationRetryKey, refreshTeamData, teamName]);
  const leadProviderId = useMemo<TeamProviderId | undefined>(() => {
    const activeLeadProviderId = activeMembers.find(isLeadMember)?.providerId;
    if (activeLeadProviderId) return activeLeadProviderId;
    const configuredLeadProviderId = data?.config.members?.find(isLeadMember)?.providerId;
    if (configuredLeadProviderId) return configuredLeadProviderId;
    return launchParams?.providerId;
  }, [activeMembers, data?.config.members, launchParams?.providerId]);
  const taskMap = useMemo(() => new Map((data?.tasks ?? []).map((t) => [t.id, t])), [data?.tasks]);
  const taskMapRef = useRef(taskMap);
  taskMapRef.current = taskMap;

  const memberTaskCounts = useMemo(() => buildTaskCountsByOwner(data?.tasks ?? []), [data?.tasks]);

  const openCreateTaskDialog = useCallback(
    (subject = '', description = '', owner = '', startImmediately?: boolean): void => {
      setCreateTaskDialog({
        open: true,
        defaultSubject: subject,
        defaultDescription: description,
        defaultOwner: owner,
        defaultStartImmediately: startImmediately,
      });
    },
    []
  );

  const closeCreateTaskDialog = useCallback((): void => {
    setCreateTaskDialog({
      open: false,
      defaultSubject: '',
      defaultDescription: '',
      defaultOwner: '',
      defaultStartImmediately: undefined,
    });
  }, []);

  const handleCreateTaskFromMessage = useCallback(
    (subject: string, description: string) => {
      openCreateTaskDialog(subject, description);
    },
    [openCreateTaskDialog]
  );

  const handleReplyToMessage = useCallback((message: { from: string; text: string }) => {
    setSendDialogRecipient(message.from);
    setSendDialogDefaultText(undefined);
    setSendDialogDefaultChip(undefined);
    setReplyQuote({ from: message.from, text: stripAgentBlocks(message.text) });
    setSendDialogOpen(true);
  }, []);

  const openLaunchDialog = useCallback((mode: TeamLaunchDialogMode) => {
    setLaunchDialogState({ open: true, mode });
  }, []);

  const closeLaunchDialog = useCallback(() => {
    setLaunchDialogState((prev) => ({ ...prev, open: false }));
  }, []);

  const handleRestartTeam = useCallback(() => {
    openLaunchDialog('relaunch');
  }, [openLaunchDialog]);

  const handleLaunchDialogSubmit = useCallback(
    async (request: TeamLaunchRequest): Promise<void> => {
      await launchTeam(request);
    },
    [launchTeam]
  );

  const handleRelaunchDialogSubmit = useCallback(
    async (
      request: TeamLaunchRequest,
      nextMembers: TeamCreateRequest['members']
    ): Promise<void> => {
      await executeTeamRelaunch({
        teamName,
        isTeamAlive: data?.isAlive === true,
        request,
        members: nextMembers,
        stopTeam: (nextTeamName) => api.teams.stop(nextTeamName),
        replaceMembers: (nextTeamName, nextRequest) =>
          api.teams.replaceMembers(nextTeamName, nextRequest),
        launchTeam,
      });
    },
    [data?.isAlive, launchTeam, teamName]
  );

  const handleChangeLeadRuntime = useCallback(() => {
    setEditDialogOpen(false);
    openLaunchDialog(data?.isAlive && !isTeamProvisioning ? 'relaunch' : 'launch');
  }, [data?.isAlive, isTeamProvisioning, openLaunchDialog]);

  const handleRestartMember = useCallback(
    async (memberName: string): Promise<void> => {
      await restartMember(teamName, memberName);
    },
    [restartMember, teamName]
  );

  const handleSkipMemberForLaunch = useCallback(
    async (memberName: string): Promise<void> => {
      await skipMemberForLaunch(teamName, memberName);
    },
    [skipMemberForLaunch, teamName]
  );

  const handleRestoreMember = useCallback(
    async (memberName: string): Promise<void> => {
      await restoreMember(teamName, memberName);
    },
    [restoreMember, teamName]
  );

  const handleSelectMember = useCallback((member: ResolvedTeamMember) => {
    setSelectedMember(member);
    setSelectedMemberView(null);
  }, []);

  const closeSelectedMemberDialog = useCallback(() => {
    setSelectedMember(null);
    setSelectedMemberView(null);
  }, []);

  const openTaskDetailDialog = useCallback((task: TeamTaskWithKanban) => {
    taskDetailDialogRef.current?.openTask(task);
  }, []);

  const handleSendMessageToMember = useCallback((member: ResolvedTeamMember) => {
    setSendDialogRecipient(member.name);
    setSendDialogDefaultText(undefined);
    setSendDialogDefaultChip(undefined);
    setReplyQuote(undefined);
    setSendDialogOpen(true);
  }, []);

  const handleAssignTaskToMember = useCallback(
    (member: ResolvedTeamMember) => {
      openCreateTaskDialog('', '', member.name);
    },
    [openCreateTaskDialog]
  );

  const handleOpenTaskById = useCallback(
    (taskId: string) => {
      const task = taskMapRef.current.get(taskId);
      if (task) {
        openTaskDetailDialog(task);
      }
    },
    [openTaskDetailDialog]
  );

  const handleOpenMessagePanelTask = useCallback(
    (task: TeamTaskWithKanban) => {
      handleOpenTaskById(task.id);
    },
    [handleOpenTaskById]
  );

  const handleTaskIdClick = useCallback(
    (taskId: string) => {
      const task =
        taskMap.get(taskId) ?? data?.tasks.find((candidate) => candidate.displayId === taskId);
      if (task) openTaskDetailDialog(task);
    },
    [data?.tasks, openTaskDetailDialog, taskMap]
  );

  const handleTaskOwnerChange = useCallback(
    (taskId: string, owner: string | null) => {
      void (async () => {
        try {
          await updateTaskOwner(teamName, taskId, owner);
        } catch {
          // error via store
        }
      })();
    },
    [teamName, updateTaskOwner]
  );

  const handleOpenTaskFileInEditor = useCallback((filePath: string) => {
    const { revealFileInEditor } = useStore.getState();
    revealFileInEditor(filePath);
  }, []);

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

    [openCreateTaskDialog]
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

  // Pick up pending review request from GlobalTaskDetailDialog
  useEffect(() => {
    if (!isThisTabActive) return;
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
  }, [isThisTabActive, pendingReviewRequest, selectReviewFile, setPendingReviewRequest]);

  const pendingTeamSectionFocus = useStore((s) => s.pendingTeamSectionFocus);
  const clearTeamSectionFocus = useStore((s) => s.clearTeamSectionFocus);
  useEffect(() => {
    if (!isThisTabActive) return;
    if (pendingTeamSectionFocus?.teamName !== teamName) return;

    const sectionId =
      pendingTeamSectionFocus.section === 'members'
        ? 'team'
        : pendingTeamSectionFocus.section === 'tasks'
          ? 'kanban'
          : pendingTeamSectionFocus.section;

    if (sectionId === 'overview') {
      contentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      clearTeamSectionFocus();
      return;
    }

    const section = contentRef.current?.querySelector<HTMLElement>(
      `[data-section-id="${sectionId}"]`
    );
    if (!section) return;
    section.dispatchEvent(new CustomEvent('team-section-navigate'));
    clearTeamSectionFocus();
  }, [pendingTeamSectionFocus, clearTeamSectionFocus, isThisTabActive, teamName, data]);

  // Pick up pending member profile request from MemberHoverCard
  const pendingMemberProfile = useStore((s) => s.pendingMemberProfile);
  useEffect(() => {
    if (!isThisTabActive) return;
    if (!pendingMemberProfile || !data) return;
    if (pendingMemberProfile.teamName && pendingMemberProfile.teamName !== teamName) return;

    const member = membersWithLiveBranches.find((m) => m.name === pendingMemberProfile.memberName);
    if (member) {
      setSelectedMember(member);
      setSelectedMemberView({
        initialTab:
          pendingMemberProfile.focus === 'logs'
            ? 'logs'
            : pendingMemberProfile.focus === 'messages'
              ? 'activity'
              : undefined,
      });
    }
    useStore.getState().closeMemberProfile();
  }, [isThisTabActive, pendingMemberProfile, membersWithLiveBranches, teamName, data]);

  const handleDeleteTask = useCallback(
    (taskId: string) => {
      void (async () => {
        const confirmed = await confirm({
          title: t('tasks.deleteConfirm.title'),
          message: t('tasks.deleteConfirm.message', { taskId: deriveTaskDisplayId(taskId) }),
          confirmLabel: t('tasks.deleteConfirm.confirmLabel'),
          cancelLabel: t('tasks.deleteConfirm.cancelLabel'),
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
    [teamName, softDeleteTask, t]
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

  const handleRequestReview = useCallback(
    (taskId: string) => {
      void (async () => {
        try {
          await requestReview(teamName, taskId);
        } catch {
          // error via store
        }
      })();
    },
    [requestReview, teamName]
  );

  const handleApproveTask = useCallback(
    (taskId: string) => {
      void (async () => {
        try {
          await updateKanban(teamName, taskId, {
            op: 'set_column',
            column: 'approved',
          });
        } catch {
          // error via store
        }
      })();
    },
    [teamName, updateKanban]
  );

  const handleRequestChanges = useCallback((taskId: string) => {
    setRequestChangesTaskId(taskId);
  }, []);

  const handleMoveBackToDone = useCallback(
    (taskId: string) => {
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

  const handleStartTask = useCallback(
    (taskId: string) => {
      void (async () => {
        try {
          const result = await startTaskByUser(teamName, taskId);
          if (data?.isAlive) {
            const task = taskMapRef.current.get(taskId);
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
    },
    [data?.isAlive, startTaskByUser, teamName]
  );

  const handleCompleteTask = useCallback(
    (taskId: string) => {
      void (async () => {
        try {
          await updateTaskStatus(teamName, taskId, 'completed');
        } catch {
          // error via store
        }
      })();
    },
    [teamName, updateTaskStatus]
  );

  const handleCancelTask = useCallback(
    (taskId: string) => {
      void (async () => {
        try {
          const task = taskMapRef.current.get(taskId);
          await updateTaskStatus(teamName, taskId, 'pending');

          // Notify assignee directly via inbox - they'll see it immediately
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
              const ownerSuffix = task?.owner ? ` ${task.owner} has been notified to stop.` : '';
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
    },
    [data?.isAlive, teamName, updateTaskStatus]
  );

  const handleColumnOrderChange = useCallback(
    (columnId: KanbanColumnId, orderedTaskIds: string[]) => {
      void (async () => {
        try {
          await updateKanbanColumnOrder(teamName, columnId, orderedTaskIds);
        } catch {
          // error via store
        }
      })();
    },
    [teamName, updateKanbanColumnOrder]
  );

  const handleScrollToTask = useCallback((taskId: string) => {
    const el = document.querySelector(`[data-task-id="${taskId}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    el.classList.remove('kanban-card-focus-pulse');
    void (el as HTMLElement).offsetWidth;
    el.classList.add('kanban-card-focus-pulse');
    el.addEventListener('animationend', () => el.classList.remove('kanban-card-focus-pulse'), {
      once: true,
    });
  }, []);

  const handleAddTask = useCallback(
    (startImmediately: boolean) => {
      openCreateTaskDialog('', '', '', startImmediately);
    },
    [openCreateTaskDialog]
  );

  const handleOpenTrash = useCallback(() => {
    setTrashOpen(true);
  }, []);

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

  const messagesPanelTasks = useStableMessagesPanelTasks(data?.tasks);

  const sharedMessagesPanelProps = useMemo<SharedTeamMessagesPanelProps>(
    () => ({
      teamName,
      onPositionChange: changeMessagesPanelMode,
      mountPoint: messagesPanelMountPoint,
      members: activeMembers,
      tasks: messagesPanelTasks,
      isTeamAlive: data?.isAlive,
      timeWindow,
      currentLeadSessionId: data?.config.leadSessionId,
      onMemberClick: handleSelectMember,
      onTaskClick: handleOpenMessagePanelTask,
      onCreateTaskFromMessage: handleCreateTaskFromMessage,
      onReplyToMessage: handleReplyToMessage,
      onRestartTeam: handleRestartTeam,
      onTaskIdClick: handleTaskIdClick,
      onFloatingComposerHeightChange: handleFloatingComposerHeightChange,
      inlineScrollContainerRef: contentRef,
    }),
    [
      activeMembers,
      data?.config.leadSessionId,
      data?.isAlive,
      handleCreateTaskFromMessage,
      handleOpenMessagePanelTask,
      handleReplyToMessage,
      handleRestartTeam,
      handleSelectMember,
      handleTaskIdClick,
      handleFloatingComposerHeightChange,
      messagesPanelTasks,
      messagesPanelMountPoint,
      teamName,
      timeWindow,
      changeMessagesPanelMode,
    ]
  );

  const renderVisualizeButton = (pinned: boolean): React.JSX.Element => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-8 shrink-0 rounded-full border px-3.5 text-xs font-semibold tracking-[0.02em] transition-all',
            pinned ? 'pointer-events-auto fixed z-50' : 'pointer-events-auto',
            'hover:-translate-y-0.5 hover:brightness-[1.03] active:translate-y-0 active:brightness-[0.98]',
            isLight
              ? 'hover:border-sky-400/50'
              : 'hover:border-cyan-300/50 hover:shadow-[0_14px_32px_rgba(8,145,178,0.28)]'
          )}
          style={
            pinned && pinnedVisualizeButtonPosition
              ? {
                  ...visualizeButtonStyle,
                  right: pinnedVisualizeButtonPosition.right,
                  top: pinnedVisualizeButtonPosition.top,
                }
              : visualizeButtonStyle
          }
          onClick={handleOpenGraphTab}
        >
          <Network size={13} className="shrink-0" />
          {t('detail.actions.visualize')}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{t('detail.tooltips.openTeamGraph')}</TooltipContent>
    </Tooltip>
  );

  if (!teamName) {
    return (
      <div className="flex size-full items-center justify-center p-6 text-sm text-red-400">
        {t('detail.invalidTab')}
      </div>
    );
  }

  const spawnStatusWatcher = (
    <TeamSpawnStatusWatcher
      teamName={teamName}
      isTeamProvisioning={isTeamProvisioning}
      isTeamAlive={data?.isAlive}
      isThisTabActive={isThisTabActive}
    />
  );
  const teamAgentRuntimeWatcher = (
    <TeamAgentRuntimeWatcher
      teamName={teamName}
      isTeamProvisioning={isTeamProvisioning}
      isTeamAlive={data?.isAlive}
      isThisTabActive={isThisTabActive}
    />
  );
  const renderBody = (): React.JSX.Element => {
    if ((loading && !data) || (data && data.teamName !== teamName)) {
      return (
        <TeamLoadingSkeleton
          teamName={teamName}
          isActive={isThisTabActive}
          isFocused={isPaneFocused}
          messagesPanelMode={messagesPanelMode}
          headerColorSet={loadingHeaderColorSet}
          isLight={isLight}
          contentRef={contentRef}
          provisioningBannerRef={provisioningBannerRef}
        />
      );
    }

    if (error === 'TEAM_DRAFT') {
      const draftTeamSummary = useStore.getState().teamByName[teamName];
      const draftDisplayName = draftTeamSummary?.displayName || teamName;
      const draftMemberCount = draftTeamSummary?.memberCount ?? 0;

      return (
        <>
          <div className="size-full overflow-auto p-6">
            <div ref={provisioningBannerRef}>
              <TeamProvisioningBanner teamName={teamName} />
            </div>
            <div className="flex min-h-[calc(100vh-12rem)] items-center justify-center">
              <div className="max-w-md text-center">
                <p className="text-sm font-medium text-text">{t('detail.draft.title')}</p>
                <p className="mt-2 text-xs text-text-secondary">
                  {t('detail.draft.descriptionPrefix')} <strong>{draftDisplayName}</strong>{' '}
                  {t('detail.draft.descriptionSuffix', {
                    count: draftMemberCount,
                    member: t('detail.draft.member', { count: draftMemberCount }),
                  })}
                </p>
                <div className="mt-4 flex justify-center gap-2">
                  <button
                    className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500"
                    onClick={() => openLaunchDialog('launch')}
                  >
                    {t('detail.actions.launch')}
                  </button>
                  <button
                    className="rounded-md bg-surface-raised px-4 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:text-text"
                    onClick={() => {
                      void api.teams.deleteDraft(teamName).catch(() => {});
                    }}
                  >
                    {t('detail.actions.delete')}
                  </button>
                </div>
              </div>
            </div>
          </div>
          {launchDialogOpen && (
            <Suspense
              fallback={
                <LaunchTeamDialogLoadingFallback
                  mode={launchDialogState.mode}
                  teamName={teamName}
                  onClose={closeLaunchDialog}
                />
              }
            >
              <LaunchTeamDialog
                mode={launchDialogState.mode}
                open={launchDialogOpen}
                teamName={teamName}
                members={[]}
                defaultProjectPath={draftTeamSummary?.projectPath}
                provisioningError={provisioningError}
                clearProvisioningError={clearProvisioningError}
                onClose={closeLaunchDialog}
                onLaunch={handleLaunchDialogSubmit}
                onRelaunch={handleRelaunchDialogSubmit}
              />
            </Suspense>
          )}
        </>
      );
    }

    if (error) {
      return (
        <div className="flex size-full items-center justify-center p-6">
          <div className="text-center">
            <p className="text-sm font-medium text-red-400">{t('detail.loadFailed')}</p>
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
            {t('detail.waitingForProvisioning')}
          </div>
        </div>
      );
    }

    const headerColorSet = data.config.color
      ? getTeamColorSet(data.config.color)
      : nameColorSet(data.config.name);
    const shouldReserveFloatingComposerScrollSpace =
      messagesPanelMode === 'floating-composer' && isThisTabActive && isPaneFocused && !graphOpen;
    const floatingComposerScrollReserve = shouldReserveFloatingComposerScrollSpace
      ? FLOATING_COMPOSER_SCROLL_RESERVE_BASE_PX + floatingComposerHeight
      : undefined;

    return (
      <>
        {pinnedVisualizeButtonPosition ? renderVisualizeButton(true) : null}
        <div className="relative flex size-full overflow-hidden">
          <LeadLoadBridge
            teamName={teamName}
            tabId={tabId}
            projectId={projectId}
            leadSessionId={leadSessionId}
            leadProviderId={leadProviderId}
            fallbackProjectRoot={data.config.projectPath}
            isThisTabActive={isThisTabActive}
          />

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
              <TeamSidebarRailBridge
                teamName={teamName}
                messagesPanelProps={sharedMessagesPanelProps}
                isResizing={isMessagesPanelResizing}
                onResizeMouseDown={messagesPanelHandleProps.onMouseDown}
                logsHeight={sidebarLogsHeight}
                isLogsResizing={isLogsPanelResizing}
                onLogsResizeMouseDown={logsPanelHandleProps.onMouseDown}
              />
            </TeamSidebarPortalSource>
          </TeamSidebarHost>

          <div className="relative min-h-0 min-w-0 flex-1">
            <div
              ref={contentRef}
              className="size-full min-w-0 overflow-y-auto overflow-x-hidden p-4"
              style={{ paddingBottom: floatingComposerScrollReserve }}
              data-team-name={teamName}
            >
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
                          {t('detail.status.running')}
                        </span>
                      )}
                      {!data.isAlive && isTeamProvisioning && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-yellow-500/15 px-1.5 py-0.5 text-[10px] font-medium text-yellow-400">
                          <span className="size-1.5 animate-pulse rounded-full bg-yellow-400" />
                          {t('detail.status.launching')}
                        </span>
                      )}
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
                            {t('detail.actions.stop')}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">
                          {t('detail.tooltips.stopTeam')}
                        </TooltipContent>
                      </Tooltip>
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1 px-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                          disabled={isTeamProvisioning}
                          onClick={() => setEditDialogOpen(true)}
                        >
                          <Pencil size={12} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        {isTeamProvisioning
                          ? t('detail.tooltips.editUnavailableProvisioning')
                          : t('detail.tooltips.editTeam')}
                      </TooltipContent>
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
                      <TooltipContent side="bottom">
                        {t('detail.tooltips.deleteTeam')}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
                <div
                  className={cn(
                    'mt-1 flex items-start justify-between gap-3',
                    headerColorSet && 'relative z-10'
                  )}
                >
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5">
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
                              <Code size={10} className="shrink-0" /> {t('detail.actions.editCode')}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>{t('detail.tooltips.openBuiltInEditor')}</TooltipContent>
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
                  <div ref={visualizeButtonAnchorRef} className="-mt-2 h-8 shrink-0 self-start">
                    {pinnedVisualizeButtonPosition ? null : renderVisualizeButton(false)}
                  </div>
                </div>
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
                        {t('detail.previous', {
                          paths: history.map((p) => formatProjectPath(p)).join(', '),
                        })}
                      </span>
                    </div>
                  );
                })()}
              </div>

              {!data.isAlive && !isTeamProvisioning ? (
                <TeamOfflineStatusBanner
                  teamName={teamName}
                  onLaunch={() => openLaunchDialog('launch')}
                />
              ) : null}

              <div ref={provisioningBannerRef}>
                <TeamProvisioningBanner teamName={teamName} />
              </div>

              {data.warnings?.some((warning) => warning.toLowerCase().includes('kanban')) ? (
                <div className="mb-3 rounded-md border border-[var(--step-warning-border)] bg-[var(--step-warning-bg)] px-3 py-2 text-xs text-[var(--step-warning-text)]">
                  {t('detail.kanbanSafeData')}
                </div>
              ) : null}
              {reviewActionError ? (
                <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-[var(--step-error-text)]">
                  {reviewActionError}
                </div>
              ) : null}

              <div className="runtime-telemetry-hover-scope">
                <CollapsibleTeamSection
                  sectionId="team"
                  title={t('detail.sections.team')}
                  icon={<Users size={14} />}
                  badge={activeTeammateCount === 0 ? t('detail.solo') : activeTeammateCount}
                  defaultOpen
                  afterBadge={
                    <Button
                      variant="ghost"
                      size="sm"
                      className="pointer-events-auto h-6 gap-1 px-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                      onClick={(e) => {
                        e.stopPropagation();
                        setAddMemberDialogOpen(true);
                      }}
                    >
                      <UserPlus size={12} />
                      {t('detail.actions.add')}
                    </Button>
                  }
                  action={
                    <div className="runtime-telemetry-legend flex items-center gap-3 pr-3 text-[11px] font-medium leading-none text-[var(--color-text-muted)] opacity-0 transition-opacity duration-150">
                      <span className="flex items-center gap-1.5">
                        <span className="size-2 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(34,197,94,0.3)]" />
                        {t('detail.telemetry.memory')}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="size-2 rounded-full bg-blue-500 shadow-[0_0_6px_rgba(59,130,246,0.3)]" />
                        {t('detail.telemetry.cpu')}
                      </span>
                    </div>
                  }
                  contentWrapperClassName="-mx-[calc(1rem-5px)] w-[calc(100%+2rem-10px)]"
                >
                  <div className="px-[calc(1rem-5px)]">
                    <TeamMemberListBridge
                      teamName={teamName}
                      members={membersWithLiveBranches}
                      expectedTeammateCount={activeTeammateCount}
                      memberTaskCounts={memberTaskCounts}
                      taskMap={taskMap}
                      isRosterLoading={loading}
                      isTeamAlive={data.isAlive}
                      isTeamProvisioning={isTeamProvisioning}
                      launchParams={launchParams}
                      onMemberClick={handleSelectMember}
                      onSendMessage={handleSendMessageToMember}
                      onAssignTask={handleAssignTaskToMember}
                      onOpenTask={handleOpenTaskById}
                      onRestartMember={handleRestartMember}
                      onSkipMemberForLaunch={handleSkipMemberForLaunch}
                      onRestoreMember={handleRestoreMember}
                    />
                  </div>
                </CollapsibleTeamSection>
              </div>

              <CollapsibleTeamSection
                sectionId="sessions"
                title={t('sessions.title')}
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
                title={t('kanban.title')}
                icon={<Columns3 size={14} />}
                badge={filteredTasks.length}
                defaultOpen
                forceOpen={isKanbanSearchActive}
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
                    {t('detail.actions.task')}
                  </Button>
                }
              >
                <TeamKanbanBoardBridge
                  tasks={kanbanDisplayTasks}
                  teamName={teamName}
                  kanbanState={data.kanbanState}
                  filter={kanbanFilter}
                  sort={kanbanSort}
                  sessions={teamSessions}
                  leadSessionId={data.config.leadSessionId}
                  members={activeMembers}
                  forceShowAllTasks={isKanbanSearchActive}
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
                  onRequestReview={handleRequestReview}
                  onApprove={handleApproveTask}
                  onRequestChanges={handleRequestChanges}
                  onMoveBackToDone={handleMoveBackToDone}
                  onStartTask={handleStartTask}
                  onCompleteTask={handleCompleteTask}
                  onCancelTask={handleCancelTask}
                  onColumnOrderChange={handleColumnOrderChange}
                  onScrollToTask={handleScrollToTask}
                  onTaskClick={openTaskDetailDialog}
                  onViewChanges={handleViewChanges}
                  onAddTask={handleAddTask}
                  onDeleteTask={handleDeleteTask}
                  deletedTaskCount={deletedTasks.length}
                  onOpenTrash={handleOpenTrash}
                />
              </CollapsibleTeamSection>

              <TeamChangesSection
                teamName={teamName}
                tasks={data.tasks}
                memberColorMap={resolvedMemberColorMap}
                onOpenTask={openTaskDetailDialog}
                onViewChanges={handleViewChangesForFile}
              />

              <CollapsibleTeamSection
                sectionId="schedules"
                title={t('schedule.title')}
                icon={<Clock size={14} />}
                defaultOpen={false}
              >
                <ScheduleSection teamName={teamName} />
              </CollapsibleTeamSection>

              <LiveRuntimeStatusBridge teamName={teamName} members={membersWithLiveBranches} />

              {(data.processes?.length ?? 0) > 0 && (
                <CollapsibleTeamSection
                  sectionId="processes"
                  title={t('processes.title')}
                  icon={<Terminal size={14} />}
                  badge={data.processes.filter((p) => !p.stoppedAt).length}
                  headerExtra={
                    data.processes.some((p) => !p.stoppedAt) ? (
                      <span
                        className="pointer-events-none relative inline-flex size-2 shrink-0"
                        title={t('detail.status.active')}
                      >
                        <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" />
                        <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
                      </span>
                    ) : null
                  }
                  defaultOpen
                >
                  <ProcessesSection
                    teamName={teamName}
                    members={membersWithLiveBranches}
                    processes={data.processes}
                  />
                </CollapsibleTeamSection>
              )}

              {messagesPanelMode !== 'sidebar' && <ClaudeLogsSection teamName={teamName} />}

              {messagesPanelMode === 'inline' && (
                <TeamMessagesPanelBridge position="inline" {...sharedMessagesPanelProps} />
              )}

              {requestChangesTaskId !== null && (
                <ReviewDialog
                  open={true}
                  teamName={teamName}
                  taskId={requestChangesTaskId}
                  members={members}
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
              )}

              <TeamMemberDetailDialogBridge
                open={selectedMember !== null}
                member={selectedMember}
                teamName={teamName}
                members={membersWithLiveBranches}
                tasks={data.tasks}
                initialTab={selectedMemberView?.initialTab}
                initialActivityFilter={selectedMemberView?.initialActivityFilter}
                isTeamAlive={data.isAlive}
                isTeamProvisioning={isTeamProvisioning}
                launchParams={launchParams}
                onClose={closeSelectedMemberDialog}
                onSendMessage={() => {
                  const name = selectedMember?.name ?? '';
                  closeSelectedMemberDialog();
                  setSendDialogRecipient(name || undefined);
                  setSendDialogDefaultText(undefined);
                  setSendDialogDefaultChip(undefined);
                  setReplyQuote(undefined);
                  setSendDialogOpen(true);
                }}
                onAssignTask={() => {
                  const name = selectedMember?.name ?? '';
                  closeSelectedMemberDialog();
                  openCreateTaskDialog('', '', name);
                }}
                onRestartMember={handleRestartMember}
                onTaskClick={(task) => {
                  closeSelectedMemberDialog();
                  openTaskDetailDialog(task);
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
                  closeSelectedMemberDialog();
                  setReviewDialogState({
                    open: true,
                    mode: 'agent',
                    memberName,
                    initialFilePath: filePath,
                  });
                }}
              />

              {createTaskDialog.open && (
                <Suspense fallback={null}>
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
                </Suspense>
              )}

              {editDialogOpen && (
                <EditTeamDialog
                  open={editDialogOpen}
                  teamName={teamName}
                  currentName={data.config.name}
                  currentDescription={data.config.description ?? ''}
                  currentColor={data.config.color ?? ''}
                  currentMembers={membersWithLiveBranches.filter((m) => !isLeadMember(m))}
                  leadMember={membersWithLiveBranches.find((m) => isLeadMember(m)) ?? null}
                  resolvedMemberColorMap={resolvedMemberColorMap}
                  isTeamAlive={data.isAlive && !isTeamProvisioning}
                  isTeamProvisioning={isTeamProvisioning}
                  projectPath={data.config.projectPath}
                  onClose={() => setEditDialogOpen(false)}
                  onChangeLeadRuntime={handleChangeLeadRuntime}
                  onSaved={() => void selectTeam(teamName)}
                />
              )}

              {addMemberDialogOpen && (
                <AddMemberDialog
                  open={addMemberDialogOpen}
                  teamName={teamName}
                  existingNames={membersWithLiveBranches.map((m) => m.name)}
                  existingMembers={membersWithLiveBranches}
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
                            isolation: entry.isolation,
                            providerId: entry.providerId,
                            providerBackendId: entry.providerBackendId,
                            model: entry.model,
                            effort: entry.effort,
                            fastMode: entry.fastMode,
                            mcpPolicy: entry.mcpPolicy,
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
              )}

              {removeMemberConfirm !== null && (
                <Dialog
                  open={true}
                  onOpenChange={(open) => {
                    if (!open) setRemoveMemberConfirm(null);
                  }}
                >
                  <DialogContent className="max-w-sm">
                    <DialogHeader>
                      <DialogTitle>{t('detail.removeMember.title')}</DialogTitle>
                      <DialogDescription>
                        {t('detail.removeMember.description', { member: removeMemberConfirm })}
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setRemoveMemberConfirm(null)}
                      >
                        {t('detail.actions.cancel')}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                          const name = removeMemberConfirm;
                          setRemoveMemberConfirm(null);
                          closeSelectedMemberDialog();
                          if (name) void removeMember(teamName, name);
                        }}
                      >
                        {t('detail.actions.remove')}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              )}

              {deleteConfirmOpen && (
                <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
                  <DialogContent className="max-w-sm">
                    <DialogHeader>
                      <DialogTitle>{t('detail.deleteTeam.title')}</DialogTitle>
                      <DialogDescription>
                        {t('detail.deleteTeam.description', { team: data.config.name })}
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteConfirmOpen(false)}>
                        {t('detail.actions.cancel')}
                      </Button>
                      <Button variant="destructive" size="sm" onClick={confirmDeleteTeam}>
                        {t('detail.actions.delete')}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              )}

              {launchDialogOpen && (
                <Suspense
                  fallback={
                    <LaunchTeamDialogLoadingFallback
                      mode={launchDialogState.mode}
                      teamName={teamName}
                      onClose={closeLaunchDialog}
                    />
                  }
                >
                  <LaunchTeamDialog
                    mode={launchDialogState.mode}
                    open={launchDialogOpen}
                    teamName={teamName}
                    members={membersWithLiveBranches}
                    defaultProjectPath={data.config.projectPath}
                    provisioningError={provisioningError}
                    clearProvisioningError={clearProvisioningError}
                    activeTeams={activeTeamsForLaunch}
                    onClose={closeLaunchDialog}
                    onLaunch={handleLaunchDialogSubmit}
                    onRelaunch={handleRelaunchDialogSubmit}
                  />
                </Suspense>
              )}

              {sendDialogOpen && (
                <Suspense fallback={null}>
                  <SendMessageDialogBridge
                    open={sendDialogOpen}
                    teamName={teamName}
                    members={activeMembers}
                    defaultRecipient={sendDialogRecipient}
                    defaultText={sendDialogDefaultText}
                    defaultChip={sendDialogDefaultChip}
                    quotedMessage={replyQuote}
                    isTeamAlive={data.isAlive}
                    onClose={() => {
                      setSendDialogOpen(false);
                      setReplyQuote(undefined);
                      setSendDialogDefaultText(undefined);
                      setSendDialogDefaultChip(undefined);
                    }}
                  />
                </Suspense>
              )}

              <TaskDetailDialogHost
                ref={taskDetailDialogRef}
                teamName={teamName}
                kanbanTaskStateByTaskId={data.kanbanState.tasks}
                taskMap={taskMap}
                members={activeMembers}
                onOwnerChange={handleTaskOwnerChange}
                onViewChanges={handleViewChangesForFile}
                onOpenInEditor={handleOpenTaskFileInEditor}
                onDeleteTask={handleDeleteTask}
              />

              {trashOpen && (
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
              )}

              {reviewDialogState.open && (
                <Suspense fallback={null}>
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
                </Suspense>
              )}
            </div>
            <div
              ref={setMessagesPanelMountPoint}
              className="pointer-events-none absolute inset-0 z-30"
            />
            {messagesPanelMode === 'bottom-sheet' && !graphOpen && (
              <TeamMessagesPanelBridge position="bottom-sheet" {...sharedMessagesPanelProps} />
            )}
            {messagesPanelMode === 'floating-composer' &&
              isThisTabActive &&
              isPaneFocused &&
              !graphOpen && (
                <TeamMessagesPanelBridge
                  position="floating-composer"
                  {...sharedMessagesPanelProps}
                />
              )}
            <TerminalWorkspaceFloatingLauncher
              teamName={teamName}
              bottomOffset={Math.max(floatingComposerHeight + 18, 18)}
              buttonTestId="open-terminal-floating-button"
              enabled={isThisTabActive && !graphOpen}
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
              messagesPanelEnabled={
                (messagesPanelMode === 'floating-composer' ||
                  messagesPanelMode === 'bottom-sheet') &&
                isThisTabActive &&
                isPaneFocused
              }
            />
          </Suspense>
        )}
      </>
    );
  };

  return (
    <>
      {spawnStatusWatcher}
      {teamAgentRuntimeWatcher}
      {renderBody()}
    </>
  );
});
