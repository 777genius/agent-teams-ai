import { useAppTranslation } from '@features/localization/renderer';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import {
  REVIEW_STATE_DISPLAY,
  TASK_STATUS_LABELS,
  TASK_STATUS_STYLES,
} from '@renderer/utils/memberHelpers';
import {
  calculateTaskImplementationEventDuration,
  formatTaskImplementationDuration,
} from '@shared/utils/taskWorkDuration';
import { ArrowRight, Eye, MessageSquareX, Plus, ShieldCheck, UserRound } from 'lucide-react';

import type {
  TaskHistoryEvent,
  TaskWorkInterval,
  TeamReviewState,
  TeamTaskStatus,
} from '@shared/types';

interface WorkflowTimelineProps {
  events: TaskHistoryEvent[];
  /** Map of member name → color name for colored badges. */
  memberColorMap?: Map<string, string>;
  implementationDurationTask?: {
    status?: string | null;
    workIntervals?: TaskWorkInterval[] | null;
  } | null;
  nowMs?: number;
}

export const WorkflowTimeline = ({
  events,
  memberColorMap,
  implementationDurationTask,
  nowMs,
}: WorkflowTimelineProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const implementationNowMs = nowMs ?? 0;

  if (events.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-[var(--color-text-muted)]">
        {t('taskDetail.workflowTimeline.empty')}
      </div>
    );
  }

  return (
    <div className="px-3 py-2">
      {events.map((event, idx) => {
        const isLast = idx === events.length - 1;
        const time = formatTime(event.timestamp);
        const implementationDuration = implementationDurationTask
          ? calculateTaskImplementationEventDuration(
              implementationDurationTask,
              event,
              implementationNowMs
            )
          : null;

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
                <div className="flex w-full items-center gap-2 rounded p-1.5 text-xs text-[var(--color-text-secondary)]">
                  <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">
                    {time}
                  </span>
                  <EventContent event={event} memberColorMap={memberColorMap} />
                  {implementationDuration ? (
                    <span
                      className="shrink-0 rounded bg-[var(--color-bg-secondary)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]"
                      title={
                        implementationDuration.running
                          ? t('taskDetail.workflowTimeline.currentImplementationInterval')
                          : t('taskDetail.workflowTimeline.implementationIntervalEnded')
                      }
                    >
                      {implementationDuration.running
                        ? t('taskDetail.workflowTimeline.runningPrefix')
                        : ''}
                      {formatTaskImplementationDuration(implementationDuration.elapsedMs)}
                    </span>
                  ) : null}
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
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  switch (event.type) {
    case 'task_created':
      return (
        <span className="flex items-center gap-1">
          <Plus size={10} />
          {t('taskDetail.workflowTimeline.createdAs')}
          <StatusBadge status={event.status} />
          {event.actor ? (
            <>
              <span className="text-[var(--color-text-muted)]">
                {t('taskDetail.workflowTimeline.by')}
              </span>
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
    case 'owner_changed':
      return (
        <span className="flex items-center gap-1">
          <UserRound size={10} className="text-cyan-400" />
          {event.from && event.to ? (
            <>
              {t('taskDetail.workflowTimeline.reassigned')}
              <MemberBadge
                name={event.from}
                color={memberColorMap?.get(event.from)}
                size="sm"
                hideAvatar
              />
              <ArrowRight size={10} className="text-[var(--color-text-muted)]" />
              <MemberBadge
                name={event.to}
                color={memberColorMap?.get(event.to)}
                size="sm"
                hideAvatar
              />
            </>
          ) : event.to ? (
            <>
              {t('taskDetail.workflowTimeline.assignedTo')}
              <MemberBadge
                name={event.to}
                color={memberColorMap?.get(event.to)}
                size="sm"
                hideAvatar
              />
            </>
          ) : event.from ? (
            <>
              {t('taskDetail.workflowTimeline.unassignedFrom')}
              <MemberBadge
                name={event.from}
                color={memberColorMap?.get(event.from)}
                size="sm"
                hideAvatar
              />
            </>
          ) : (
            t('taskDetail.workflowTimeline.ownerChanged')
          )}
        </span>
      );
    case 'review_requested':
      return (
        <span className="flex items-center gap-1">
          <Eye size={10} className="text-purple-400" />
          {t('taskDetail.workflowTimeline.reviewRequested')}
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
    case 'review_started':
      return (
        <span className="flex items-center gap-1">
          <Eye size={10} className="text-purple-400" />
          {t('taskDetail.workflowTimeline.reviewStarted')}
        </span>
      );
    case 'review_changes_requested':
      return (
        <span className="flex items-center gap-1">
          <MessageSquareX size={10} className="text-amber-400" />
          {t('taskDetail.workflowTimeline.changesRequested')}
          <ReviewStateBadge state="needsFix" />
        </span>
      );
    case 'review_approved':
      return (
        <span className="flex items-center gap-1">
          <ShieldCheck size={10} className="text-emerald-400" />
          {t('taskDetail.workflowTimeline.approved')}
          <ReviewStateBadge state="approved" />
        </span>
      );
    default:
      return <span>{t('taskDetail.workflowTimeline.unknownEvent')}</span>;
  }
};

const StatusBadge = ({ status }: { status: TeamTaskStatus }): React.JSX.Element => {
  const style = TASK_STATUS_STYLES[status] ?? TASK_STATUS_STYLES.pending;
  const { t } = useAppTranslation('team');
  const label = TASK_STATUS_LABELS[status] ? getStatusLabel(status, t) : status;
  return (
    <span
      className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-medium', style.bg, style.text)}
    >
      {label}
    </span>
  );
};

const ReviewStateBadge = ({ state }: { state: TeamReviewState }): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  if (state === 'none') return null;
  const display = REVIEW_STATE_DISPLAY[state];
  if (!display) return null;
  return (
    <span
      className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-medium', display.bg, display.text)}
    >
      {getReviewStateLabel(state, t)}
    </span>
  );
};

function getStatusLabel(
  status: TeamTaskStatus,
  t: ReturnType<typeof useAppTranslation>['t']
): string {
  switch (status) {
    case 'pending':
      return t('tasks.status.pending');
    case 'in_progress':
      return t('tasks.status.inProgress');
    case 'completed':
      return t('tasks.status.completed');
    case 'deleted':
      return t('tasks.status.deleted');
    default:
      return status;
  }
}

function getReviewStateLabel(
  state: TeamReviewState,
  t: ReturnType<typeof useAppTranslation>['t']
): string {
  switch (state) {
    case 'approved':
      return t('taskDetail.reviewStates.approved');
    case 'needsFix':
      return t('taskDetail.reviewStates.needsFix');
    case 'review':
      return t('taskDetail.reviewStates.inReview');
    case 'none':
      return '';
    default:
      return state;
  }
}

function dotColor(event: TaskHistoryEvent): string {
  switch (event.type) {
    case 'task_created':
      return dotColorForStatus(event.status);
    case 'status_changed':
      return dotColorForStatus(event.to);
    case 'owner_changed':
      return 'bg-cyan-400';
    case 'review_requested':
      return 'bg-purple-400';
    case 'review_started':
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
