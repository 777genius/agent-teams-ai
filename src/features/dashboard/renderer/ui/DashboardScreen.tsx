import { useLayoutEffect } from 'react';

import {
  filterRunningTeamRows,
  RunningTeamsSectionView,
} from '@features/running-teams/renderer/hosted';
import { Users } from 'lucide-react';

import { useDashboardInteraction } from '../hooks/useDashboardInteraction';

import { DashboardSearch } from './DashboardSearch';

import type { RunningTeamsSectionViewProps } from '@features/running-teams/renderer/hosted';
import type React from 'react';

export interface DashboardScreenProps {
  scopeKey: string;
  runningTeams: RunningTeamsSectionViewProps;
  /** H1 collection connector; both shells supply the same shared recent collection view. */
  RecentProjects: React.ComponentType<{ searchQuery: string }>;
  onSelectTeam: () => void;
  onOpenPalette: () => void;
  labels: {
    selectTeam: string;
    or: string;
    searchPlaceholder: string;
    palette: string;
    paletteShortcut: string;
    recentTitle: string;
    searchResults: string;
    clearSearch: string;
    noRunningMatches: string;
  };
  environmentNotices?: React.ReactNode;
  environmentTools?: React.ReactNode;
  /** Shell-owned focus policy. Hosted leaves this unset to avoid opening a touch keyboard. */
  shouldFocusSearch?: () => boolean;
}

/** Shared Dashboard layout and local search interaction for Desktop and Hosted. */
export const DashboardScreen = ({
  scopeKey,
  runningTeams,
  RecentProjects,
  onSelectTeam,
  onOpenPalette,
  labels,
  environmentNotices,
  environmentTools,
  shouldFocusSearch,
}: Readonly<DashboardScreenProps>): React.JSX.Element => {
  const { query, setQuery, clear, searchRef } = useDashboardInteraction(scopeKey);
  useLayoutEffect(() => {
    if (shouldFocusSearch?.()) {
      searchRef.current?.focus({ preventScroll: true });
    }
  }, [shouldFocusSearch, searchRef]);
  const hasQuery = query.trim().length > 0;
  const runningRows = filterRunningTeamRows(runningTeams.rows, query);
  const showRunning =
    runningRows.length > 0 ||
    Boolean(runningTeams.readState) ||
    (hasQuery && runningTeams.rows.length > 0);

  return (
    <div className="relative flex-1 overflow-auto bg-surface">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[600px] bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(99,102,241,0.08),transparent)]"
        aria-hidden="true"
      />
      <div className="relative mx-auto max-w-5xl px-8 py-12">
        {environmentNotices}
        {environmentTools}
        <div className="mb-12 flex flex-col items-stretch justify-center gap-2 min-[900px]:flex-row min-[900px]:items-center min-[900px]:gap-0">
          <button
            type="button"
            onClick={onSelectTeam}
            className="flex h-14 w-full shrink-0 items-center justify-center gap-3 px-4 text-base text-text-secondary transition-colors duration-200 hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 min-[900px]:w-auto min-[900px]:justify-start"
          >
            <Users className="size-5" />
            {labels.selectTeam}
          </button>
          <div
            className="relative hidden h-14 w-12 shrink-0 items-center justify-center min-[900px]:flex"
            aria-hidden="true"
          >
            <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
            <span className="relative rounded border border-border bg-surface px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-text-muted">
              {labels.or}
            </span>
          </div>
          <span className="text-center text-[9px] font-medium uppercase tracking-wider text-text-muted min-[900px]:hidden">
            {labels.or}
          </span>
          <div className="min-w-0 flex-1">
            <DashboardSearch
              value={query}
              onChange={setQuery}
              inputRef={searchRef}
              placeholder={labels.searchPlaceholder}
              paletteLabel={labels.palette}
              paletteShortcut={labels.paletteShortcut}
              onOpenPalette={onOpenPalette}
            />
          </div>
        </div>
        {showRunning && (
          <RunningTeamsSectionView
            {...runningTeams}
            rows={runningRows}
            emptyMessage={hasQuery ? labels.noRunningMatches : undefined}
          />
        )}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xs font-medium uppercase tracking-wider text-text-muted">
            {hasQuery ? labels.searchResults : labels.recentTitle}
          </h2>
          {hasQuery && (
            <button
              type="button"
              onClick={clear}
              className="text-xs text-text-muted transition-colors hover:text-text-secondary"
            >
              {labels.clearSearch}
            </button>
          )}
        </div>
        <RecentProjects searchQuery={query} />
      </div>
    </div>
  );
};
