/**
 * DashboardView - Main dashboard with "Productivity Luxury" aesthetic.
 * Inspired by Linear, Vercel, and Raycast design patterns.
 * Features:
 * - Subtle spotlight gradient
 * - Centralized command search with inline project filtering
 * - Border-first project cards with minimal backgrounds
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import { getWorktreeNavigationState } from '@renderer/store/utils/stateResetHelpers';
import { formatProjectPath } from '@renderer/utils/pathDisplay';
import {
  buildTaskCountsByProject,
  normalizePath,
  type TaskStatusCounts,
} from '@renderer/utils/pathNormalize';
import { projectColor } from '@renderer/utils/projectColor';
import { formatShortcut } from '@renderer/utils/stringUtils';
import { createLogger } from '@shared/utils/logger';
import { useShallow } from 'zustand/react/shallow';

const logger = createLogger('Component:DashboardView');
import { formatDistanceToNow } from 'date-fns';
import { Command, FolderGit2, FolderOpen, GitBranch, Search, Users } from 'lucide-react';

import { CliStatusBanner } from './CliStatusBanner';

import type { RepositoryGroup } from '@renderer/types/data';

// =============================================================================
// Command Search Input
// =============================================================================

interface CommandSearchProps {
  value: string;
  onChange: (value: string) => void;
}

const CommandSearch = ({ value, onChange }: Readonly<CommandSearchProps>): React.JSX.Element => {
  const [isFocused, setIsFocused] = useState(false);
  const { openCommandPalette, selectedProjectId } = useStore(
    useShallow((s) => ({
      openCommandPalette: s.openCommandPalette,
      selectedProjectId: s.selectedProjectId,
    }))
  );

  // Handle Cmd+K to open full command palette
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        openCommandPalette();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [openCommandPalette]);

  return (
    <div className="relative w-full">
      {/* Search container with glow effect on focus */}
      <div
        className={`relative flex items-center gap-3 rounded-sm border bg-surface-raised px-4 py-3 transition-all duration-200 ${
          isFocused
            ? 'border-zinc-500 shadow-[0_0_20px_rgba(255,255,255,0.04)] ring-1 ring-zinc-600/30'
            : 'border-border hover:border-zinc-600'
        } `}
      >
        <Search className="size-4 shrink-0 text-text-muted" />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search projects..."
          className="flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-muted"
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
        />
        {/* Keyboard shortcut badge - opens full command palette */}
        <button
          onClick={() => openCommandPalette()}
          className="flex shrink-0 items-center gap-1 transition-opacity hover:opacity-80"
          title={
            selectedProjectId
              ? `Search in sessions (${formatShortcut('K')})`
              : `Search projects (${formatShortcut('K')})`
          }
        >
          <kbd className="flex h-5 items-center justify-center rounded border border-border bg-surface-overlay px-1.5 text-[10px] font-medium text-text-muted">
            <Command className="size-2.5" />
          </kbd>
          <kbd className="flex size-5 items-center justify-center rounded border border-border bg-surface-overlay text-[10px] font-medium text-text-muted">
            K
          </kbd>
        </button>
      </div>
    </div>
  );
};

// =============================================================================
// Repository Card
// =============================================================================

interface RepositoryCardProps {
  repo: RepositoryGroup;
  onClick: () => void;
  isHighlighted?: boolean;
  taskCounts?: TaskStatusCounts;
  tasksLoading?: boolean;
}

