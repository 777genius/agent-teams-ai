import { useEffect, useMemo, useRef, useState } from 'react';

import { useStore } from '@renderer/store';
import { getNonEmptyTaskCategories, groupTasksByDate } from '@renderer/utils/taskGrouping';
import { ListTodo, Search, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { SidebarTaskItem } from './SidebarTaskItem';

import type { GlobalTask } from '@shared/types';

type StatusFilter = 'all' | 'active' | 'done';

const filterButtons: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'done', label: 'Done' },
];

const dateCategoryLabels: Record<string, string> = {
  'Previous 7 Days': 'Last 7 Days',
  Older: 'Earlier',
};

function normalizePath(p: string): string {
  return p.endsWith('/') ? p.slice(0, -1) : p;
}

function applyFilter(tasks: GlobalTask[], filter: StatusFilter): GlobalTask[] {
  if (filter === 'all') return tasks;
  if (filter === 'active')
    return tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress');
  return tasks.filter((t) => t.status === 'completed');
}

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

export const GlobalTaskList = (): React.JSX.Element => {
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
    }))
  );

  const [filter, setFilter] = useState<StatusFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const hasFetchedRef = useRef(false);

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
    result = applyFilter(result, filter);
    result = applySearch(result, searchQuery);
    return result;
  }, [globalTasks, selectedProjectPath, filter, searchQuery]);

  const grouped = useMemo(() => groupTasksByDate(filtered), [filtered]);
  const categories = useMemo(() => getNonEmptyTaskCategories(grouped), [grouped]);

  return (
    <div className="flex h-full flex-col">
      {/* Header + Filter bar */}
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <span className="text-[12px] font-semibold text-text-secondary">Tasks</span>
        <div className="flex gap-1">
          {filterButtons.map((btn) => (
            <button
              key={btn.value}
              type="button"
              className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                filter === btn.value
                  ? 'bg-surface-raised text-text'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
              onClick={() => setFilter(btn.value)}
            >
              {btn.label}
            </button>
          ))}
        </div>
      </div>

      {/* Search bar */}
      <div
        className="flex shrink-0 items-center gap-1.5 border-b px-3 py-1"
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

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {globalTasksLoading && globalTasks.length === 0 && (
          <div className="space-y-2 p-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-[48px] animate-pulse rounded bg-surface-raised" />
            ))}
          </div>
        )}

        {!globalTasksLoading && categories.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-text-muted">
            <ListTodo className="size-8 opacity-40" />
            <span className="text-[12px]">
              {searchQuery || selectedProjectPath ? 'No matching tasks' : 'No tasks found'}
            </span>
          </div>
        )}

        {categories.map((category) => {
          const tasks = grouped[category];
          let lastTeam: string | null = null;

          return (
            <div key={category}>
              {/* Date header */}
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
