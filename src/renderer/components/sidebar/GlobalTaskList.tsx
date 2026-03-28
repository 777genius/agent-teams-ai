import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { confirm } from '@renderer/components/common/ConfirmDialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useCollapsedGroups } from '@renderer/hooks/useCollapsedGroups';
import { useTaskLocalState } from '@renderer/hooks/useTaskLocalState';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { normalizePath } from '@renderer/utils/pathNormalize';
import { projectColor } from '@renderer/utils/projectColor';
import {
  getNonEmptyTaskCategories,
  groupTasksByDate,
  groupTasksByProject,
  sortTasksByFreshness,
} from '@renderer/utils/taskGrouping';
import { deriveTaskDisplayId } from '@shared/utils/taskIdentity';
import {
  Archive,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronRight,
  ListTodo,
  Pin,
  Search,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { AnimatedHeightReveal } from '../team/activity/AnimatedHeightReveal';
import { type ComboboxOption } from '../ui/combobox';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

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
import type { GlobalTask } from '@shared/types';

const TASK_GROUPING_STORAGE_KEY = 'sidebarTasksGrouping';

export type TaskGroupingMode = 'none' | 'project' | 'time';

function loadGroupingMode(): TaskGroupingMode {
  try {
    const v = localStorage.getItem(TASK_GROUPING_STORAGE_KEY);
    if (v === 'none' || v === 'project' || v === 'time') return v;
  } catch {
    /* ignore */
  }
  return 'none';
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

const SORT_OPTIONS: { id: TaskSortMode; label: string }[] = [
  { id: 'time', label: 'By time' },
  { id: 'unread', label: 'By unread' },
  { id: 'project', label: 'By project' },
  { id: 'team', label: 'By team' },
];

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

export const GlobalTaskList = ({
  hideHeader = false,
  filters: externalFilters,
  onFiltersChange: externalOnFiltersChange,
  filtersPopoverOpen: externalFiltersPopoverOpen,
  onFiltersPopoverOpenChange: externalOnFiltersPopoverOpenChange,
}: GlobalTaskListProps = {}): React.JSX.Element => {
  const {
    globalTasks,
    globalTasksLoading,
    globalTasksInitialized,
    fetchAllTasks,
    softDeleteTask,
    projects,
    viewMode,
    repositoryGroups,
    teams,
  } = useStore(
    useShallow((s) => ({
      globalTasks: s.globalTasks,
      globalTasksLoading: s.globalTasksLoading,
      globalTasksInitialized: s.globalTasksInitialized,
      fetchAllTasks: s.fetchAllTasks,
      softDeleteTask: s.softDeleteTask,
      projects: s.projects,
      viewMode: s.viewMode,
      repositoryGroups: s.repositoryGroups,
      teams: s.teams,
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
  const searchInputRef = useRef<HTMLInputElement>(null);
  const hasFetchedRef = useRef(false);
  const readState = useReadStateSnapshot();
  const taskLocalState = useTaskLocalState();

  // --- New-task animation tracking (same pattern as ChatHistory) ---
  const knownTaskIdsRef = useRef<Set<string>>(new Set());
  const isInitialTaskLoadRef = useRef(true);

  const newTaskIds = useMemo(() => {
    if (!globalTasksInitialized || globalTasks.length === 0) {
      return new Set<string>();
    }

    // First load: seed all known IDs, no animations
    if (isInitialTaskLoadRef.current) {
      isInitialTaskLoadRef.current = false;
      for (const t of globalTasks) {
        knownTaskIdsRef.current.add(`${t.teamName}:${t.id}`);
      }
      return new Set<string>();
    }

    // Subsequent updates: detect truly new tasks
    const newIds = new Set<string>();
    for (const t of globalTasks) {
      const key = `${t.teamName}:${t.id}`;
      if (!knownTaskIdsRef.current.has(key)) {
        newIds.add(key);
        knownTaskIdsRef.current.add(key);
      }
    }
    return newIds;
  }, [globalTasks, globalTasksInitialized]);

  const isNewTask = useCallback(
    (task: GlobalTask): boolean => newTaskIds.has(`${task.teamName}:${task.id}`),
    [newTaskIds]
  );

  const setGroupingMode = (mode: TaskGroupingMode): void => {
    setGroupingModeState(mode);
    saveGroupingMode(mode);
  };

  const setSortMode = (mode: TaskSortMode): void => {
    setSortModeState(mode);
    saveSortMode(mode);
  };

  const handleRenameComplete = (teamName: string, taskId: string, newSubject: string): void => {
    taskLocalState.renameTask(teamName, taskId, newSubject);
    setRenamingTaskKey(null);
  };

  const handleRenameCancel = (): void => {
    setRenamingTaskKey(null);
  };

  const handleDeleteTask = async (teamName: string, taskId: string): Promise<void> => {
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
        await fetchAllTasks();
      } catch (err) {
        void confirm({
          title: 'Failed to delete task',
          message: err instanceof Error ? err.message : 'An unexpected error occurred',
          confirmLabel: 'OK',
          variant: 'danger',
        });
      }
    }
  };

  // Fetch tasks on mount — loading guard in the store action prevents
  // duplicate IPC calls when the centralized init chain is already fetching.
  useEffect(() => {
    if (!hasFetchedRef.current && !globalTasksLoading) {
      hasFetchedRef.current = true;
      void fetchAllTasks();
    }
  }, [fetchAllTasks, globalTasksLoading]);

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
    if (showArchived) {
      result = result.filter((t) => taskLocalState.isArchived(t.teamName, t.id));
    } else {
      result = result.filter((t) => !taskLocalState.isArchived(t.teamName, t.id));
    }
    return result;
  }, [
    globalTasks,
    filters.projectPath,
    filters.statusIds,
    filters.teamName,
    filters.readFilter,
    searchQuery,
    readState,
    showArchived,
    taskLocalState,
  ]);

  // Check if any archived tasks exist (before archive filtering) to conditionally show the toggle
  const hasArchivedTasks = useMemo(
    () => globalTasks.some((t) => taskLocalState.isArchived(t.teamName, t.id)),
    [globalTasks, taskLocalState]
  );

  // Reset showArchived when archive becomes empty
  useEffect(() => {
    if (showArchived && !hasArchivedTasks) {
      setShowArchived(false);
    }
  }, [showArchived, hasArchivedTasks]);

  // Split into pinned and normal (non-pinned) tasks
  const pinnedTasks = useMemo(
    () => filtered.filter((t) => taskLocalState.isPinned(t.teamName, t.id)),
    [filtered, taskLocalState]
  );
  const normalTasks = useMemo(
    () => filtered.filter((t) => !taskLocalState.isPinned(t.teamName, t.id)),
    [filtered, taskLocalState]
  );

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

  const projectCollapsed = useCollapsedGroups('project', projectGroupKeys);
  const timeCollapsed = useCollapsedGroups('time', timeGroupKeys);

  const hasContent =
    pinnedTasks.length > 0 ||
    (groupingMode === 'none'
      ? sortedFlat.length > 0
      : groupingMode === 'time'
        ? categories.length > 0
        : projectGroups.some((g) => g.tasks.length > 0));

  return (
    <div className="flex size-full min-w-0 flex-col">
      {!hideHeader && (
        <div
          className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <span className="text-[12px] font-semibold text-text-secondary">Tasks</span>
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
          placeholder="Search tasks..."
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
                  {opt.label}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <TaskFiltersPopover
          open={filtersPopoverOpen}
          onOpenChange={setFiltersPopoverOpen}
          teams={teams.map((t) => ({ teamName: t.teamName, displayName: t.displayName }))}
          projectOptions={projectFilterOptions}
          filters={filters}
          onFiltersChange={setFilters}
          onApply={() => {}}
        />
      </div>

      {/* Pinned tasks section */}
      {pinnedTasks.length > 0 && !showArchived && (
        <div className="shrink-0 border-b" style={{ borderColor: 'var(--color-border)' }}>
          <div className="flex items-center gap-1 px-2 py-1">
            <Pin className="size-3 text-text-muted" />
            <span className="text-[11px] text-text-muted">Pinned</span>
          </div>
          {sortTasksByFreshness(pinnedTasks).map((task) => (
            <TaskContextMenu
              key={`pinned-${task.teamName}-${task.id}`}
              task={task}
              isPinned={true}
              isArchived={false}
              onTogglePin={() => taskLocalState.togglePin(task.teamName, task.id)}
              onToggleArchive={() => taskLocalState.toggleArchive(task.teamName, task.id)}
              onRename={() => setRenamingTaskKey(`${task.teamName}:${task.id}`)}
              onDelete={() => handleDeleteTask(task.teamName, task.id)}
            >
              <AnimatedHeightReveal animate={isNewTask(task)}>
                <SidebarTaskItem
                  task={task}
                  showTeamName
                  renamingKey={renamingTaskKey}
                  onRenameComplete={handleRenameComplete}
                  onRenameCancel={handleRenameCancel}
                  getDisplaySubject={(t) => taskLocalState.getRenamedSubject(t.teamName, t.id)}
                />
              </AnimatedHeightReveal>
            </TaskContextMenu>
          ))}
        </div>
      )}

      {/* Grouping mode — compact text toggle */}
      <div className="flex shrink-0 items-center gap-1.5 px-2 py-1">
        <span className="shrink-0 text-[11px] text-text-muted">Group by:</span>
        <div className="inline-flex gap-1 text-[11px]" role="group" aria-label="Group by">
          {(['none', 'project', 'time'] as const).map((mode) => {
            const label = mode === 'none' ? 'None' : mode === 'project' ? 'Project' : 'Time';
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
                    showArchived
                      ? 'bg-surface-raised text-text-secondary'
                      : 'text-text-muted hover:text-text-secondary'
                  )}
                >
                  <Archive className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {showArchived ? 'Hide archived' : 'Show archived'}
              </TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
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
              {searchQuery || selectedProjectPath ? 'No matching tasks' : 'No tasks found'}
            </span>
          </div>
        )}

        {groupingMode === 'none' &&
          sortedFlat.map((task) => (
            <TaskContextMenu
              key={`${task.teamName}-${task.id}`}
              task={task}
              isPinned={taskLocalState.isPinned(task.teamName, task.id)}
              isArchived={taskLocalState.isArchived(task.teamName, task.id)}
              onTogglePin={() => taskLocalState.togglePin(task.teamName, task.id)}
              onToggleArchive={() => taskLocalState.toggleArchive(task.teamName, task.id)}
              onRename={() => setRenamingTaskKey(`${task.teamName}:${task.id}`)}
              onDelete={() => handleDeleteTask(task.teamName, task.id)}
            >
              <AnimatedHeightReveal animate={isNewTask(task)}>
                <SidebarTaskItem
                  task={task}
                  showTeamName
                  renamingKey={renamingTaskKey}
                  onRenameComplete={handleRenameComplete}
                  onRenameCancel={handleRenameCancel}
                  getDisplaySubject={(t) => taskLocalState.getRenamedSubject(t.teamName, t.id)}
                />
              </AnimatedHeightReveal>
            </TaskContextMenu>
          ))}

        {groupingMode === 'project' &&
          projectGroups.map((group) => {
            if (group.tasks.length === 0) return null;
            const isGroupCollapsed = projectCollapsed.isCollapsed(group.projectKey);
            let lastTeam: string | null = null;
            return (
              <div key={group.projectKey}>
                <button
                  type="button"
                  onClick={() => projectCollapsed.toggle(group.projectKey)}
                  className="hover:bg-surface-raised/40 sticky top-0 z-10 flex w-full cursor-pointer items-center gap-1 px-2 py-1.5 text-[11px] font-semibold transition-colors"
                  style={{ backgroundColor: 'var(--color-surface-sidebar)' }}
                >
                  {isGroupCollapsed ? (
                    <ChevronRight className="size-3 shrink-0 text-text-muted" />
                  ) : (
                    <ChevronDown className="size-3 shrink-0 text-text-muted" />
                  )}
                  <span
                    className="inline-block size-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: projectColor(group.projectLabel).border }}
                  />
                  <span
                    className="truncate"
                    style={{ color: projectColor(group.projectLabel).text }}
                  >
                    {group.projectLabel}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] font-normal text-text-muted">
                    {group.tasks.length}
                  </span>
                </button>
                {!isGroupCollapsed &&
                  group.tasks.map((task) => {
                    const showTeamHeader = task.teamName !== lastTeam;
                    lastTeam = task.teamName;
                    return (
                      <div key={`${task.teamName}-${task.id}`}>
                        {showTeamHeader && (
                          <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-medium text-text-muted">
                            Team: {task.teamDisplayName}
                          </div>
                        )}
                        <TaskContextMenu
                          task={task}
                          isPinned={taskLocalState.isPinned(task.teamName, task.id)}
                          isArchived={taskLocalState.isArchived(task.teamName, task.id)}
                          onTogglePin={() => taskLocalState.togglePin(task.teamName, task.id)}
                          onToggleArchive={() =>
                            taskLocalState.toggleArchive(task.teamName, task.id)
                          }
                          onRename={() => setRenamingTaskKey(`${task.teamName}:${task.id}`)}
                          onDelete={() => handleDeleteTask(task.teamName, task.id)}
                        >
                          <AnimatedHeightReveal animate={isNewTask(task)}>
                            <SidebarTaskItem
                              task={task}
                              hideTeamName
                              renamingKey={renamingTaskKey}
                              onRenameComplete={handleRenameComplete}
                              onRenameCancel={handleRenameCancel}
                              getDisplaySubject={(t) =>
                                taskLocalState.getRenamedSubject(t.teamName, t.id)
                              }
                            />
                          </AnimatedHeightReveal>
                        </TaskContextMenu>
                      </div>
                    );
                  })}
              </div>
            );
          })}

        {groupingMode === 'time' &&
          categories.map((category) => {
            const tasks = grouped[category];
            const isGroupCollapsed = timeCollapsed.isCollapsed(category);
            let lastTeam: string | null = null;

            return (
              <div key={category}>
                <button
                  type="button"
                  onClick={() => timeCollapsed.toggle(category)}
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

                {!isGroupCollapsed &&
                  tasks.map((task) => {
                    const showTeamHeader = task.teamName !== lastTeam;
                    lastTeam = task.teamName;

                    return (
                      <div key={`${task.teamName}-${task.id}`}>
                        {showTeamHeader && (
                          <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-medium text-text-muted">
                            Team: {task.teamDisplayName}
                          </div>
                        )}
                        <TaskContextMenu
                          task={task}
                          isPinned={taskLocalState.isPinned(task.teamName, task.id)}
                          isArchived={taskLocalState.isArchived(task.teamName, task.id)}
                          onTogglePin={() => taskLocalState.togglePin(task.teamName, task.id)}
                          onToggleArchive={() =>
                            taskLocalState.toggleArchive(task.teamName, task.id)
                          }
                          onRename={() => setRenamingTaskKey(`${task.teamName}:${task.id}`)}
                          onDelete={() => handleDeleteTask(task.teamName, task.id)}
                        >
                          <AnimatedHeightReveal animate={isNewTask(task)}>
                            <SidebarTaskItem
                              task={task}
                              renamingKey={renamingTaskKey}
                              onRenameComplete={handleRenameComplete}
                              onRenameCancel={handleRenameCancel}
                              getDisplaySubject={(t) =>
                                taskLocalState.getRenamedSubject(t.teamName, t.id)
                              }
                            />
                          </AnimatedHeightReveal>
                        </TaskContextMenu>
                      </div>
                    );
                  })}
              </div>
            );
          })}
      </div>
    </div>
  );
};