const RepositoryCard = ({
  repo,
  onClick,
  isHighlighted,
  taskCounts,
  tasksLoading,
}: Readonly<RepositoryCardProps>): React.JSX.Element => {
  const lastActivity = repo.mostRecentSession
    ? formatDistanceToNow(new Date(repo.mostRecentSession), { addSuffix: true })
    : 'No recent activity';

  const worktreeCount = repo.worktrees.length;
  const hasMultipleWorktrees = worktreeCount > 1;

  // Get the path from the first worktree
  const projectPath = repo.worktrees[0]?.path || '';
  const formattedPath = formatProjectPath(projectPath);

  // Git branch info from worktrees
  const mainWorktree = repo.worktrees.find((w) => w.isMainWorktree) ?? repo.worktrees[0];
  const mainBranch = mainWorktree?.gitBranch;

  const color = useMemo(() => projectColor(repo.name), [repo.name]);
  const cardRef = useRef<HTMLButtonElement>(null);
  const [isHovered, setIsHovered] = useState(false);

  const handleOpenPath = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (projectPath) {
        void api.openPath(projectPath, projectPath);
      }
    },
    [projectPath]
  );

  return (
    <button
      ref={cardRef}
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={`group relative flex min-h-[120px] flex-col overflow-hidden rounded-lg border border-l-[3px] p-4 text-left transition-all duration-300 ${
        isHighlighted
          ? 'border-border-emphasis bg-surface-raised'
          : 'bg-surface/50 border-border hover:border-border-emphasis hover:bg-surface-raised'
      } `}
      style={{
        borderLeftColor: color.border,
        boxShadow: isHovered ? `inset 3px 0 12px -4px ${color.glow}` : undefined,
      }}
    >
      {/* Icon + Project name */}
      <div className="mb-1 flex items-center gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-overlay transition-colors duration-300 group-hover:border-border-emphasis">
          <FolderGit2
            className="size-4 transition-colors group-hover:text-text"
            style={{ color: color.icon }}
          />
        </div>
        <h3 className="min-w-0 truncate text-sm font-medium text-text transition-colors duration-200 group-hover:text-text">
          {repo.name}
        </h3>
      </div>

      {/* Project path - monospace, muted, clickable to open in file manager */}
      <div
        role="button"
        tabIndex={0}
        onClick={handleOpenPath}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') handleOpenPath(e as unknown as React.MouseEvent);
        }}
        className="flex w-full min-w-0 cursor-pointer items-center gap-1 truncate text-left font-mono text-[10px] text-text-muted transition-colors hover:text-text-secondary"
        title={`Open in file manager: ${projectPath}`}
      >
        <FolderOpen className="size-3 shrink-0" />
        <span className="truncate">{formattedPath}</span>
      </div>

      {/* Git branch / worktree info */}
      {mainBranch ? (
        <div className="mb-auto mt-1 flex items-center gap-1.5 truncate">
          <GitBranch className="size-3 shrink-0 text-text-muted" />
          <span className="truncate text-[10px] text-text-secondary">{mainBranch}</span>
          {hasMultipleWorktrees && (
            <span className="shrink-0 rounded bg-surface-raised px-1 py-px text-[9px] text-text-muted">
              +{worktreeCount - 1}
            </span>
          )}
        </div>
      ) : (
        <div className="mb-auto" />
      )}

      {/* Meta row: worktrees, sessions, time */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {hasMultipleWorktrees && (
          <span className="inline-flex items-center gap-1 text-[10px] text-text-secondary">
            <GitBranch className="size-3" />
            {worktreeCount} worktrees
          </span>
        )}
        <span className="text-[10px] text-text-secondary">{repo.totalSessions} sessions</span>
        {taskCounts &&
          (taskCounts.pending > 0 || taskCounts.inProgress > 0 || taskCounts.completed > 0) && (
            <>
              <span className="text-text-muted">·</span>
              {taskCounts.inProgress > 0 && (
                <span className="inline-flex items-center rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-400">
                  {taskCounts.inProgress} active
                </span>
              )}
              {taskCounts.pending > 0 && (
                <span className="inline-flex items-center rounded-full bg-yellow-500/15 px-1.5 py-0.5 text-[10px] font-medium text-yellow-400">
                  {taskCounts.pending} pending
                </span>
              )}
              {taskCounts.completed > 0 && (
                <span className="inline-flex items-center rounded-full bg-green-500/15 px-1.5 py-0.5 text-[10px] font-medium text-green-400">
                  {taskCounts.completed} done
                </span>
              )}
            </>
          )}
        <span className="text-text-muted">·</span>
        <span className="text-[10px] text-text-muted">{lastActivity}</span>
      </div>

      {/* Tasks progress bar */}
      {tasksLoading ? (
        <div className="mt-2 w-full">
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 animate-pulse overflow-hidden rounded-full bg-[var(--color-surface-raised)]" />
            <div className="h-2.5 w-6 animate-pulse rounded bg-[var(--color-surface-raised)]" />
          </div>
        </div>
      ) : (
        taskCounts &&
        (() => {
          const pending = taskCounts.pending ?? 0;
          const inProgress = taskCounts.inProgress ?? 0;
          const completed = taskCounts.completed ?? 0;
          const totalTasks = pending + inProgress + completed;
          if (totalTasks === 0) return null;
          const completedRatio = completed / totalTasks;
          const progressPercent = Math.round(completedRatio * 100);
          return (
            <div className="mt-2 w-full space-y-1">
              <div className="flex items-center gap-2">
                <div
                  className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-raised)]"
                  role="progressbar"
                  aria-valuenow={completed}
                  aria-valuemin={0}
                  aria-valuemax={totalTasks}
                  aria-label={`Tasks ${completed}/${totalTasks} completed`}
                >
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all duration-200"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <span className="shrink-0 text-[10px] font-medium tracking-tight text-[var(--color-text-muted)]">
                  {completed}/{totalTasks}
                </span>
              </div>
            </div>
          );
        })()
      )}
    </button>
  );
};

