import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api, isElectronMode } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useCollapsedGroups } from '@renderer/hooks/useCollapsedGroups';
import { useTaskLocalState } from '@renderer/hooks/useTaskLocalState';
import { cn } from '@renderer/lib/utils';
import { markTaskUnread } from '@renderer/services/commentReadStorage';
import { useStore } from '@renderer/store';
import { getCurrentProvisioningProgressForTeam } from '@renderer/store/slices/teamSlice';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { normalizePath } from '@renderer/utils/pathNormalize';
import { projectColor } from '@renderer/utils/projectColor';
import {
  getNonEmptyTaskCategories,
  groupTasksByDate,
  groupTasksByProject,
  NO_PROJECT_KEY,
  sortTasksByFreshness,
} from '@renderer/utils/taskGrouping';
import { isTeamListStatusRunning, resolveTeamStatus } from '@renderer/utils/teamListStatus';
import { deriveTaskDisplayId } from '@shared/utils/taskIdentity';
import {
  Archive,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  ListTodo,
  Pin,
  Search,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { AnimatedHeightReveal } from '../team/activity/AnimatedHeightReveal';
import { type ComboboxOption } from '../ui/combobox';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

import {
  canProjectGroupShowLess,
  canProjectGroupShowMore,
  getNextProjectGroupVisibleCount,
  getPreviousProjectGroupVisibleCount,
  getProjectGroupVisibleCount,
  syncProjectGroupVisibleCountByKey,
} from './projectGroupPagination';
import { SidebarTaskItem } from './SidebarTaskItem';
import { TaskContextMenu } from './TaskContextMenu';
import { TaskFiltersPopover } from './TaskFiltersPopover';
import {
  defaultTaskFiltersState,
  getTaskUnreadCount,
  taskMatchesStatus,
  useReadStateSnapshot,
} from './taskFiltersState';

import type { TaskFiltersState } from './taskFiltersState';
import type { GlobalTask, TeamSummary } from '@shared/types';

const TASK_GROUPING_STORAGE_KEY = 'sidebarTasksGrouping';

export type TaskGroupingMode = 'none' | 'project' | 'time';

function loadGroupingMode(): TaskGroupingMode {
  try {
    const v = localStorage.getItem(TASK_GROUPING_STORAGE_KEY);
    if (v === 'none' || v === 'project' || v === 'time') return v;
  } catch {
    /* ignore */
  }
  return 'project';
}

function saveGroupingMode(mode: TaskGroupingMode): void {
  try {
    localStorage.setItem(TASK_GROUPING_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
}

export type TaskSortMode = 'time' | 'project' | 'team' | 'unread';

const TASK_SORT_STORAGE_KEY = 'sidebarTasksSort';

const SORT_OPTIONS = [
  { id: 'time', labelKey: 'tasksPanel.sort.byTime' },
  { id: 'unread', labelKey: 'tasksPanel.sort.byUnread' },
  { id: 'project', labelKey: 'tasksPanel.sort.byProject' },
  { id: 'team', labelKey: 'tasksPanel.sort.byTeam' },
] as const satisfies readonly { id: TaskSortMode; labelKey: string }[];

function loadSortMode(): TaskSortMode {
  try {
    const v = localStorage.getItem(TASK_SORT_STORAGE_KEY);
    if (v === 'time' || v === 'project' || v === 'team' || v === 'unread') return v;
  } catch {
    /* ignore */
  }
  return 'time';
}

function saveSortMode(mode: TaskSortMode): void {
  try {
    localStorage.setItem(TASK_SORT_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
}

function applySortMode(
  tasks: GlobalTask[],
  mode: TaskSortMode,
  readState?: ReturnType<typeof useReadStateSnapshot>
): GlobalTask[] {
  const sorted = [...tasks];
  switch (mode) {
    case 'time':
      return sortTasksByFreshness(sorted);
    case 'unread':
      return sorted.sort((a, b) => {
        const ua = readState ? getTaskUnreadCount(readState, a.teamName, a.id, a.comments) : 0;
        const ub = readState ? getTaskUnreadCount(readState, b.teamName, b.id, b.comments) : 0;
        if (ub !== ua) return ub - ua;
        return (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? '');
      });
    case 'project':
      return sorted.sort((a, b) => {
        const pa = a.projectPath ?? '';
        const pb = b.projectPath ?? '';
        const cmp = pa.localeCompare(pb);
        if (cmp !== 0) return cmp;
        return (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? '');
      });
    case 'team':
      return sorted.sort((a, b) => {
        const cmp = a.teamDisplayName.localeCompare(b.teamDisplayName);
        if (cmp !== 0) return cmp;
        return (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? '');
      });
    default:
      return sortTasksByFreshness(sorted);
  }
}

export interface GlobalTaskListProps {
  /** When true, do not render the header row (Tasks + Filters); parent renders tabs and filters. */
  hideHeader?: boolean;
  /** External filters state when used with sidebar tabs. */
  filters?: TaskFiltersState;
  onFiltersChange?: (f: TaskFiltersState) => void;
  filtersPopoverOpen?: boolean;
  onFiltersPopoverOpenChange?: (open: boolean) => void;
}

const dateCategoryLabels: Record<string, string> = {
  'Previous 7 Days': 'Last 7 Days',
  Older: 'Earlier',
};

type ProjectTaskGroupData = ReturnType<typeof groupTasksByProject>[number];

function applySearch(tasks: GlobalTask[], query: string): GlobalTask[] {
  if (!query.trim()) return tasks;
  const q = query.toLowerCase();
  return tasks.filter(
    (t) =>
      t.subject.toLowerCase().includes(q) ||
      t.owner?.toLowerCase().includes(q) ||
      t.teamDisplayName.toLowerCase().includes(q)
  );
}

function applyProjectFilter(tasks: GlobalTask[], projectPath: string | null): GlobalTask[] {
  if (!projectPath) return tasks;
  const normalized = normalizePath(projectPath);
  return tasks.filter((t) => t.projectPath && normalizePath(t.projectPath) === normalized);
}

function buildTaskTeamSummary(task: GlobalTask): TeamSummary {
  return {
    teamName: task.teamName,
    displayName: task.teamDisplayName,
    description: '',
    memberCount: 0,
    taskCount: 0,
    lastActivity: task.updatedAt ?? task.createdAt ?? null,
    projectPath: task.projectPath,
  };
}

type TaskRowAction = (teamName: string, taskId: string) => void;
type TaskRowDeleteAction = (teamName: string, taskId: string) => void | Promise<void>;
type TaskDisplaySubjectResolver = (task: GlobalTask) => string | undefined;
type TaskBooleanResolver = (teamName: string, taskId: string) => boolean;
type TeamBooleanResolver = (teamName: string) => boolean;
type TaskOwnerColorResolver = (task: GlobalTask) => string | null | undefined;
type TeamHeaderFormatter = (teamDisplayName: string) => string;
type ProjectGroupVisibleCountChange = (projectKey: string, visibleCount: number) => void;

interface GlobalTaskRowProps {
  task: GlobalTask;
  isPinned: boolean;
  isArchived: boolean;
  isNew: boolean;
  teamOffline: boolean;
  renamingKey: string | null;
  hideTeamName?: boolean;
  hideProjectName?: boolean;
  showTeamName?: boolean;
  onTogglePin: TaskRowAction;
  onToggleArchive: TaskRowAction;
  onMarkUnread: TaskRowAction;
  onRename: TaskRowAction;
  onDelete: TaskRowDeleteAction;
  onRenameComplete: (teamName: string, taskId: string, newSubject: string) => void;
  onRenameCancel: () => void;
  getDisplaySubject: TaskDisplaySubjectResolver;
  ownerColorName?: string | null;
}

const GlobalTaskRow = memo(function GlobalTaskRow({
  task,
  isPinned,
  isArchived,
  isNew,
  teamOffline,
  renamingKey,
  hideTeamName,
  hideProjectName,
  showTeamName,
  onTogglePin,
  onToggleArchive,
  onMarkUnread,
  onRename,
  onDelete,
  onRenameComplete,
  onRenameCancel,
  getDisplaySubject,
  ownerColorName,
}: GlobalTaskRowProps): React.JSX.Element {
  const taskRenamingKey = `${task.teamName}:${task.id}`;
  const effectiveRenamingKey = renamingKey === taskRenamingKey ? renamingKey : null;

  const handleTogglePin = useCallback(() => {
    onTogglePin(task.teamName, task.id);
  }, [onTogglePin, task.id, task.teamName]);

  const handleToggleArchive = useCallback(() => {
    onToggleArchive(task.teamName, task.id);
  }, [onToggleArchive, task.id, task.teamName]);

  const handleMarkUnread = useCallback(() => {
    onMarkUnread(task.teamName, task.id);
  }, [onMarkUnread, task.id, task.teamName]);

  const handleRename = useCallback(() => {
    onRename(task.teamName, task.id);
  }, [onRename, task.id, task.teamName]);

  const handleDelete = useCallback(() => {
    void onDelete(task.teamName, task.id);
  }, [onDelete, task.id, task.teamName]);

  return (
    <TaskContextMenu
      task={task}
      isPinned={isPinned}
      isArchived={isArchived}
      onTogglePin={handleTogglePin}
      onToggleArchive={handleToggleArchive}
      onMarkUnread={handleMarkUnread}
      onRename={handleRename}
      onDelete={handleDelete}
    >
      <AnimatedHeightReveal animate={isNew}>
        <SidebarTaskItem
          task={task}
          hideTeamName={hideTeamName}
          hideProjectName={hideProjectName}
          showTeamName={showTeamName}
          teamOffline={teamOffline}
          renamingKey={effectiveRenamingKey}
          onRenameComplete={onRenameComplete}
          onRenameCancel={onRenameCancel}
          getDisplaySubject={getDisplaySubject}
          ownerColorName={ownerColorName}
        />
      </AnimatedHeightReveal>
    </TaskContextMenu>
  );
});

interface TaskRowsProps {
  tasks: GlobalTask[];
  visibleCount?: number;
  keyPrefix?: string;
  isPinned: TaskBooleanResolver;
  isArchived: TaskBooleanResolver;
  isNewTask: (task: GlobalTask) => boolean;
  isTeamOffline: TeamBooleanResolver;
  renamingKey: string | null;
  hideTeamName?: boolean;
  hideProjectName?: boolean;
  showTeamName?: boolean;
  showTeamHeader?: boolean;
  pinnedOverride?: boolean;
  archivedOverride?: boolean;
  formatTeamHeader?: TeamHeaderFormatter;
  onTogglePin: TaskRowAction;
  onToggleArchive: TaskRowAction;
  onMarkUnread: TaskRowAction;
  onRename: TaskRowAction;
  onDelete: TaskRowDeleteAction;
  onRenameComplete: (teamName: string, taskId: string, newSubject: string) => void;
  onRenameCancel: () => void;
  getDisplaySubject: TaskDisplaySubjectResolver;
  getOwnerColorName: TaskOwnerColorResolver;
}

const TaskRows = memo(function TaskRows({
  tasks,
  visibleCount,
  keyPrefix = '',
  isPinned,
  isArchived,
  isNewTask,
  isTeamOffline,
  renamingKey,
  hideTeamName,
  hideProjectName,
  showTeamName,
  showTeamHeader,
  pinnedOverride,
  archivedOverride,
  formatTeamHeader,
  onTogglePin,
  onToggleArchive,
  onMarkUnread,
  onRename,
  onDelete,
  onRenameComplete,
  onRenameCancel,
  getDisplaySubject,
  getOwnerColorName,
}: TaskRowsProps): React.JSX.Element {
  let lastTeam: string | null = null;
  const visibleTasks = typeof visibleCount === 'number' ? tasks.slice(0, visibleCount) : tasks;

  return (
    <>
      {visibleTasks.map((task) => {
        const taskKey = `${keyPrefix}${task.teamName}-${task.id}`;
        const row = (
          <GlobalTaskRow
            key={taskKey}
            task={task}
            isPinned={pinnedOverride ?? isPinned(task.teamName, task.id)}
            isArchived={archivedOverride ?? isArchived(task.teamName, task.id)}
            isNew={isNewTask(task)}
            hideTeamName={hideTeamName}
            hideProjectName={hideProjectName}
            showTeamName={showTeamName}
            teamOffline={isTeamOffline(task.teamName)}
            ownerColorName={getOwnerColorName(task)}
            renamingKey={renamingKey}
            onTogglePin={onTogglePin}
            onToggleArchive={onToggleArchive}
            onMarkUnread={onMarkUnread}
            onRename={onRename}
            onDelete={onDelete}
            onRenameComplete={onRenameComplete}
            onRenameCancel={onRenameCancel}
            getDisplaySubject={getDisplaySubject}
          />
        );

        if (!showTeamHeader || !formatTeamHeader) {
          return row;
        }

        const shouldShowTeamHeader = task.teamName !== lastTeam;
        lastTeam = task.teamName;

        return (
          <div key={taskKey}>
            {shouldShowTeamHeader && (
              <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-medium text-text-muted">
                {formatTeamHeader(task.teamDisplayName)}
              </div>
            )}
            {row}
          </div>
        );
      })}
    </>
  );
});

interface ProjectTaskGroupProps {
  group: ProjectTaskGroupData;
  isCollapsed: boolean;
  visibleCount: number;
  noProjectGroupColor: ReturnType<typeof projectColor>;
  showMoreLabel: string;
  showLessLabel: string;
  isPinned: TaskBooleanResolver;
  isArchived: TaskBooleanResolver;
  isNewTask: (task: GlobalTask) => boolean;
  isTeamOffline: TeamBooleanResolver;
  renamingKey: string | null;
  formatTeamHeader: TeamHeaderFormatter;
  onToggleGroup: (projectKey: string) => void;
  onVisibleCountChange: ProjectGroupVisibleCountChange;
  onTogglePin: TaskRowAction;
  onToggleArchive: TaskRowAction;
  onMarkUnread: TaskRowAction;
  onRename: TaskRowAction;
  onDelete: TaskRowDeleteAction;
  onRenameComplete: (teamName: string, taskId: string, newSubject: string) => void;
  onRenameCancel: () => void;
  getDisplaySubject: TaskDisplaySubjectResolver;
  getOwnerColorName: TaskOwnerColorResolver;
}

const ProjectTaskGroup = memo(function ProjectTaskGroup({
  group,
  isCollapsed,
  visibleCount,
  noProjectGroupColor,
  showMoreLabel,
  showLessLabel,
  isPinned,
  isArchived,
  isNewTask,
  isTeamOffline,
  renamingKey,
  formatTeamHeader,
  onToggleGroup,
  onVisibleCountChange,
  onTogglePin,
  onToggleArchive,
  onMarkUnread,
  onRename,
  onDelete,
  onRenameComplete,
  onRenameCancel,
  getDisplaySubject,
  getOwnerColorName,
}: ProjectTaskGroupProps): React.JSX.Element | null {
  if (group.tasks.length === 0) return null;

  const isNoProjectGroup = group.projectKey === NO_PROJECT_KEY;
  const groupColor = isNoProjectGroup ? noProjectGroupColor : projectColor(group.projectLabel);
  const showMoreVisible = canProjectGroupShowMore(visibleCount, group.tasks.length);
  const showLessVisible = canProjectGroupShowLess(visibleCount, group.tasks.length);

  return (
    <div>
      <button
        type="button"
        onClick={() => onToggleGroup(group.projectKey)}
        className="hover:bg-surface-raised/40 sticky top-0 z-10 flex w-full cursor-pointer items-center gap-1.5 p-2 transition-colors"
        style={{
          backgroundColor: 'var(--color-surface-sidebar)',
          backgroundImage: isNoProjectGroup
            ? undefined
            : `linear-gradient(90deg, ${groupColor.glow} 0%, transparent 80%)`,
          boxShadow: `inset 2px 0 0 ${groupColor.border}, inset 0 -1px 0 var(--color-border)`,
        }}
      >
        {isCollapsed ? (
          <ChevronRight className="size-3 shrink-0 text-text-muted" />
        ) : (
          <ChevronDown className="size-3 shrink-0 text-text-muted" />
        )}
        <Folder
          className="size-3.5 shrink-0"
          style={{ color: groupColor.icon }}
          aria-hidden="true"
        />
        <span
          className="truncate text-[11px] font-bold leading-none"
          style={{ color: groupColor.icon }}
        >
          {group.projectLabel}
        </span>
        <span className="ml-auto shrink-0 text-[10px] font-normal text-text-muted">
          {group.tasks.length}
        </span>
      </button>
      {!isCollapsed && (
        <TaskRows
          tasks={group.tasks}
          visibleCount={visibleCount}
          isPinned={isPinned}
          isArchived={isArchived}
          isNewTask={isNewTask}
          isTeamOffline={isTeamOffline}
          hideTeamName
          hideProjectName
          showTeamHeader
          formatTeamHeader={formatTeamHeader}
          renamingKey={renamingKey}
          onTogglePin={onTogglePin}
          onToggleArchive={onToggleArchive}
          onMarkUnread={onMarkUnread}
          onRename={onRename}
          onDelete={onDelete}
          onRenameComplete={onRenameComplete}
          onRenameCancel={onRenameCancel}
          getDisplaySubject={getDisplaySubject}
          getOwnerColorName={getOwnerColorName}
        />
      )}
      {!isCollapsed && (showMoreVisible || showLessVisible) && (
        <div className="flex items-center gap-2 px-3 pb-2 pt-1">
          {showMoreVisible && (
            <button
              type="button"
              className="text-[11px] font-medium text-text-muted transition-colors hover:text-text"
              onClick={() =>
                onVisibleCountChange(
                  group.projectKey,
                  getNextProjectGroupVisibleCount(visibleCount, group.tasks.length)
                )
              }
            >
              {showMoreLabel}
            </button>
          )}
          {showLessVisible && (
            <button
              type="button"
              className="text-[11px] font-medium text-text-muted transition-colors hover:text-text"
              onClick={() =>
                onVisibleCountChange(
                  group.projectKey,
                  getPreviousProjectGroupVisibleCount(visibleCount, group.tasks.length)
                )
              }
            >
              {showLessLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
});

export const GlobalTaskList = memo(function GlobalTaskList({
  hideHeader = false,
  filters: externalFilters,
  onFiltersChange: externalOnFiltersChange,
  filtersPopoverOpen: externalFiltersPopoverOpen,
  onFiltersPopoverOpenChange: externalOnFiltersPopoverOpenChange,
}: GlobalTaskListProps = {}): React.JSX.Element {
  const { t } = useAppTranslation('common');
  const {
    globalTasks,
    globalTasksLoading,
    globalTasksInitialized,
    fetchAllTasks,
    fetchProjects,
    fetchRepositoryGroups,
    softDeleteTask,
    projects,
    projectsLoading,
    projectsInitialized,
    projectsError,
    viewMode,
    repositoryGroups,
    repositoryGroupsLoading,
    repositoryGroupsInitialized,
    repositoryGroupsError,
    teams,
    provisioningRuns,
    currentProvisioningRunIdByTeam,
    leadActivityByTeam,
  } = useStore(
    useShallow((s) => ({
      globalTasks: s.globalTasks,
      globalTasksLoading: s.globalTasksLoading,
      globalTasksInitialized: s.globalTasksInitialized,
      fetchAllTasks: s.fetchAllTasks,
      fetchProjects: s.fetchProjects,
      fetchRepositoryGroups: s.fetchRepositoryGroups,
      softDeleteTask: s.softDeleteTask,
      projects: s.projects,
      projectsLoading: s.projectsLoading,
      projectsInitialized: s.projectsInitialized,
      projectsError: s.projectsError,
      viewMode: s.viewMode,
      repositoryGroups: s.repositoryGroups,
      repositoryGroupsLoading: s.repositoryGroupsLoading,
      repositoryGroupsInitialized: s.repositoryGroupsInitialized,
      repositoryGroupsError: s.repositoryGroupsError,
      teams: s.teams,
      provisioningRuns: s.provisioningRuns,
      currentProvisioningRunIdByTeam: s.currentProvisioningRunIdByTeam,
      leadActivityByTeam: s.leadActivityByTeam,
    }))
  );

  const [internalFilters, setInternalFilters] = useState(defaultTaskFiltersState);
  const [internalFiltersPopoverOpen, setInternalFiltersPopoverOpen] = useState(false);
  const filters = externalFilters ?? internalFilters;
  const setFilters = externalOnFiltersChange ?? setInternalFilters;
  const filtersPopoverOpen = externalFiltersPopoverOpen ?? internalFiltersPopoverOpen;
  const setFiltersPopoverOpen = externalOnFiltersPopoverOpenChange ?? setInternalFiltersPopoverOpen;
  const [searchQuery, setSearchQuery] = useState('');
  const [groupingMode, setGroupingModeState] = useState<TaskGroupingMode>(loadGroupingMode);
  const [sortMode, setSortModeState] = useState<TaskSortMode>(loadSortMode);
  const [sortPopoverOpen, setSortPopoverOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [renamingTaskKey, setRenamingTaskKey] = useState<string | null>(null);
  const [aliveTeams, setAliveTeams] = useState<string[]>([]);
  const [aliveTeamsInitialized, setAliveTeamsInitialized] = useState(false);
  const [projectRequestedVisibleCountByKey, setProjectRequestedVisibleCountByKey] = useState<
    Record<string, number>
  >({});
  const searchInputRef = useRef<HTMLInputElement>(null);
  const hasFetchedRef = useRef(false);
  const readState = useReadStateSnapshot();
  const taskLocalState = useTaskLocalState();
  const electronMode = isElectronMode();

  const provisioningState = useMemo(
    () => ({ currentProvisioningRunIdByTeam, provisioningRuns }),
    [currentProvisioningRunIdByTeam, provisioningRuns]
  );

  const fetchAliveTeams = useCallback(async (): Promise<string[] | null> => {
    if (!electronMode || !api.teams?.aliveList) return null;
    try {
      return await api.teams.aliveList();
    } catch {
      return null;
    }
  }, [electronMode]);

  // --- New-task animation tracking (same pattern as ChatHistory) ---
  const knownTaskIdsRef = useRef<Set<string>>(new Set());
  const isInitialTaskLoadRef = useRef(true);

  const newTaskIds = useMemo(() => {
    if (!globalTasksInitialized || globalTasks.length === 0) {
      return new Set<string>();
    }

    // eslint-disable-next-line react-hooks/refs -- Synchronous diff is required so new rows mount with animate=true.
    if (isInitialTaskLoadRef.current) {
      isInitialTaskLoadRef.current = false;
      for (const t of globalTasks) {
        // eslint-disable-next-line react-hooks/refs -- Synchronous diff is required so new rows mount with animate=true.
        knownTaskIdsRef.current.add(`${t.teamName}:${t.id}`);
      }
      return new Set<string>();
    }

    const newIds = new Set<string>();
    for (const t of globalTasks) {
      const key = `${t.teamName}:${t.id}`;
      // eslint-disable-next-line react-hooks/refs -- Synchronous diff is required so new rows mount with animate=true.
      if (!knownTaskIdsRef.current.has(key)) {
        newIds.add(key);
        // eslint-disable-next-line react-hooks/refs -- Synchronous diff is required so new rows mount with animate=true.
        knownTaskIdsRef.current.add(key);
      }
    }
    return newIds;
  }, [globalTasks, globalTasksInitialized]);

  const isNewTask = useCallback(
    (task: GlobalTask): boolean => newTaskIds.has(`${task.teamName}:${task.id}`),
    [newTaskIds]
  );

  useEffect(() => {
    let cancelled = false;
    void fetchAliveTeams().then((list) => {
      if (!cancelled && list) {
        setAliveTeams(list);
        setAliveTeamsInitialized(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fetchAliveTeams, teams]);

  const readyProgressRefreshKey = useMemo(() => {
    return Object.entries(currentProvisioningRunIdByTeam)
      .map(([teamName, runId]) => {
        if (!runId) return null;
        const progress = provisioningRuns[runId];
        return progress?.state === 'ready'
          ? `${teamName}:${progress.runId}:${progress.updatedAt}`
          : null;
      })
      .filter((item): item is string => Boolean(item))
      .join('|');
  }, [currentProvisioningRunIdByTeam, provisioningRuns]);

  useEffect(() => {
    if (!readyProgressRefreshKey) return;
    let cancelled = false;
    void fetchAliveTeams().then((list) => {
      if (!cancelled && list) {
        setAliveTeams(list);
        setAliveTeamsInitialized(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fetchAliveTeams, readyProgressRefreshKey]);

  const offlineTeamNames = useMemo(() => {
    const result = new Set<string>();
    if (aliveTeamsInitialized) {
      const teamSummariesByName = new Map<string, TeamSummary>();
      for (const team of teams) {
        teamSummariesByName.set(team.teamName, team);
      }
      for (const task of globalTasks) {
        if (!teamSummariesByName.has(task.teamName)) {
          teamSummariesByName.set(task.teamName, buildTaskTeamSummary(task));
        }
      }

      for (const team of teamSummariesByName.values()) {
        const status = resolveTeamStatus(
          team,
          team.teamName,
          aliveTeams,
          getCurrentProvisioningProgressForTeam(provisioningState, team.teamName),
          leadActivityByTeam
        );
        if (!isTeamListStatusRunning(status)) {
          result.add(team.teamName);
        }
      }
    }
    for (const [teamName, activity] of Object.entries(leadActivityByTeam)) {
      if (activity === 'offline') {
        result.add(teamName);
      }
    }
    return result;
  }, [
    aliveTeams,
    aliveTeamsInitialized,
    globalTasks,
    leadActivityByTeam,
    provisioningState,
    teams,
  ]);

  const memberColorByTeam = useMemo(() => {
    const result = new Map<string, Map<string, string>>();
    for (const team of teams) {
      if (team.members && team.members.length > 0) {
        result.set(team.teamName, buildMemberColorMap(team.members));
      }
    }
    return result;
  }, [teams]);

  const getOwnerColorName = useCallback(
    (task: GlobalTask): string | null | undefined => {
      if (!task.owner) return null;
      const teamColorMap = memberColorByTeam.get(task.teamName);
      return teamColorMap ? (teamColorMap.get(task.owner) ?? null) : undefined;
    },
    [memberColorByTeam]
  );
  const isTeamOffline = useCallback(
    (teamName: string): boolean => offlineTeamNames.has(teamName),
    [offlineTeamNames]
  );
  const formatTeamHeader = useCallback(
    (teamDisplayName: string): string => t('tasksPanel.teamLabel', { team: teamDisplayName }),
    [t]
  );
  const handleProjectGroupVisibleCountChange = useCallback(
    (projectKey: string, visibleCount: number): void => {
      setProjectRequestedVisibleCountByKey((prev) => ({
        ...prev,
        [projectKey]: visibleCount,
      }));
    },
    []
  );

  const setGroupingMode = (mode: TaskGroupingMode): void => {
    setGroupingModeState(mode);
    saveGroupingMode(mode);
  };

  const setSortMode = (mode: TaskSortMode): void => {
    setSortModeState(mode);
    saveSortMode(mode);
  };

  const handleRenameComplete = useCallback(
    (teamName: string, taskId: string, newSubject: string): void => {
      taskLocalState.renameTask(teamName, taskId, newSubject);
      setRenamingTaskKey(null);
    },
    [taskLocalState]
  );

  const handleRenameCancel = useCallback((): void => {
    setRenamingTaskKey(null);
  }, []);

  const handleMarkTaskUnread = useCallback((teamName: string, taskId: string): void => {
    markTaskUnread(teamName, taskId);
  }, []);

  const handleToggleTaskPin = useCallback(
    (teamName: string, taskId: string): void => {
      taskLocalState.togglePin(teamName, taskId);
    },
    [taskLocalState]
  );

  const handleToggleTaskArchive = useCallback(
    (teamName: string, taskId: string): void => {
      taskLocalState.toggleArchive(teamName, taskId);
    },
    [taskLocalState]
  );

  const handleStartTaskRename = useCallback((teamName: string, taskId: string): void => {
    setRenamingTaskKey(`${teamName}:${taskId}`);
  }, []);

  const getTaskDisplaySubject = useCallback(
    (task: GlobalTask): string | undefined =>
      taskLocalState.getRenamedSubject(task.teamName, task.id),
    [taskLocalState]
  );

  const handleDeleteTask = useCallback(
    async (teamName: string, taskId: string): Promise<void> => {
      const confirmed = await confirm({
        title: t('tasksPanel.deleteConfirm.title'),
        message: t('tasksPanel.deleteConfirm.message', { taskId: deriveTaskDisplayId(taskId) }),
        confirmLabel: t('tasksPanel.deleteConfirm.confirmLabel'),
        cancelLabel: t('tasksPanel.deleteConfirm.cancelLabel'),
        variant: 'danger',
      });
      if (confirmed) {
        try {
          await softDeleteTask(teamName, taskId);
          await fetchAllTasks();
        } catch (err) {
          void confirm({
            title: t('tasksPanel.deleteFailed.title'),
            message:
              err instanceof Error ? err.message : t('tasksPanel.deleteFailed.fallbackMessage'),
            confirmLabel: t('tasksPanel.deleteFailed.confirmLabel'),
            variant: 'danger',
          });
        }
      }
    },
    [fetchAllTasks, softDeleteTask, t]
  );

  // Fetch tasks on mount — loading guard in the store action prevents
  // duplicate IPC calls when the centralized init chain is already fetching.
  useEffect(() => {
    if (!hasFetchedRef.current && !globalTasksLoading) {
      hasFetchedRef.current = true;
      void fetchAllTasks();
    }
  }, [fetchAllTasks, globalTasksLoading]);

  useEffect(() => {
    if (!filtersPopoverOpen) {
      return;
    }
    if (
      viewMode === 'grouped' &&
      !repositoryGroupsInitialized &&
      !repositoryGroupsLoading &&
      !repositoryGroupsError
    ) {
      void fetchRepositoryGroups();
    } else if (viewMode === 'flat' && !projectsInitialized && !projectsLoading && !projectsError) {
      void fetchProjects();
    }
  }, [
    fetchProjects,
    fetchRepositoryGroups,
    filtersPopoverOpen,
    projectsError,
    projectsInitialized,
    projectsLoading,
    repositoryGroupsError,
    repositoryGroupsInitialized,
    repositoryGroupsLoading,
    viewMode,
  ]);

  // Build project combobox options from available projects/repos
  const projectFilterOptions = useMemo((): ComboboxOption[] => {
    const items =
      viewMode === 'grouped'
        ? repositoryGroups
            .filter((r) => r.totalSessions > 0)
            .map((r) => ({
              value: r.worktrees[0]?.path ?? r.id,
              label: r.name,
              path: r.worktrees[0]?.path,
            }))
        : projects
            .filter((p) => (p.totalSessions ?? p.sessions.length) > 0)
            .map((p) => ({
              value: p.path,
              label: p.name,
              path: p.path,
            }));

    return items.map((item) => ({
      value: item.value,
      label: item.label,
      description: item.path,
    }));
  }, [viewMode, repositoryGroups, projects]);

  // Resolve project filter from filters state
  const selectedProjectPath = filters.projectPath;
  const hasArchivedTasks = useMemo(
    () => globalTasks.some((t) => taskLocalState.isArchived(t.teamName, t.id)),
    [globalTasks, taskLocalState]
  );
  const effectiveShowArchived = showArchived && hasArchivedTasks;

  const filtered = useMemo(() => {
    let result = globalTasks;
    result = applyProjectFilter(result, selectedProjectPath);
    result = result.filter((t) => taskMatchesStatus(t, filters.statusIds));
    if (filters.teamName) {
      result = result.filter((t) => t.teamName === filters.teamName);
    }
    if (filters.readFilter === 'unread') {
      result = result.filter(
        (t) => getTaskUnreadCount(readState, t.teamName, t.id, t.comments) > 0
      );
    } else if (filters.readFilter === 'read') {
      result = result.filter(
        (t) => getTaskUnreadCount(readState, t.teamName, t.id, t.comments) === 0
      );
    }
    result = applySearch(result, searchQuery);
    // Archive filtering
    if (effectiveShowArchived) {
      result = result.filter((t) => taskLocalState.isArchived(t.teamName, t.id));
    } else {
      result = result.filter((t) => !taskLocalState.isArchived(t.teamName, t.id));
    }
    return result;
  }, [
    globalTasks,
    selectedProjectPath,
    filters.statusIds,
    filters.teamName,
    filters.readFilter,
    searchQuery,
    readState,
    effectiveShowArchived,
    taskLocalState,
  ]);

  // Split into pinned and normal (non-pinned) tasks
  const pinnedTasks = useMemo(
    () => filtered.filter((t) => taskLocalState.isPinned(t.teamName, t.id)),
    [filtered, taskLocalState]
  );
  const normalTasks = useMemo(
    () => filtered.filter((t) => !taskLocalState.isPinned(t.teamName, t.id)),
    [filtered, taskLocalState]
  );
  const sortedPinnedTasks = useMemo(() => sortTasksByFreshness(pinnedTasks), [pinnedTasks]);

  const sortedFlat = useMemo(
    () => applySortMode(normalTasks, sortMode, readState),
    [normalTasks, sortMode, readState]
  );
  const grouped = useMemo(() => groupTasksByDate(normalTasks), [normalTasks]);
  const categories = useMemo(() => getNonEmptyTaskCategories(grouped), [grouped]);
  const projectGroups = useMemo(() => groupTasksByProject(normalTasks), [normalTasks]);

  // Collapsed group keys for each grouping mode
  const projectGroupKeys = useMemo(
    () => projectGroups.filter((g) => g.tasks.length > 0).map((g) => g.projectKey),
    [projectGroups]
  );
  const timeGroupKeys = useMemo(() => categories.map((c) => c), [categories]);
  const projectGroupVisibility = useMemo(
    () =>
      projectGroups.map((group) => ({
        projectKey: group.projectKey,
        taskCount: group.tasks.length,
      })),
    [projectGroups]
  );
  const projectVisibleCountByKey = useMemo(
    () =>
      syncProjectGroupVisibleCountByKey(projectRequestedVisibleCountByKey, projectGroupVisibility),
    [projectRequestedVisibleCountByKey, projectGroupVisibility]
  );
  const taskFilterTeams = useMemo(
    () => teams.map((team) => ({ teamName: team.teamName, displayName: team.displayName })),
    [teams]
  );

  const { isCollapsed: isProjectGroupCollapsed, toggle: toggleProjectGroup } = useCollapsedGroups(
    'project',
    projectGroupKeys
  );
  const { isCollapsed: isTimeGroupCollapsed, toggle: toggleTimeGroup } = useCollapsedGroups(
    'time',
    timeGroupKeys
  );
  const handleToggleProjectGroup = useCallback(
    (projectKey: string): void => {
      toggleProjectGroup(projectKey);
    },
    [toggleProjectGroup]
  );

  const hasContent =
    pinnedTasks.length > 0 ||
    (groupingMode === 'none'
      ? sortedFlat.length > 0
      : groupingMode === 'time'
        ? categories.length > 0
        : projectGroups.some((g) => g.tasks.length > 0));

  const noProjectGroupColor = useMemo(
    () => ({
      border: 'var(--color-border)',
      glow: 'transparent',
      icon: 'var(--color-text-muted)',
      text: 'var(--color-text-secondary)',
    }),
    []
  );

  return (
    <div className="flex size-full min-w-0 flex-col overflow-x-hidden">
      {!hideHeader && (
        <div
          className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <span className="text-[12px] font-semibold text-text-secondary">
            {t('tasksPanel.title')}
          </span>
        </div>
      )}

      {/* Search bar */}
      <div
        className="mb-[5px] flex shrink-0 items-center gap-1.5 border-b px-2 py-1"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <Search className="size-3 shrink-0 text-text-muted" />
        <input
          ref={searchInputRef}
          type="text"
          placeholder={t('tasksPanel.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="min-w-0 flex-1 bg-transparent text-[12px] text-text placeholder:text-text-muted focus:outline-none"
        />
        {searchQuery && (
          <button
            type="button"
            className="shrink-0 text-text-muted hover:text-text-secondary"
            onClick={() => {
              setSearchQuery('');
              searchInputRef.current?.focus();
            }}
          >
            <X className="size-3" />
          </button>
        )}
        <Popover open={sortPopoverOpen} onOpenChange={setSortPopoverOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex shrink-0 items-center justify-center rounded p-0.5 text-text-muted transition-colors hover:text-text-secondary data-[state=open]:bg-surface-raised data-[state=open]:text-text"
            >
              <ArrowUpDown className="size-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-40 p-1" align="end" sideOffset={6}>
            <div className="flex flex-col">
              {SORT_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                    setSortMode(opt.id);
                    setSortPopoverOpen(false);
                  }}
                  className={cn(
                    'flex items-center gap-2 rounded px-2 py-1.5 text-[12px] transition-colors',
                    sortMode === opt.id
                      ? 'bg-surface-raised text-text'
                      : 'hover:bg-surface-raised/60 text-text-secondary hover:text-text'
                  )}
                >
                  <Check
                    className={cn(
                      'size-3 shrink-0',
                      sortMode === opt.id ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {t(opt.labelKey)}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <TaskFiltersPopover
          open={filtersPopoverOpen}
          onOpenChange={setFiltersPopoverOpen}
          teams={taskFilterTeams}
          projectOptions={projectFilterOptions}
          filters={filters}
          onFiltersChange={setFilters}
          onApply={() => {}}
        />
      </div>

      {/* Pinned tasks section */}
      {pinnedTasks.length > 0 && !effectiveShowArchived && (
        <div className="shrink-0 border-b" style={{ borderColor: 'var(--color-border)' }}>
          <div className="flex items-center gap-1 px-2 py-1">
            <Pin className="size-3 text-text-muted" />
            <span className="text-[11px] text-text-muted">{t('tasksPanel.pinned')}</span>
          </div>
          <TaskRows
            tasks={sortedPinnedTasks}
            keyPrefix="pinned-"
            isPinned={taskLocalState.isPinned}
            isArchived={taskLocalState.isArchived}
            isNewTask={isNewTask}
            isTeamOffline={isTeamOffline}
            pinnedOverride={true}
            archivedOverride={false}
            showTeamName
            renamingKey={renamingTaskKey}
            onTogglePin={handleToggleTaskPin}
            onToggleArchive={handleToggleTaskArchive}
            onMarkUnread={handleMarkTaskUnread}
            onRename={handleStartTaskRename}
            onDelete={handleDeleteTask}
            onRenameComplete={handleRenameComplete}
            onRenameCancel={handleRenameCancel}
            getDisplaySubject={getTaskDisplaySubject}
            getOwnerColorName={getOwnerColorName}
          />
        </div>
      )}

      {/* Grouping mode — compact text toggle */}
      <div className="flex shrink-0 items-center gap-1.5 px-2 py-1">
        <span className="shrink-0 text-[11px] text-text-muted">{t('tasksPanel.groupByLabel')}</span>
        <div
          className="inline-flex gap-1 text-[11px]"
          role="group"
          aria-label={t('tasksPanel.groupByAria')}
        >
          {(['none', 'project', 'time'] as const).map((mode) => {
            const label =
              mode === 'none'
                ? t('tasksPanel.groupModes.none')
                : mode === 'project'
                  ? t('tasksPanel.groupModes.project')
                  : t('tasksPanel.groupModes.time');
            return (
              <button
                key={mode}
                type="button"
                onClick={() => setGroupingMode(mode)}
                className={cn(
                  'rounded px-1.5 py-0.5 transition-colors',
                  groupingMode === mode ? 'text-text' : 'text-text-muted hover:text-text-secondary'
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        {/* Archive toggle — only visible when archived tasks exist */}
        {hasArchivedTasks && (
          <div className="ml-auto">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setShowArchived(!showArchived)}
                  className={cn(
                    'rounded p-0.5 transition-colors',
                    effectiveShowArchived
                      ? 'bg-surface-raised text-text-secondary'
                      : 'text-text-muted hover:text-text-secondary'
                  )}
                >
                  <Archive className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {effectiveShowArchived
                  ? t('tasksPanel.hideArchived')
                  : t('tasksPanel.showArchived')}
              </TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {globalTasksLoading && !globalTasksInitialized && (
          <div className="space-y-2 p-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-[48px] animate-pulse rounded bg-surface-raised" />
            ))}
          </div>
        )}

        {globalTasksInitialized && !hasContent && (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-text-muted">
            <ListTodo className="size-8 opacity-40" />
            <span className="text-[12px]">
              {searchQuery || selectedProjectPath
                ? t('tasksPanel.empty.noMatchingTasks')
                : t('tasksPanel.empty.noTasks')}
            </span>
          </div>
        )}

        {groupingMode === 'none' && (
          <TaskRows
            tasks={sortedFlat}
            isPinned={taskLocalState.isPinned}
            isArchived={taskLocalState.isArchived}
            isNewTask={isNewTask}
            isTeamOffline={isTeamOffline}
            showTeamName
            renamingKey={renamingTaskKey}
            onTogglePin={handleToggleTaskPin}
            onToggleArchive={handleToggleTaskArchive}
            onMarkUnread={handleMarkTaskUnread}
            onRename={handleStartTaskRename}
            onDelete={handleDeleteTask}
            onRenameComplete={handleRenameComplete}
            onRenameCancel={handleRenameCancel}
            getDisplaySubject={getTaskDisplaySubject}
            getOwnerColorName={getOwnerColorName}
          />
        )}

        {groupingMode === 'project' &&
          projectGroups.map((group) => {
            const visibleCount = getProjectGroupVisibleCount(
              projectVisibleCountByKey[group.projectKey],
              group.tasks.length
            );
            return (
              <ProjectTaskGroup
                key={group.projectKey}
                group={group}
                isCollapsed={isProjectGroupCollapsed(group.projectKey)}
                visibleCount={visibleCount}
                noProjectGroupColor={noProjectGroupColor}
                showMoreLabel={t('tasksPanel.showMore')}
                showLessLabel={t('tasksPanel.showLess')}
                isPinned={taskLocalState.isPinned}
                isArchived={taskLocalState.isArchived}
                isNewTask={isNewTask}
                isTeamOffline={isTeamOffline}
                renamingKey={renamingTaskKey}
                formatTeamHeader={formatTeamHeader}
                onToggleGroup={handleToggleProjectGroup}
                onVisibleCountChange={handleProjectGroupVisibleCountChange}
                onTogglePin={handleToggleTaskPin}
                onToggleArchive={handleToggleTaskArchive}
                onMarkUnread={handleMarkTaskUnread}
                onRename={handleStartTaskRename}
                onDelete={handleDeleteTask}
                onRenameComplete={handleRenameComplete}
                onRenameCancel={handleRenameCancel}
                getDisplaySubject={getTaskDisplaySubject}
                getOwnerColorName={getOwnerColorName}
              />
            );
          })}

        {groupingMode === 'time' &&
          categories.map((category) => {
            const tasks = grouped[category];
            const isGroupCollapsed = isTimeGroupCollapsed(category);

            return (
              <div key={category}>
                <button
                  type="button"
                  onClick={() => toggleTimeGroup(category)}
                  className="hover:bg-surface-raised/40 sticky top-0 z-10 flex w-full cursor-pointer items-center gap-1 px-2 py-1.5 text-[11px] font-semibold text-text-secondary transition-colors"
                  style={{ backgroundColor: 'var(--color-surface-sidebar)' }}
                >
                  {isGroupCollapsed ? (
                    <ChevronRight className="size-3 shrink-0 text-text-muted" />
                  ) : (
                    <ChevronDown className="size-3 shrink-0 text-text-muted" />
                  )}
                  <span className="truncate">{dateCategoryLabels[category] ?? category}</span>
                  <span className="ml-auto shrink-0 text-[10px] font-normal text-text-muted">
                    {tasks.length}
                  </span>
                </button>

                {!isGroupCollapsed && (
                  <TaskRows
                    tasks={tasks}
                    isPinned={taskLocalState.isPinned}
                    isArchived={taskLocalState.isArchived}
                    isNewTask={isNewTask}
                    isTeamOffline={isTeamOffline}
                    showTeamHeader
                    formatTeamHeader={formatTeamHeader}
                    renamingKey={renamingTaskKey}
                    onTogglePin={handleToggleTaskPin}
                    onToggleArchive={handleToggleTaskArchive}
                    onMarkUnread={handleMarkTaskUnread}
                    onRename={handleStartTaskRename}
                    onDelete={handleDeleteTask}
                    onRenameComplete={handleRenameComplete}
                    onRenameCancel={handleRenameCancel}
                    getDisplaySubject={getTaskDisplaySubject}
                    getOwnerColorName={getOwnerColorName}
                  />
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
});
