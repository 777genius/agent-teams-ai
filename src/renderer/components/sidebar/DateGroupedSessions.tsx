/**
 * DateGroupedSessions - Sessions organized by date categories with virtual scrolling.
 * Uses @tanstack/react-virtual for efficient DOM rendering with infinite scroll.
 * Supports multi-select with bulk actions and hidden session filtering.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import {
  getNonEmptyCategories,
  groupSessionsByDate,
  separatePinnedSessions,
} from '@renderer/utils/dateGrouping';
import { truncateMiddle } from '@renderer/utils/stringUtils';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowDownWideNarrow,
  Calendar,
  Check,
  CheckSquare,
  ChevronDown,
  Eye,
  EyeOff,
  GitBranch,
  Loader2,
  MessageSquareOff,
  Pin,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { WorktreeBadge } from '../common/WorktreeBadge';
import { Combobox, type ComboboxOption } from '../ui/combobox';

import { SessionItem } from './SessionItem';

import type { Session, Worktree, WorktreeSource } from '@renderer/types/data';
import type { DateCategory } from '@renderer/types/tabs';

// ---------------------------------------------------------------------------
// Worktree grouping helpers (moved from SidebarHeader)
// ---------------------------------------------------------------------------

interface WorktreeGroup {
  source: WorktreeSource;
  label: string;
  worktrees: Worktree[];
  mostRecent: number;
}

const SOURCE_LABELS: Record<WorktreeSource, string> = {
  'vibe-kanban': 'Vibe Kanban',
  conductor: 'Conductor',
  'auto-claude': 'Auto Claude',
  '21st': '21st',
  'claude-desktop': 'Claude Desktop',
  'claude-code': 'Claude Code',
  ccswitch: 'ccswitch',
  git: 'Git',
  unknown: 'Other',
};

function groupWorktreesBySource(worktrees: Worktree[]): {
  mainWorktree: Worktree | null;
  groups: WorktreeGroup[];
} {
  const mainWorktree = worktrees.find((w) => w.isMainWorktree) ?? null;
  const groupMap = new Map<WorktreeSource, Worktree[]>();

  for (const wt of worktrees) {
    if (wt.isMainWorktree) continue;
    const existing = groupMap.get(wt.source) ?? [];
    existing.push(wt);
    groupMap.set(wt.source, existing);
  }

  const groups: WorktreeGroup[] = [];
  for (const [source, wts] of groupMap) {
    const sorted = [...wts].sort((a, b) => (b.mostRecentSession ?? 0) - (a.mostRecentSession ?? 0));
    const mostRecent = Math.max(...sorted.map((w) => w.mostRecentSession ?? 0));
    groups.push({ source, label: SOURCE_LABELS[source] ?? source, worktrees: sorted, mostRecent });
  }
  groups.sort((a, b) => b.mostRecent - a.mostRecent);
  return { mainWorktree, groups };
}

// ---------------------------------------------------------------------------
// WorktreeItem (inline, moved from SidebarHeader)
// ---------------------------------------------------------------------------

const WorktreeItem = ({
  worktree,
  isSelected,
  onSelect,
}: {
  worktree: Worktree;
  isSelected: boolean;
  onSelect: () => void;
}): React.JSX.Element => {
  const [isHovered, setIsHovered] = useState(false);

  const buttonStyle: React.CSSProperties = isSelected
    ? { backgroundColor: 'var(--color-surface-raised)', color: 'var(--color-text)' }
    : {
        backgroundColor: isHovered ? 'var(--color-surface-raised)' : 'transparent',
        opacity: isHovered ? 0.5 : 1,
      };

  return (
    <button
      onClick={onSelect}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="flex w-full items-center gap-1.5 px-4 py-1.5 text-left transition-colors"
      style={buttonStyle}
    >
      <GitBranch
        className="size-3.5 shrink-0"
        style={{ color: isSelected ? '#34d399' : 'var(--color-text-muted)' }}
      />
      {worktree.isMainWorktree && <WorktreeBadge source={worktree.source} isMain />}
      <span
        className="flex-1 truncate font-mono text-xs"
        style={{ color: isSelected ? 'var(--color-text)' : 'var(--color-text-muted)' }}
      >
        {truncateMiddle(worktree.name, 28)}
      </span>
      <span className="shrink-0 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
        {worktree.totalSessions ?? worktree.sessions.length}
      </span>
      {isSelected && <Check className="size-3.5 shrink-0 text-indigo-400" />}
    </button>
  );
};

// Virtual list item types
type VirtualItem =
  | { type: 'header'; category: DateCategory; id: string }
  | { type: 'pinned-header'; id: string }
  | { type: 'session'; session: Session; isPinned: boolean; isHidden: boolean; id: string }
  | { type: 'loader'; id: string };

/**
 * Item height constants for virtual scroll positioning.
 * CRITICAL: These values MUST match the actual rendered heights of components.
 * If SessionItem height changes, update SESSION_HEIGHT here AND add h-[Xpx] to SessionItem.
 * Mismatch causes items to overlap!
 */
