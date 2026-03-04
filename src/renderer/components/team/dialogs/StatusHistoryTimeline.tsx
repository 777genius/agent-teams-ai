import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { TASK_STATUS_LABELS, TASK_STATUS_STYLES } from '@renderer/utils/memberHelpers';
import { ArrowRight, Plus } from 'lucide-react';

import type { StatusTransition, TeamTaskStatus } from '@shared/types';

interface StatusHistoryTimelineProps {
  history: StatusTransition[];
}

export const StatusHistoryTimeline = ({ history }: StatusHistoryTimelineProps) => {
  if (history.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-[var(--color-text-muted)]">
        No status history recorded
      </div>
    );
  }

  return (
    <div className="space-y-0 px-3 py-2">
      {history.map((transition, idx) => {
        const isLast = idx === history.length - 1;
        const time = formatTime(transition.timestamp);
        const isCreation = transition.from === null;

        return (
          <div key={`${transition.timestamp}-${idx}`} className="flex">
            {/* Timeline line + dot */}
            <div className="flex w-5 shrink-0 flex-col items-center">
              <div className={cn('mt-1.5 size-2 shrink-0 rounded-full', dotColor(transition.to))} />
              {!isLast && <div className="w-px flex-1 bg-zinc-700" />}
            </div>

            {/* Content */}
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="mb-1.5 flex w-full items-center gap-2 rounded px-1.5 py-1 text-xs text-[var(--color-text-secondary)]">
                  <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">
                    {time}
                  </span>
                  {isCreation ? (
                    <span className="flex items-center gap-1">
                      <Plus size={10} />
                      Created as
                      <StatusBadge status={transition.to} />
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <StatusBadge status={transition.from!} />
                      <ArrowRight size={10} className="text-[var(--color-text-muted)]" />
                      <StatusBadge status={transition.to} />
                    </span>
                  )}
                  {transition.actor ? (
                    <span className="ml-auto shrink-0 text-[10px] text-[var(--color-text-muted)]">
                      by {transition.actor}
                    </span>
                  ) : null}
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {new Date(transition.timestamp).toLocaleString()}
              </TooltipContent>
            </Tooltip>
          </div>
        );
      })}
    </div>
  );
};

const StatusBadge = ({ status }: { status: TeamTaskStatus }) => {
  const style = TASK_STATUS_STYLES[status] ?? TASK_STATUS_STYLES.pending;
  const label = TASK_STATUS_LABELS[status] ?? status;
  return (
    <span
      className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-medium', style.bg, style.text)}
    >
      {label}
    </span>
  );
};

function dotColor(status: TeamTaskStatus): string {
  switch (status) {
    case 'pending':
      return 'bg-zinc-500';
    case 'in_progress':
      return 'bg-blue-400';
    case 'completed':
      return 'bg-emerald-400';
    case 'deleted':
      return 'bg-red-400';
    default:
      return 'bg-zinc-500';
  }
}

function formatTime(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return '??:??';
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return '??:??';
  }
}
