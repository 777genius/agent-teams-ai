/**
 * DateGroupedSessions - Sessions organized by date categories with virtual scrolling.
 * Uses @tanstack/react-virtual for efficient DOM rendering with infinite scroll.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';

import { useStore } from '@renderer/store';
import {
  getNonEmptyCategories,
  groupSessionsByDate,
  separatePinnedSessions,
} from '@renderer/utils/dateGrouping';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDownWideNarrow, Calendar, Loader2, MessageSquareOff, Pin } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { SessionItem } from './SessionItem';

import type { Session } from '@renderer/types/data';
import type { DateCategory } from '@renderer/types/tabs';

// Virtual list item types
type VirtualItem =
  | { type: 'header'; category: DateCategory; id: string }
  | { type: 'pinned-header'; id: string }
  | { type: 'session'; session: Session; isPinned: boolean; id: string }
  | { type: 'loader'; id: string };

/**
 * Item height constants for virtual scroll positioning.
 * CRITICAL: These values MUST match the actual rendered heights of components.
 * If SessionItem height changes, update SESSION_HEIGHT here AND add h-[Xpx] to SessionItem.
 * Mismatch causes items to overlap!
 */
const HEADER_HEIGHT = 28;
const SESSION_HEIGHT = 48; // Must match h-[48px] in SessionItem.tsx
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
    sessionsTotalCount,
    fetchSessionsMore,
    pinnedSessionIds,
    sessionSortMode,
    setSessionSortMode,
  } = useStore(
    useShallow((s) => ({
      sessions: s.sessions,
      selectedSessionId: s.selectedSessionId,
      selectedProjectId: s.selectedProjectId,
      sessionsLoading: s.sessionsLoading,
      sessionsError: s.sessionsError,
      sessionsHasMore: s.sessionsHasMore,
      sessionsLoadingMore: s.sessionsLoadingMore,
      sessionsTotalCount: s.sessionsTotalCount,
      fetchSessionsMore: s.fetchSessionsMore,
      pinnedSessionIds: s.pinnedSessionIds,
      sessionSortMode: s.sessionSortMode,
      setSessionSortMode: s.setSessionSortMode,
    }))
  );

  const parentRef = useRef<HTMLDivElement>(null);

  // Separate pinned sessions from unpinned
  const { pinned: pinnedSessions, unpinned: unpinnedSessions } = useMemo(
    () => separatePinnedSessions(sessions, pinnedSessionIds),
    [sessions, pinnedSessionIds]
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
    return [...sessions].sort((a, b) => (b.contextConsumption ?? 0) - (a.contextConsumption ?? 0));
  }, [sessions, sessionSortMode]);

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

  if (!selectedProjectId) {
    return (
      <div className="p-4">
        <div className="py-8 text-center text-sm" style={{ color: 'var(--color-text-muted)' }}>
          <p>Select a project to view sessions</p>
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
      <div className="p-4">
        <div className="space-y-3">
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
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="p-4">
        <div className="py-8 text-center text-sm" style={{ color: 'var(--color-text-muted)' }}>
          <MessageSquareOff className="mx-auto mb-2 size-8 opacity-50" />
          <p className="mb-2">No sessions found</p>
          <p className="text-xs opacity-70">This project has no sessions yet</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="mt-2 flex items-center gap-2 px-4 py-3">
        <Calendar className="size-4" style={{ color: 'var(--color-text-muted)' }} />
        <h2
          className="text-xs uppercase tracking-wider"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {sessionSortMode === 'most-context' ? 'By Context' : 'Sessions'}
        </h2>
        <span className="text-xs" style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>
          ({sessions.length}
          {sessionsTotalCount > sessions.length ? ` of ${sessionsTotalCount}` : ''})
        </span>
        <button
          onClick={() =>
            setSessionSortMode(sessionSortMode === 'recent' ? 'most-context' : 'recent')
          }
          className="ml-auto rounded p-1 transition-colors hover:bg-white/5"
          title={sessionSortMode === 'recent' ? 'Sort by context consumption' : 'Sort by recent'}
          style={{
            color: sessionSortMode === 'most-context' ? '#818cf8' : 'var(--color-text-muted)',
          }}
        >
          <ArrowDownWideNarrow className="size-3.5" />
        </button>
      </div>

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
                    className="sticky top-0 flex h-full items-center gap-1.5 border-t px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider backdrop-blur-sm"
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
                    className="sticky top-0 flex h-full items-center border-t px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider backdrop-blur-sm"
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
