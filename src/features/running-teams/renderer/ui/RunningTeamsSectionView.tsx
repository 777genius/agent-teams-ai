import { TeamTaskStatusSummary } from '@renderer/components/team/TeamTaskStatusSummary';
import { ActivePulseIndicator } from '@renderer/components/ui/ActivePulseIndicator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { FolderOpen, UsersRound } from 'lucide-react';

import type { RunningTeamTaskCounts } from '../../core/domain/policies/buildRunningTeamsDashboard';
import type React from 'react';

export interface RunningTeamViewRow {
  /** Opaque key within the current scope. The composition root resolves it for navigation. */
  targetKey: string;
  displayName: string;
  projectLabel?: string;
  detail?: string;
  status: 'active' | 'idle' | 'provisioning' | 'running_unknown';
  statusLabel: string;
  iconColor?: string;
  /** Missing counts mean unknown, not zero. */
  taskCounts?: RunningTeamTaskCounts;
}

export interface RunningTeamsSectionReadState {
  phase: 'ready' | 'loading' | 'error';
  stale?: boolean;
  incomplete?: boolean;
  message?: string;
  onRetry?: () => void;
  retryLabel?: string;
}

export interface RunningTeamsSectionViewProps {
  title: string;
  rows: readonly RunningTeamViewRow[];
  onOpen: (targetKey: string) => void;
  readState?: RunningTeamsSectionReadState;
  emptyMessage?: string;
}

function getRowTitle(row: RunningTeamViewRow): string {
  return row.detail ? `${row.displayName} - ${row.detail}` : row.displayName;
}

export const RunningTeamsSectionView = ({
  title,
  rows,
  onOpen,
  readState,
  emptyMessage,
}: Readonly<RunningTeamsSectionViewProps>): React.JSX.Element => {
  const statusMessage = readState?.message;
  const hasReadNotice =
    readState && (readState.phase !== 'ready' || readState.stale || readState.incomplete);

  return (
    <section className="mb-12" aria-label={title}>
      <div className="mb-3 flex items-center">
        <h2 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-text-muted">
          {title}
          <span className="rounded-full border border-border bg-surface-overlay px-1.5 py-0.5 text-[10px] font-medium leading-none text-text-secondary">
            {rows.length}
          </span>
        </h2>
      </div>
      {hasReadNotice && statusMessage && (
        <div
          role={readState?.phase === 'error' ? 'alert' : 'status'}
          className="mb-3 text-xs text-text-muted"
        >
          {statusMessage}
          {readState?.onRetry && readState.retryLabel && (
            <button type="button" className="ml-2 underline" onClick={readState.onRetry}>
              {readState.retryLabel}
            </button>
          )}
        </div>
      )}
      {rows.length === 0 &&
        readState?.phase !== 'loading' &&
        readState?.phase !== 'error' &&
        !readState?.incomplete &&
        !readState?.stale &&
        emptyMessage && <p className="text-xs text-text-muted">{emptyMessage}</p>}
      {rows.length > 0 && (
        <div className="grid grid-cols-3 gap-3 xl:grid-cols-4">
          {rows.map((row) => (
            <Tooltip key={row.targetKey}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onOpen(row.targetKey)}
                  aria-label={getRowTitle(row)}
                  className="bg-surface/50 group relative flex min-w-0 items-start gap-2.5 overflow-hidden rounded-lg border border-border px-3 py-2.5 pr-8 text-left transition-all duration-200 hover:border-border-emphasis hover:bg-surface-raised"
                >
                  {row.status !== 'running_unknown' && (
                    <ActivePulseIndicator className="absolute right-3 top-3" />
                  )}
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-overlay transition-colors group-hover:border-border-emphasis">
                    <UsersRound
                      className="size-4 transition-colors"
                      style={{ color: row.iconColor }}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium text-text">
                        {row.displayName}
                      </span>
                    </span>
                    {row.projectLabel && (
                      <span className="mt-1 flex min-w-0 items-center gap-1 text-[10px] text-text-muted">
                        <FolderOpen className="size-3 shrink-0" />
                        <span className="truncate">{row.projectLabel}</span>
                      </span>
                    )}
                    {row.status === 'running_unknown' && (
                      <span className="mt-1 block text-[10px] text-text-muted">
                        {row.statusLabel}
                      </span>
                    )}
                    {row.taskCounts && (
                      <TeamTaskStatusSummary
                        counts={row.taskCounts}
                        showProgress={false}
                        iconSize={11}
                        className="mt-1.5"
                        countersClassName="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-text-muted"
                      />
                    )}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent>{getRowTitle(row)}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      )}
    </section>
  );
};
