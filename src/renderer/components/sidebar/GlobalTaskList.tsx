import { useEffect, useMemo, useRef, useState } from 'react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { useStore } from '@renderer/store';
import { normalizePath } from '@renderer/utils/pathNormalize';
import {
  getNonEmptyTaskCategories,
  groupTasksByDate,
  groupTasksByProject,
} from '@renderer/utils/taskGrouping';
import { ListTodo, Search, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { SidebarTaskItem } from './SidebarTaskItem';
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

export type TaskGroupingMode = 'project' | 'time';

function loadGroupingMode(): TaskGroupingMode {
  try {
    const v = localStorage.getItem(TASK_GROUPING_STORAGE_KEY);
    if (v === 'project' || v === 'time') return v;
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
    fetchAllTasks,
    projects,
    activeProjectId,
    viewMode,
    repositoryGroups,
    selectedRepositoryId,
    selectedWorktreeId,
    teams,
  } = useStore(
    useShallow((s) => ({
      globalTasks: s.globalTasks,
      globalTasksLoading: s.globalTasksLoading,
      fetchAllTasks: s.fetchAllTasks,
      projects: s.projects,
      activeProjectId: s.activeProjectId,
      viewMode: s.viewMode,
      repositoryGroups: s.repositoryGroups,
      selectedRepositoryId: s.selectedRepositoryId,
      selectedWorktreeId: s.selectedWorktreeId,
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
  const searchInputRef = useRef<HTMLInputElement>(null);
  const hasFetchedRef = useRef(false);
  const readState = useReadStateSnapshot();

  const setGroupingMode = (mode: TaskGroupingMode): void => {
    setGroupingModeState(mode);
    saveGroupingMode(mode);
  };

  useEffect(() => {
    if (!hasFetchedRef.current) {
      hasFetchedRef.current = true;
      void fetchAllTasks();
    }
  }, [fetchAllTasks]);

  const selectedProjectPath = useMemo(() => {
    if (viewMode === 'grouped') {
      const repo = repositoryGroups.find((r) => r.id === selectedRepositoryId);
      const worktree = repo?.worktrees.find((w) => w.id === selectedWorktreeId);
      return worktree?.path ?? null;
    }
    const project = projects.find((p) => p.id === activeProjectId);
    return project?.path ?? null;
  }, [
    viewMode,
    repositoryGroups,
    selectedRepositoryId,
    selectedWorktreeId,
    projects,
    activeProjectId,
  ]);

  const filtered = useMemo(() => {
    let result = globalTasks;
    result = applyProjectFilter(result, selectedProjectPath);
    result = result.filter((t) => taskMatchesStatus(t, filters.statusIds));
    if (filters.teamName) {
      result = result.filter((t) => t.teamName === filters.teamName);
    }
    if (filters.unreadOnly) {
      result = result.filter(
        (t) => getTaskUnreadCount(readState, t.teamName, t.id, t.comments) > 0
      );
    }
    result = applySearch(result, searchQuery);
    return result;
  }, [
    globalTasks,
    selectedProjectPath,
    filters.statusIds,
    filters.teamName,
    filters.unreadOnly,
    searchQuery,
    readState,
  ]);

  const grouped = useMemo(() => groupTasksByDate(filtered), [filtered]);
  const categories = useMemo(() => getNonEmptyTaskCategories(grouped), [grouped]);
  const projectGroups = useMemo(() => groupTasksByProject(filtered), [filtered]);

  const hasContent =
    groupingMode === 'time' ? categories.length > 0 : projectGroups.some((g) => g.tasks.length > 0);

  return (
    <div className="flex size-full min-w-0 flex-col">
      {!hideHeader && (
        <div
          className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <span className="text-[12px] font-semibold text-text-secondary">Tasks</span>
          <TaskFiltersPopover
            open={filtersPopoverOpen}
            onOpenChange={setFiltersPopoverOpen}
            teams={teams.map((t) => ({ teamName: t.teamName, displayName: t.displayName }))}
            filters={filters}
            onFiltersChange={setFilters}
            onApply={() => {}}
          />
        </div>
      )}

      {/* Search bar */}
      <div
        className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1"
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
      </div>

      {/* Grouping mode */}
      <div className="flex shrink-0 items-center gap-2 px-2 py-1">
        <span className="shrink-0 text-[11px] text-text-muted">Group by:</span>
        <Select value={groupingMode} onValueChange={(v) => setGroupingMode(v as TaskGroupingMode)}>
          <SelectTrigger className="h-7 min-w-0 flex-1 border-[var(--color-border)] px-2 text-[11px]">
            <SelectValue placeholder="Group by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="project">Project</SelectItem>
            <SelectItem value="time">Time</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {globalTasksLoading && globalTasks.length === 0 && (
          <div className="space-y-2 p-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-[48px] animate-pulse rounded bg-surface-raised" />
            ))}
          </div>
        )}

        {!globalTasksLoading && !hasContent && (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-text-muted">
            <ListTodo className="size-8 opacity-40" />
            <span className="text-[12px]">
              {searchQuery || selectedProjectPath ? 'No matching tasks' : 'No tasks found'}
            </span>
          </div>
        )}

        {groupingMode === 'project' &&
          projectGroups.map((group) => {
            if (group.tasks.length === 0) return null;
            let lastTeam: string | null = null;
            return (
              <div key={group.projectKey}>
                <div
                  className="sticky top-0 z-10 px-3 py-1.5 text-[11px] font-semibold text-text-secondary"
                  style={{ backgroundColor: 'var(--color-surface-sidebar)' }}
                >
                  {group.projectLabel}
                </div>
                {group.tasks.map((task) => {
                  const showTeamHeader = task.teamName !== lastTeam;
                  lastTeam = task.teamName;
                  return (
                    <div key={`${task.teamName}-${task.id}`}>
                      {showTeamHeader && (
                        <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-medium text-text-muted">
                          Team: {task.teamDisplayName}
                        </div>
                      )}
                      <SidebarTaskItem task={task} />
                    </div>
                  );
                })}
              </div>
            );
          })}

        {groupingMode === 'time' &&
          categories.map((category) => {
            const tasks = grouped[category];
            let lastTeam: string | null = null;

            return (
              <div key={category}>
                <div
                  className="sticky top-0 z-10 px-3 py-1.5 text-[11px] font-semibold text-text-secondary"
                  style={{ backgroundColor: 'var(--color-surface-sidebar)' }}
                >
                  {dateCategoryLabels[category] ?? category}
                </div>

                {tasks.map((task) => {
                  const showTeamHeader = task.teamName !== lastTeam;
                  lastTeam = task.teamName;

                  return (
                    <div key={`${task.teamName}-${task.id}`}>
                      {showTeamHeader && (
                        <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-medium text-text-muted">
                          Team: {task.teamDisplayName}
                        </div>
                      )}
                      <SidebarTaskItem task={task} />
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