const HEADER_HEIGHT = 28;
const SESSION_HEIGHT = 54; // Must match h-[54px] in SessionItem.tsx
const LOADER_HEIGHT = 36;
const OVERSCAN = 5;

export const DateGroupedSessions = (): React.JSX.Element => {
  const {
    sessions,
    selectedSessionId,
    selectedProjectId,
    sessionsLoading,
    sessionsError,
    sessionsHasMore,
    sessionsLoadingMore,
    fetchSessionsMore,
    pinnedSessionIds,
    sessionSortMode,
    setSessionSortMode,
    hiddenSessionIds,
    showHiddenSessions,
    toggleShowHiddenSessions,
    sidebarSelectedSessionIds,
    sidebarMultiSelectActive,
    toggleSidebarSessionSelection,
    clearSidebarSelection,
    toggleSidebarMultiSelect,
    hideMultipleSessions,
    unhideMultipleSessions,
    pinMultipleSessions,
    // Project / repository state
    repositoryGroups,
    selectedRepositoryId,
    selectedWorktreeId,
    selectWorktree,
    selectRepository,
    viewMode,
    projects,
    activeProjectId,
    setActiveProject,
    clearActiveProject,
    fetchRepositoryGroups,
    fetchProjects,
  } = useStore(
    useShallow((s) => ({
      sessions: s.sessions,
      selectedSessionId: s.selectedSessionId,
      selectedProjectId: s.selectedProjectId,
      sessionsLoading: s.sessionsLoading,
      sessionsError: s.sessionsError,
      sessionsHasMore: s.sessionsHasMore,
      sessionsLoadingMore: s.sessionsLoadingMore,
      fetchSessionsMore: s.fetchSessionsMore,
      pinnedSessionIds: s.pinnedSessionIds,
      sessionSortMode: s.sessionSortMode,
      setSessionSortMode: s.setSessionSortMode,
      hiddenSessionIds: s.hiddenSessionIds,
      showHiddenSessions: s.showHiddenSessions,
      toggleShowHiddenSessions: s.toggleShowHiddenSessions,
      sidebarSelectedSessionIds: s.sidebarSelectedSessionIds,
      sidebarMultiSelectActive: s.sidebarMultiSelectActive,
      toggleSidebarSessionSelection: s.toggleSidebarSessionSelection,
      clearSidebarSelection: s.clearSidebarSelection,
      toggleSidebarMultiSelect: s.toggleSidebarMultiSelect,
      hideMultipleSessions: s.hideMultipleSessions,
      unhideMultipleSessions: s.unhideMultipleSessions,
      pinMultipleSessions: s.pinMultipleSessions,
      // Project / repository
      repositoryGroups: s.repositoryGroups,
      selectedRepositoryId: s.selectedRepositoryId,
      selectedWorktreeId: s.selectedWorktreeId,
      selectWorktree: s.selectWorktree,
      selectRepository: s.selectRepository,
      viewMode: s.viewMode,
      projects: s.projects,
      activeProjectId: s.activeProjectId,
      setActiveProject: s.setActiveProject,
      clearActiveProject: s.clearActiveProject,
      fetchRepositoryGroups: s.fetchRepositoryGroups,
      fetchProjects: s.fetchProjects,
    }))
  );

  const parentRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLSpanElement>(null);
  const [showCountTooltip, setShowCountTooltip] = useState(false);
  const [isWorktreeDropdownOpen, setIsWorktreeDropdownOpen] = useState(false);
  const worktreeDropdownRef = useRef<HTMLDivElement>(null);

  // Fetch project data on mount or when viewMode changes.
  // Loading guards in the store actions prevent duplicate IPC calls
  // when the centralized init chain has already started a fetch.
  const repositoryGroupsLoading = useStore((s) => s.repositoryGroupsLoading);
  const repositoryGroupsError = useStore((s) => s.repositoryGroupsError);
  const projectsLoading = useStore((s) => s.projectsLoading);
  const projectsError = useStore((s) => s.projectsError);
  useEffect(() => {
    if (
      viewMode === 'grouped' &&
      repositoryGroups.length === 0 &&
      !repositoryGroupsLoading &&
      !repositoryGroupsError
    ) {
      void fetchRepositoryGroups();
    } else if (viewMode === 'flat' && projects.length === 0 && !projectsLoading && !projectsError) {
      void fetchProjects();
    }
  }, [
    viewMode,
    repositoryGroups.length,
    projects.length,
    repositoryGroupsLoading,
    repositoryGroupsError,
    projectsLoading,
    projectsError,
    fetchRepositoryGroups,
    fetchProjects,
  ]);

  // Project combobox options
  const projectComboboxOptions = useMemo((): ComboboxOption[] => {
    const items =
      viewMode === 'grouped'
        ? repositoryGroups.filter((r) => r.totalSessions > 0)
        : projects.filter((p) => (p.totalSessions ?? p.sessions.length) > 0);
    return items.map((item) => {
      const sessionCount =
        viewMode === 'grouped'
          ? (item as (typeof repositoryGroups)[0]).totalSessions
          : ((item as (typeof projects)[0]).totalSessions ??
            (item as (typeof projects)[0]).sessions.length);
      const path =
        viewMode === 'grouped'
          ? (item as (typeof repositoryGroups)[0]).worktrees[0]?.path
          : (item as (typeof projects)[0]).path;
      return {
        value: item.id,
        label: item.name,
        description: path,
        meta: { sessionCount, path },
      };
    });
  }, [viewMode, repositoryGroups, projects]);

  const activeProjectValue = viewMode === 'grouped' ? selectedRepositoryId : activeProjectId;

  const handleProjectValueChange = (id: string): void => {
    if (viewMode === 'grouped') selectRepository(id);
    else setActiveProject(id);
  };

  // Worktree state
  const activeRepo = repositoryGroups.find((r) => r.id === selectedRepositoryId);
  const activeWorktree = activeRepo?.worktrees.find((w) => w.id === selectedWorktreeId);
  const worktrees = (activeRepo?.worktrees ?? []).filter(
    (w) => (w.totalSessions ?? w.sessions.length) > 0
  );
  const hasMultipleWorktrees = worktrees.length > 1;
  const worktreeGroupingResult = useMemo(() => groupWorktreesBySource(worktrees), [worktrees]);
  const mainWorktree = worktreeGroupingResult.mainWorktree;
  const worktreeGroups = worktreeGroupingResult.groups;
  const worktreeName = activeWorktree?.name ?? 'main';

  const handleSelectWorktree = (worktree: Worktree): void => {
    selectWorktree(worktree.id);
    setIsWorktreeDropdownOpen(false);
  };

  const hiddenSet = useMemo(() => new Set(hiddenSessionIds), [hiddenSessionIds]);
  const hasHiddenSessions = hiddenSessionIds.length > 0;

  // Filter out hidden sessions unless showHiddenSessions is on
  const visibleSessions = useMemo(() => {
    if (showHiddenSessions) return sessions;
    return sessions.filter((s) => !hiddenSet.has(s.id));
  }, [sessions, hiddenSet, showHiddenSessions]);

  // Separate pinned sessions from unpinned
  const { pinned: pinnedSessions, unpinned: unpinnedSessions } = useMemo(
    () => separatePinnedSessions(visibleSessions, pinnedSessionIds),
    [visibleSessions, pinnedSessionIds]
  );

  // Group only unpinned sessions by date
  const groupedSessions = useMemo(() => groupSessionsByDate(unpinnedSessions), [unpinnedSessions]);

  // Get non-empty categories in display order
  const nonEmptyCategories = useMemo(
    () => getNonEmptyCategories(groupedSessions),
    [groupedSessions]
  );

  // Sessions sorted by context consumption (for most-context sort mode)
  const contextSortedSessions = useMemo(() => {
    if (sessionSortMode !== 'most-context') return [];
    return [...visibleSessions].sort(
      (a, b) => (b.contextConsumption ?? 0) - (a.contextConsumption ?? 0)
    );
  }, [visibleSessions, sessionSortMode]);

  // Flatten sessions with date headers into virtual list items
  const virtualItems = useMemo((): VirtualItem[] => {
    const items: VirtualItem[] = [];

    if (sessionSortMode === 'most-context') {
      // Flat list sorted by consumption - no date headers, no pinned section
      for (const session of contextSortedSessions) {
        items.push({
          type: 'session',
          session,
          isPinned: pinnedSessionIds.includes(session.id),
          isHidden: hiddenSet.has(session.id),
          id: `session-${session.id}`,
        });
      }
    } else {
      // Default: date-grouped view with pinned section
      if (pinnedSessions.length > 0) {
        items.push({
          type: 'pinned-header',
          id: 'header-pinned',
        });

        for (const session of pinnedSessions) {
          items.push({
            type: 'session',
            session,
            isPinned: true,
            isHidden: hiddenSet.has(session.id),
            id: `session-${session.id}`,
          });
        }
      }

      for (const category of nonEmptyCategories) {
        items.push({
          type: 'header',
          category,
          id: `header-${category}`,
        });

        for (const session of groupedSessions[category]) {
          items.push({
            type: 'session',
            session,
            isPinned: false,
            isHidden: hiddenSet.has(session.id),
            id: `session-${session.id}`,
          });
        }
      }
    }

    // Add loader item if there are more sessions to load
    if (sessionsHasMore) {
      items.push({
        type: 'loader',
        id: 'loader',
      });
    }

    return items;
  }, [
    sessionSortMode,
    contextSortedSessions,
    pinnedSessionIds,
    hiddenSet,
    pinnedSessions,
    nonEmptyCategories,
    groupedSessions,
    sessionsHasMore,
  ]);

  // Estimate item size based on type
  const estimateSize = useCallback(
    (index: number) => {
      const item = virtualItems[index];
      if (!item) return SESSION_HEIGHT;

      switch (item.type) {
        case 'header':
        case 'pinned-header':
          return HEADER_HEIGHT;
        case 'loader':
          return LOADER_HEIGHT;
        case 'session':
        default:
          return SESSION_HEIGHT;
      }
    },
    [virtualItems]
  );

  // Set up virtualizer
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual API limitation, not fixable in user code
  const rowVirtualizer = useVirtualizer({
    count: virtualItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize,
    overscan: OVERSCAN,
  });

  // Get virtual items for dependency tracking
  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualRowsLength = virtualRows.length;

  // Load more when scrolling near end
  useEffect(() => {
    if (virtualRowsLength === 0) return;

    const lastItem = virtualRows[virtualRowsLength - 1];
    if (!lastItem) return;

    // If we're within 3 items of the end and there's more to load, fetch more
    if (
      lastItem.index >= virtualItems.length - 3 &&
      sessionsHasMore &&
      !sessionsLoadingMore &&
      !sessionsLoading
    ) {
      void fetchSessionsMore();
    }
  }, [
    virtualRows,
    virtualRowsLength,
    virtualItems.length,
    sessionsHasMore,
    sessionsLoadingMore,
    sessionsLoading,
    fetchSessionsMore,
  ]);

  // Bulk action helpers
  const selectedSet = useMemo(
    () => new Set(sidebarSelectedSessionIds),
    [sidebarSelectedSessionIds]
  );
  const someSelectedAreHidden = useMemo(
    () => sidebarSelectedSessionIds.some((id) => hiddenSet.has(id)),
    [sidebarSelectedSessionIds, hiddenSet]
  );

  const handleBulkHide = useCallback(() => {
    void hideMultipleSessions(sidebarSelectedSessionIds);
    clearSidebarSelection();
  }, [hideMultipleSessions, sidebarSelectedSessionIds, clearSidebarSelection]);

  const handleBulkUnhide = useCallback(() => {
    const hiddenSelected = sidebarSelectedSessionIds.filter((id) => hiddenSet.has(id));
    void unhideMultipleSessions(hiddenSelected);
    clearSidebarSelection();
  }, [unhideMultipleSessions, sidebarSelectedSessionIds, hiddenSet, clearSidebarSelection]);

  const handleBulkPin = useCallback(() => {
    void pinMultipleSessions(sidebarSelectedSessionIds);
    clearSidebarSelection();
  }, [pinMultipleSessions, sidebarSelectedSessionIds, clearSidebarSelection]);

  // Project selector (always rendered at top)
  const projectSelector = (
    <div className="shrink-0 space-y-0">
      {/* Project combobox */}
      <div className="px-2 py-1.5">
        <Combobox
          options={projectComboboxOptions}
          value={activeProjectValue ?? ''}
          onValueChange={handleProjectValueChange}
          placeholder="Select Project"
          searchPlaceholder="Search..."
          emptyMessage="Nothing found"
          className="text-[12px]"
          resetLabel="Reset selection"
          onReset={clearActiveProject}
          renderOption={(option, isSelected) => {
            const sessionCount = (option.meta?.sessionCount as number) ?? 0;
            const path = option.meta?.path as string | undefined;
            return (
              <>
                <Check
                  className={cn(
                    'mr-2 size-3.5 shrink-0',
                    isSelected ? 'text-indigo-400 opacity-100' : 'opacity-0'
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      'truncate',
                      isSelected
                        ? 'font-medium text-[var(--color-text)]'
                        : 'text-[var(--color-text-muted)]'
                    )}
                  >
                    {option.label}
                  </p>
                  {path ? (
                    <p className="truncate text-[10px] text-[var(--color-text-muted)]">{path}</p>
                  ) : null}
                </div>
                <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                  {sessionCount}
                </span>
              </>
            );
          }}
        />
      </div>

      {/* Worktree selector (grouped mode only, when multiple worktrees) */}
      {viewMode === 'grouped' && activeRepo && hasMultipleWorktrees && (
        <div ref={worktreeDropdownRef} className="relative w-full">
          <button
            onClick={() => setIsWorktreeDropdownOpen(!isWorktreeDropdownOpen)}
            className="flex w-full items-center justify-between px-3 py-1 text-left transition-colors"
            style={{
              backgroundColor: isWorktreeDropdownOpen
                ? 'var(--color-surface-raised)'
                : 'transparent',
              color: isWorktreeDropdownOpen ? 'var(--color-text)' : 'var(--color-text-muted)',
            }}
          >
            <div className="flex flex-1 items-center gap-1.5 overflow-hidden">
              <GitBranch
                className="size-3.5 shrink-0"
                style={{ color: isWorktreeDropdownOpen ? '#34d399' : 'rgba(52, 211, 153, 0.7)' }}
              />
              {activeWorktree?.isMainWorktree ? (
                <WorktreeBadge source={activeWorktree.source} isMain />
              ) : (
                activeWorktree?.source && <WorktreeBadge source={activeWorktree.source} />
              )}
              <span className="truncate font-mono text-[11px]">
                {truncateMiddle(worktreeName, 24)}
              </span>
            </div>
            <ChevronDown
              className={`size-3.5 shrink-0 transition-transform ${isWorktreeDropdownOpen ? 'rotate-180' : ''}`}
              style={{ color: 'var(--color-text-muted)' }}
            />
          </button>

          {isWorktreeDropdownOpen && (
            <>
              <div
                role="presentation"
                className="fixed inset-0 z-10"
                onClick={() => setIsWorktreeDropdownOpen(false)}
              />
              <div
                className="absolute inset-x-0 top-full z-20 mt-0 max-h-[300px] overflow-y-auto py-1 shadow-xl"
                style={{
                  backgroundColor: 'var(--color-surface-sidebar)',
                  borderWidth: '1px',
                  borderTopWidth: '0',
                  borderStyle: 'solid',
                  borderColor: 'var(--color-border)',
                }}
              >
                <div
                  className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  Switch Worktree
                </div>
                {mainWorktree && (
                  <WorktreeItem
                    worktree={mainWorktree}
                    isSelected={mainWorktree.id === selectedWorktreeId}
                    onSelect={() => handleSelectWorktree(mainWorktree)}
                  />
                )}
                {worktreeGroups.map((group) => (
                  <div key={group.source}>
                    <div
                      className="mt-1 px-4 py-1.5 text-[9px] font-medium uppercase tracking-wider"
                      style={{
                        borderTopWidth: '1px',
                        borderTopStyle: 'solid',
                        borderTopColor: 'var(--color-border)',
                        color: 'var(--color-text-muted)',
                      }}
                    >
                      {group.label}
                    </div>
                    {group.worktrees.map((worktree) => (
                      <WorktreeItem
                        key={worktree.id}
                        worktree={worktree}
                        isSelected={worktree.id === selectedWorktreeId}
                        onSelect={() => handleSelectWorktree(worktree)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );

  if (!selectedProjectId) {
    return (
      <div className="flex h-full flex-col">
        {projectSelector}
        <div className="flex flex-1 items-center justify-center p-4">
          <div className="text-center text-sm" style={{ color: 'var(--color-text-muted)' }}>
            <p>Select a project to view sessions</p>
          </div>
        </div>
      </div>
    );
  }

  if (sessionsLoading && sessions.length === 0) {
    const widths = [
      { header: '30%', title: '75%', sub: '90%' },
      { header: '22%', title: '60%', sub: '80%' },
      { header: '26%', title: '85%', sub: '65%' },
    ];

    return (
      <div className="flex h-full flex-col">
        {projectSelector}
        <div className="space-y-3 p-4">
          {widths.map((w, i) => (
            <div key={i} className="space-y-2">
              <div
                className="skeleton-shimmer h-3 rounded-sm"
                style={{ backgroundColor: 'var(--skeleton-base-dim)', width: w.header }}
              />
              <div
                className="skeleton-shimmer h-4 rounded-sm"
                style={{ backgroundColor: 'var(--skeleton-base)', width: w.title }}
              />
              <div
                className="skeleton-shimmer h-3 rounded-sm"
                style={{ backgroundColor: 'var(--skeleton-base-dim)', width: w.sub }}
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (sessionsError) {
    return (
      <div className="flex h-full flex-col">
        {projectSelector}
        <div className="p-4">
          <div
            className="rounded-lg border p-3 text-sm"
            style={{
              borderColor: 'var(--color-border)',
              backgroundColor: 'var(--color-surface-raised)',
              color: 'var(--color-text-muted)',
            }}
          >
            <p className="mb-1 font-semibold" style={{ color: 'var(--color-text)' }}>
              Error loading sessions
            </p>
            <p>{sessionsError}</p>
          </div>
        </div>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex h-full flex-col">
        {projectSelector}
        <div className="flex flex-1 items-center justify-center p-4">
          <div className="text-center text-sm" style={{ color: 'var(--color-text-muted)' }}>
            <MessageSquareOff className="mx-auto mb-2 size-8 opacity-50" />
            <p className="mb-2">No sessions found</p>
            <p className="text-xs opacity-70">This project has no sessions yet</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {projectSelector}
      <div className="flex items-center gap-2 px-2 py-1.5">
        <Calendar className="size-3.5" style={{ color: 'var(--color-text-muted)' }} />
        <h2
          className="text-[11px] uppercase tracking-wider"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {sessionSortMode === 'most-context' ? 'By Context' : 'Sessions'}
        </h2>
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- tooltip trigger via hover, not interactive */}
        <span
          ref={countRef}
          className="text-[11px]"
          style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}
          onMouseEnter={() => setShowCountTooltip(true)}
          onMouseLeave={() => setShowCountTooltip(false)}
        >
          ({sessions.length}
          {sessionsHasMore ? '+' : ''})
        </span>
        {showCountTooltip &&
          sessionsHasMore &&
          countRef.current &&
          createPortal(
            <div
              className="pointer-events-none fixed z-50 w-48 rounded-md px-2.5 py-1.5 text-[11px] leading-snug shadow-lg"
              style={{
                top: countRef.current.getBoundingClientRect().bottom + 6,
                left:
                  countRef.current.getBoundingClientRect().left +
                  countRef.current.getBoundingClientRect().width / 2 -
                  96,
                backgroundColor: 'var(--color-surface-overlay)',
                border: '1px solid var(--color-border-emphasis)',
                color: 'var(--color-text-secondary)',
              }}
            >
              {sessions.length} loaded so far — scroll down to load more. Context sorting only ranks
              loaded sessions.
            </div>,
            document.body
          )}
        <div className="ml-auto flex items-center gap-0.5">
          {/* Multi-select toggle */}
          <button
            onClick={toggleSidebarMultiSelect}
            className="rounded p-1 transition-colors hover:bg-white/5"
            title={sidebarMultiSelectActive ? 'Exit selection mode' : 'Select sessions'}
            style={{
              color: sidebarMultiSelectActive ? '#818cf8' : 'var(--color-text-muted)',
            }}
          >
            <CheckSquare className="size-3.5" />
          </button>
          {/* Show hidden sessions toggle - only when hidden sessions exist */}
          {hasHiddenSessions && (
            <button
              onClick={toggleShowHiddenSessions}
              className="rounded p-1 transition-colors hover:bg-white/5"
              title={showHiddenSessions ? 'Hide hidden sessions' : 'Show hidden sessions'}
              style={{
                color: showHiddenSessions ? '#818cf8' : 'var(--color-text-muted)',
              }}
            >
              {showHiddenSessions ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
            </button>
          )}
          {/* Sort mode toggle */}
          <button
            onClick={() =>
              setSessionSortMode(sessionSortMode === 'recent' ? 'most-context' : 'recent')
            }
            className="rounded p-1 transition-colors hover:bg-white/5"
            title={sessionSortMode === 'recent' ? 'Sort by context consumption' : 'Sort by recent'}
            style={{
              color: sessionSortMode === 'most-context' ? '#818cf8' : 'var(--color-text-muted)',
            }}
          >
            <ArrowDownWideNarrow className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Bulk action bar - shown when sessions are selected */}
      {sidebarMultiSelectActive && sidebarSelectedSessionIds.length > 0 && (
        <div
          className="flex items-center gap-1.5 border-b px-3 py-1.5"
          style={{
            borderColor: 'var(--color-border)',
            backgroundColor: 'var(--color-surface-raised)',
          }}
        >
          <span
            className="text-[11px] font-medium"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            {sidebarSelectedSessionIds.length} selected
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={handleBulkPin}
              className="rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors hover:bg-white/5"
              style={{ color: 'var(--color-text-secondary)' }}
              title="Pin selected sessions"
            >
              <Pin className="inline-block size-3" /> Pin
            </button>
            <button
              onClick={handleBulkHide}
              className="rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors hover:bg-white/5"
              style={{ color: 'var(--color-text-secondary)' }}
              title="Hide selected sessions"
            >
              <EyeOff className="inline-block size-3" /> Hide
            </button>
            {showHiddenSessions && someSelectedAreHidden && (
              <button
                onClick={handleBulkUnhide}
                className="rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors hover:bg-white/5"
                style={{ color: 'var(--color-text-secondary)' }}
                title="Unhide selected sessions"
              >
                <Eye className="inline-block size-3" /> Unhide
              </button>
            )}
            <button
              onClick={clearSidebarSelection}
              className="rounded p-0.5 transition-colors hover:bg-white/5"
              style={{ color: 'var(--color-text-muted)' }}
              title="Cancel selection"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      )}

      <div ref={parentRef} className="flex-1 overflow-y-auto">
        <div
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const item = virtualItems[virtualRow.index];
            if (!item) return null;

            return (
              <div
                key={virtualRow.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {item.type === 'pinned-header' ? (
                  <div
                    className="sticky top-0 flex h-full items-center gap-1.5 border-t px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider backdrop-blur-sm"
                    style={{
                      backgroundColor:
                        'color-mix(in srgb, var(--color-surface-sidebar) 95%, transparent)',
                      color: 'var(--color-text-muted)',
                      borderColor: 'var(--color-border-emphasis)',
                    }}
                  >
                    <Pin className="size-3" />
                    Pinned
                  </div>
                ) : item.type === 'header' ? (
                  <div
                    className="sticky top-0 flex h-full items-center border-t px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider backdrop-blur-sm"
                    style={{
                      backgroundColor:
                        'color-mix(in srgb, var(--color-surface-sidebar) 95%, transparent)',
                      color: 'var(--color-text-muted)',
                      borderColor: 'var(--color-border-emphasis)',
                    }}
                  >
                    {item.category}
                  </div>
                ) : item.type === 'loader' ? (
                  <div
                    className="flex h-full items-center justify-center"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {sessionsLoadingMore ? (
                      <>
                        <Loader2 className="mr-2 size-4 animate-spin" />
                        <span className="text-xs">Loading more sessions...</span>
                      </>
                    ) : (
                      <span className="text-xs opacity-50">Scroll to load more</span>
                    )}
                  </div>
                ) : (
                  <SessionItem
                    session={item.session}
                    isActive={selectedSessionId === item.session.id}
                    isPinned={item.isPinned}
                    isHidden={item.isHidden}
                    multiSelectActive={sidebarMultiSelectActive}
                    isSelected={selectedSet.has(item.session.id)}
                    onToggleSelect={() => toggleSidebarSessionSelection(item.session.id)}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