// =============================================================================
// Ghost Card (New Project)
// =============================================================================

interface WorktreeMatch {
  repoId: string;
  worktreeId: string;
}

function findMatchingWorktree(
  groups: RepositoryGroup[],
  selectedPath: string
): WorktreeMatch | null {
  const norm = normalizePath(selectedPath);
  for (const repo of groups) {
    for (const worktree of repo.worktrees) {
      if (normalizePath(worktree.path) === norm) {
        return { repoId: repo.id, worktreeId: worktree.id };
      }
    }
  }
  return null;
}

const NewProjectCard = (): React.JSX.Element => {
  const { repositoryGroups, fetchRepositoryGroups } = useStore(
    useShallow((s) => ({
      repositoryGroups: s.repositoryGroups,
      fetchRepositoryGroups: s.fetchRepositoryGroups,
    }))
  );

  const navigateToMatch = (match: WorktreeMatch): void => {
    useStore.setState(getWorktreeNavigationState(match.repoId, match.worktreeId));
    void useStore.getState().fetchSessionsInitial(match.worktreeId);
  };

  const handleClick = async (): Promise<void> => {
    try {
      const selectedPaths = await api.config.selectFolders();
      if (!selectedPaths || selectedPaths.length === 0) {
        return; // User cancelled
      }

      const selectedPath = selectedPaths[0];

      // Match selected path against known repository worktrees (normalized comparison)
      const match = findMatchingWorktree(repositoryGroups, selectedPath);
      if (match) {
        navigateToMatch(match);
        return;
      }

      // No match — refresh repository groups and retry
      await fetchRepositoryGroups();
      const refreshedGroups = useStore.getState().repositoryGroups;
      const matchAfterRefresh = findMatchingWorktree(refreshedGroups, selectedPath);
      if (matchAfterRefresh) {
        navigateToMatch(matchAfterRefresh);
        return;
      }

      // Still no match — create a synthetic group for this new folder and navigate to it.
      // This allows launching teams in projects that don't have Claude sessions yet.
      const encodedId = selectedPath.replace(/[/\\]/g, '-');
      const folderName = selectedPath.split(/[/\\]/).filter(Boolean).pop() ?? selectedPath;
      const now = Date.now();

      const syntheticGroup: RepositoryGroup = {
        id: encodedId,
        identity: null,
        worktrees: [
          {
            id: encodedId,
            path: selectedPath,
            name: folderName,
            isMainWorktree: true,
            source: 'unknown',
            sessions: [],
            createdAt: now,
          },
        ],
        name: folderName,
        mostRecentSession: undefined,
        totalSessions: 0,
      };

      useStore.setState((state) => ({
        repositoryGroups: [syntheticGroup, ...state.repositoryGroups],
      }));
      navigateToMatch({ repoId: encodedId, worktreeId: encodedId });
    } catch (error) {
      logger.error('Error selecting folder:', error);
    }
  };

  return (
    <button
      className="hover:bg-surface/30 group relative flex min-h-[120px] flex-col items-center justify-center rounded-lg border border-dashed border-border bg-transparent p-4 transition-all duration-300 hover:border-border-emphasis"
      onClick={handleClick}
      title="Select a project folder"
    >
      <div className="mb-2 flex size-8 items-center justify-center rounded-md border border-dashed border-border transition-colors duration-300 group-hover:border-border-emphasis">
        <FolderOpen className="size-4 text-text-muted transition-colors group-hover:text-text-secondary" />
      </div>
      <span className="text-xs text-text-muted transition-colors group-hover:text-text-secondary">
        Select Folder
      </span>
    </button>
  );
};

