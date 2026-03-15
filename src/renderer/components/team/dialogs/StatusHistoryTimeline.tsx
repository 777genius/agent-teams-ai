import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import {
  REVIEW_STATE_DISPLAY,
  TASK_STATUS_LABELS,
  TASK_STATUS_STYLES,
} from '@renderer/utils/memberHelpers';
import { ArrowRight, Eye, MessageSquareX, Plus, ShieldCheck } from 'lucide-react';

import type { TaskHistoryEvent, TeamReviewState, TeamTaskStatus } from '@shared/types';

interface WorkflowTimelineProps {
  events: TaskHistoryEvent[];
  /** Map of member name → color name for colored badges. */
  memberColorMap?: Map<string, string>;
}

export const WorkflowTimeline = ({ events, memberColorMap }: WorkflowTimelineProps) => {
  if (events.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-[var(--color-text-muted)]">
        No workflow history recorded
      </div>
    );
  }

  return (
    <div className="px-3 py-2">
      {events.map((event, idx) => {
        const isLast = idx === events.length - 1;
        const time = formatTime(event.timestamp);

        return (
          <div key={event.id} className="flex">
            {/* Timeline line + dot */}
            <div className="flex w-5 shrink-0 flex-col items-center">
              <div className={cn('mt-2 size-2 shrink-0 rounded-full', dotColor(event))} />
              {!isLast && <div className="mt-1 w-px flex-1 bg-zinc-700" />}
            </div>

            {/* Content */}
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-xs text-[var(--color-text-secondary)]">
                  <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">
                    {time}
                  </span>
                  <EventContent event={event} memberColorMap={memberColorMap} />
                  {shouldShowTrailingActor(event) && event.actor ? (
                    <span className="ml-auto shrink-0">
                      <MemberBadge
                        name={event.actor}
                        color={memberColorMap?.get(event.actor)}
                        size="sm"
                      />
                    </span>
                  ) : null}
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {new Date(event.timestamp).toLocaleString()}
              </TooltipContent>
            </Tooltip>
          </div>
        );
      })}
    </div>
  );
};

/** Keep old name as re-export for backwards compatibility during migration. */
export const StatusHistoryTimeline = WorkflowTimeline;

const EventContent = ({
  event,
  memberColorMap,
}: {
  event: TaskHistoryEvent;
  memberColorMap?: Map<string, string>;
}) => {
  switch (event.type) {
    case 'task_created':
      return (
        <span className="flex items-center gap-1">
          <Plus size={10} />
          Created as
          <StatusBadge status={event.status} />
          {event.actor ? (
            <>
              <span className="text-[var(--color-text-muted)]">by</span>
              <MemberBadge
                name={event.actor}
                color={memberColorMap?.get(event.actor)}
                size="sm"
                hideAvatar
              />
            </>
          ) : null}
        </span>
      );
    case 'status_changed':
      return (
        <span className="flex items-center gap-1">
          <StatusBadge status={event.from} />
          <ArrowRight size={10} className="text-[var(--color-text-muted)]" />
          <StatusBadge status={event.to} />
        </span>
      );
    case 'review_requested':
      return (
        <span className="flex items-center gap-1">
          <Eye size={10} className="text-purple-400" />
          Review requested
          {event.reviewer ? (
            <MemberBadge
              name={event.reviewer}
              color={memberColorMap?.get(event.reviewer)}
              size="sm"
              hideAvatar
            />
          ) : null}
        </span>
      );
    case 'review_changes_requested':
      return (
        <span className="flex items-center gap-1">
          <MessageSquareX size={10} className="text-amber-400" />
          Changes requested
          <ReviewStateBadge state="needsFix" />
        </span>
      );
    case 'review_approved':
      return (
        <span className="flex items-center gap-1">
          <ShieldCheck size={10} className="text-emerald-400" />
          Approved
          <ReviewStateBadge state="approved" />
        </span>
      );
    default:
      return <span>Unknown event</span>;
  }
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

const ReviewStateBadge = ({ state }: { state: TeamReviewState }) => {
  if (state === 'none') return null;
  const display = REVIEW_STATE_DISPLAY[state];
  if (!display) return null;
  return (
    <span
      className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-medium', display.bg, display.text)}
    >
      {display.label}
    </span>
  );
};

function dotColor(event: TaskHistoryEvent): string {
  switch (event.type) {
    case 'task_created':
      return dotColorForStatus(event.status);
    case 'status_changed':
      return dotColorForStatus(event.to);
    case 'review_requested':
      return 'bg-purple-400';
    case 'review_changes_requested':
      return 'bg-amber-400';
    case 'review_approved':
      return 'bg-emerald-400';
    default:
      return 'bg-zinc-500';
  }
}

function shouldShowTrailingActor(event: TaskHistoryEvent): boolean {
  return event.type !== 'task_created';
}

function dotColorForStatus(status: TeamTaskStatus): string {
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
