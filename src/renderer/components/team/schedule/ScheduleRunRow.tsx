import React from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { Clock } from 'lucide-react';

import { RunStatusBadge } from './ScheduleStatusBadge';

import type { ScheduleRun } from '@shared/types';

// =============================================================================
// Props
// =============================================================================

interface ScheduleRunRowProps {
  run: ScheduleRun;
  onClick?: (run: ScheduleRun) => void;
}

// =============================================================================
// Helpers
// =============================================================================

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function formatTime(isoString: string): string {
  try {
    return new Date(isoString).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return isoString;
  }
}

// =============================================================================
// Component
// =============================================================================

export const ScheduleRunRow = ({ run, onClick }: ScheduleRunRowProps): React.JSX.Element => (
  <div
    className={`flex items-center gap-2 border-t border-[var(--color-border)] px-2 py-1.5 text-[11px]${
      onClick ? 'cursor-pointer transition-colors hover:bg-[var(--color-surface-raised)]' : ''
    }`}
    onClick={onClick ? () => onClick(run) : undefined}
    role={onClick ? 'button' : undefined}
    tabIndex={onClick ? 0 : undefined}
    onKeyDown={
      onClick
        ? (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onClick(run);
            }
          }
        : undefined
    }
  >
    <RunStatusBadge status={run.status} />

    <span className="flex items-center gap-1 text-[var(--color-text-muted)]">
      <Clock className="size-3" />
      {formatTime(run.startedAt)}
    </span>

    {run.durationMs != null ? (
      <span className="text-[var(--color-text-muted)]">{formatDuration(run.durationMs)}</span>
    ) : null}

    {run.summary ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)]">
            {run.summary.slice(0, 80)}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-sm">
          <p className="whitespace-pre-wrap text-xs">{run.summary.slice(0, 500)}</p>
        </TooltipContent>
      </Tooltip>
    ) : null}

    {run.error ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="min-w-0 flex-1 truncate text-red-400">{run.error.slice(0, 60)}</span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-sm">
          <p className="whitespace-pre-wrap text-xs text-red-300">{run.error.slice(0, 500)}</p>
        </TooltipContent>
      </Tooltip>
    ) : null}
  </div>
);