// =============================================================================
// Projects Grid
// =============================================================================

interface ProjectsGridProps {
  searchQuery: string;
  maxProjects?: number;
}

const ProjectsGrid = ({
  searchQuery,
  maxProjects = 12,
}: Readonly<ProjectsGridProps>): React.JSX.Element => {
  const {
    repositoryGroups,
    repositoryGroupsLoading,
    fetchRepositoryGroups,
    selectRepository,
    globalTasks,
    globalTasksLoading,
    fetchAllTasks,
    openTeamsTab,
  } = useStore(
    useShallow((s) => ({
      repositoryGroups: s.repositoryGroups,
      repositoryGroupsLoading: s.repositoryGroupsLoading,
      fetchRepositoryGroups: s.fetchRepositoryGroups,
      selectRepository: s.selectRepository,
      globalTasks: s.globalTasks,
      globalTasksLoading: s.globalTasksLoading,
      fetchAllTasks: s.fetchAllTasks,
      openTeamsTab: s.openTeamsTab,
    }))
  );

  const hasFetchedTasksRef = React.useRef(false);

  useEffect(() => {
    if (repositoryGroups.length === 0) {
      void fetchRepositoryGroups();
    }
    if (!hasFetchedTasksRef.current) {
      hasFetchedTasksRef.current = true;
      void fetchAllTasks();
    }
  }, [repositoryGroups.length, fetchRepositoryGroups, fetchAllTasks]);

  const taskCountsMap = useMemo(() => buildTaskCountsByProject(globalTasks), [globalTasks]);

  // Filter projects based on search query
  const filteredRepos = useMemo(() => {
    if (!searchQuery.trim()) {
      return repositoryGroups.slice(0, maxProjects);
    }

    const query = searchQuery.toLowerCase().trim();
    return repositoryGroups
      .filter((repo) => {
        // Match by name
        if (repo.name.toLowerCase().includes(query)) return true;
        // Match by path
        const path = repo.worktrees[0]?.path || '';
        if (path.toLowerCase().includes(query)) return true;
        return false;
      })
      .slice(0, maxProjects);
  }, [repositoryGroups, searchQuery, maxProjects]);

  if (repositoryGroupsLoading) {
    // Organic widths per card — no repeating stamp
    const titleWidths = [60, 66, 50, 55, 75, 45, 40, 65];
    const pathWidths = [80, 75, 85, 66, 70, 80, 60, 72];

    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="skeleton-card flex min-h-[120px] flex-col rounded-sm border border-border p-4"
            style={{
              animationDelay: `${i * 80}ms`,
              backgroundColor: 'var(--skeleton-base)',
            }}
          >
            {/* Icon placeholder */}
            <div
              className="mb-3 size-8 rounded-sm"
              style={{ backgroundColor: 'var(--skeleton-base-light)' }}
            />
            {/* Title placeholder */}
            <div
              className="mb-2 h-3.5 rounded-sm"
              style={{
                width: `${titleWidths[i]}%`,
                backgroundColor: 'var(--skeleton-base-light)',
              }}
            />
            {/* Path placeholder */}
            <div
              className="mb-auto h-2.5 rounded-sm"
              style={{
                width: `${pathWidths[i]}%`,
                backgroundColor: 'var(--skeleton-base-dim)',
              }}
            />
            {/* Meta row placeholder */}
            <div className="mt-3 flex gap-2">
              <div
                className="h-2.5 w-16 rounded-sm"
                style={{ backgroundColor: 'var(--skeleton-base-dim)' }}
              />
              <div
                className="h-2.5 w-12 rounded-sm"
                style={{ backgroundColor: 'var(--skeleton-base-dim)' }}
              />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (filteredRepos.length === 0 && searchQuery.trim()) {
    return (
      <div className="flex flex-col items-center justify-center rounded-sm border border-dashed border-border px-8 py-16">
        <div className="mb-4 flex size-12 items-center justify-center rounded-sm border border-border bg-surface-raised">
          <Search className="size-6 text-text-muted" />
        </div>
        <p className="mb-1 text-sm text-text-secondary">No projects found</p>
        <p className="text-xs text-text-muted">No matches for &quot;{searchQuery}&quot;</p>
      </div>
    );
  }

  if (repositoryGroups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-sm border border-dashed border-border px-8 py-16">
        <div className="mb-4 flex size-12 items-center justify-center rounded-sm border border-border bg-surface-raised">
          <FolderGit2 className="size-6 text-text-muted" />
        </div>
        <p className="mb-1 text-sm text-text-secondary">No projects found</p>
        <p className="font-mono text-xs text-text-muted">~/.claude/projects/</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4">
      {filteredRepos.map((repo) => {
        const counts = repo.worktrees.reduce(
          (acc, wt) => {
            const c = taskCountsMap.get(normalizePath(wt.path));
            if (c) {
              acc.pending += c.pending;
              acc.inProgress += c.inProgress;
              acc.completed += c.completed;
            }
            return acc;
          },
          { pending: 0, inProgress: 0, completed: 0 }
        );
        return (
          <RepositoryCard
            key={repo.id}
            repo={repo}
            onClick={() => {
              selectRepository(repo.id);
              openTeamsTab();
            }}
            isHighlighted={!!searchQuery.trim()}
            taskCounts={globalTasksLoading ? undefined : counts}
            tasksLoading={globalTasksLoading}
          />
        );
      })}
      {!searchQuery.trim() && <NewProjectCard />}
    </div>
  );
};

// =============================================================================
// Dashboard View
// =============================================================================

export const DashboardView = (): React.JSX.Element => {
  const [searchQuery, setSearchQuery] = useState('');
  const openTeamsTab = useStore((s) => s.openTeamsTab);

  return (
    <div className="relative flex-1 overflow-auto bg-surface">
      {/* Spotlight gradient background */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[600px] bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(99,102,241,0.08),transparent)]"
        aria-hidden="true"
      />

      {/* Content */}
      <div className="relative mx-auto max-w-5xl px-8 py-12">
        {/* CLI Status Banner */}
        <CliStatusBanner />

        {/* Team select + Search */}
        <div className="mb-12 flex items-center justify-center gap-3">
          <button
            onClick={openTeamsTab}
            className="flex shrink-0 items-center gap-2 rounded-sm border border-border bg-surface-raised px-4 py-3 text-sm text-text-secondary transition-all duration-200 hover:border-zinc-500 hover:text-text"
          >
            <Users className="size-4" />
            Select Team
          </button>
          <span className="shrink-0 text-xs text-text-muted">or</span>
          <div className="flex-1">
            <CommandSearch value={searchQuery} onChange={setSearchQuery} />
          </div>
        </div>

        {/* Section header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xs font-medium uppercase tracking-wider text-text-muted">
            {searchQuery.trim() ? 'Search Results' : 'Recent Projects'}
          </h2>
          {searchQuery.trim() && (
            <button
              onClick={() => setSearchQuery('')}
              className="text-xs text-text-muted transition-colors hover:text-text-secondary"
            >
              Clear search
            </button>
          )}
        </div>

        {/* Projects Grid */}
        <ProjectsGrid searchQuery={searchQuery} />
      </div>
    </div>
  );
};
