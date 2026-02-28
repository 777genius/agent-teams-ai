import { useEffect, useMemo, useRef, useState } from 'react';

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
import { ListTodo, Search, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { Combobox, type ComboboxOption } from '../ui/combobox';

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
    viewMode,
    repositoryGroups,
    teams,
  } = useStore(
    useShallow((s) => ({
      globalTasks: s.globalTasks,
      globalTasksLoading: s.globalTasksLoading,
      fetchAllTasks: s.fetchAllTasks,
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
  const searchInputRef = useRef<HTMLInputElement>(null);
  const hasFetchedRef = useRef(false);
  const readState = useReadStateSnapshot();

  // Local project filter (independent from sessions tab)
  const [localProjectFilter, setLocalProjectFilter] = useState<string | null>(null);

  const setGroupingMode = (mode: TaskGroupingMode): void => {
    setGroupingModeState(mode);
    saveGroupingMode(mode);
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
            .filter((p) => p.sessions.length > 0)
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

  // Resolve local filter to a project path
  const selectedProjectPath = localProjectFilter;

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

  const sortedFlat = useMemo(() => sortTasksByFreshness(filtered), [filtered]);
  const grouped = useMemo(() => groupTasksByDate(filtered), [filtered]);
  const categories = useMemo(() => getNonEmptyTaskCategories(grouped), [grouped]);
  const projectGroups = useMemo(() => groupTasksByProject(filtered), [filtered]);

  const hasContent =
    groupingMode === 'none'
      ? sortedFlat.length > 0
      : groupingMode === 'time'
        ? categories.length > 0
        : projectGroups.some((g) => g.tasks.length > 0);

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
        <TaskFiltersPopover
          open={filtersPopoverOpen}
          onOpenChange={setFiltersPopoverOpen}
          teams={teams.map((t) => ({ teamName: t.teamName, displayName: t.displayName }))}
          filters={filters}
          onFiltersChange={setFilters}
          onApply={() => {}}
        />
      </div>

      {/* Project filter */}
      <div className="shrink-0 px-2 py-1">
        <Combobox
          options={projectFilterOptions}
          value={localProjectFilter ?? ''}
          onValueChange={(v) => setLocalProjectFilter(v)}
          placeholder="All Projects"
          searchPlaceholder="Search projects..."
          emptyMessage="No projects"
          className="text-[11px]"
          resetLabel="All Projects"
          onReset={() => setLocalProjectFilter(null)}
        />
      </div>

      {/* Grouping mode — compact segmented toggle */}
      <div className="flex shrink-0 items-center gap-1.5 px-2 py-1">
        <span className="shrink-0 text-[11px] text-text-muted">Group by:</span>
        <div
          className="bg-surface-raised/60 inline-flex rounded-md p-0.5 text-[11px]"
          role="group"
          aria-label="Group by"
        >
          {(['none', 'project', 'time'] as const).map((mode) => {
            const label = mode === 'none' ? 'None' : mode === 'project' ? 'Project' : 'Time';
            return (
              <button
                key={mode}
                type="button"
                onClick={() => setGroupingMode(mode)}
                className={cn(
                  'rounded px-2 py-0.5 transition-colors',
                  groupingMode === mode
                    ? 'bg-surface-raised text-text shadow-sm'
                    : 'text-text-muted hover:text-text-secondary'
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
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

        {groupingMode === 'none' &&
          sortedFlat.map((task) => (
            <SidebarTaskItem key={`${task.teamName}-${task.id}`} task={task} showTeamName />
          ))}

        {groupingMode === 'project' &&
          projectGroups.map((group) => {
            if (group.tasks.length === 0) return null;
            let lastTeam: string | null = null;
            return (
              <div key={group.projectKey}>
                <div
                  className="sticky top-0 z-10 flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold"
                  style={{ backgroundColor: 'var(--color-surface-sidebar)' }}
                >
                  <span
                    className="inline-block size-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: projectColor(group.projectLabel).border }}
                  />
                  <span style={{ color: projectColor(group.projectLabel).text }}>
                    {group.projectLabel}
                  </span>
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
                      <SidebarTaskItem task={task} hideTeamName />
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
