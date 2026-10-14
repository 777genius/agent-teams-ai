import { memo, useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { WorkflowTimeline } from '@renderer/components/team/dialogs/StatusHistoryTimeline';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import {
  calculateTaskImplementationDuration,
  formatTaskImplementationDuration,
  shouldShowTaskImplementationDuration,
} from '@shared/utils/taskWorkDuration';
import { Clock } from 'lucide-react';

import type { TeamTaskWithKanban } from '@shared/types';

function useTaskImplementationDurationClock(task: TeamTaskWithKanban): {
  duration: ReturnType<typeof calculateTaskImplementationDuration>;
  nowMs: number;
} {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const duration = useMemo(() => calculateTaskImplementationDuration(task, nowMs), [task, nowMs]);

  useEffect(() => {
    if (!duration.hasRunningInterval) return;
    setNowMs(Date.now());
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [duration.hasRunningInterval, task.id]);

  return { duration, nowMs };
}

export const TaskImplementationDurationBadge = memo(function TaskImplementationDurationBadge({
  task,
}: {
  task: TeamTaskWithKanban;
}): React.JSX.Element | null {
  const { t } = useAppTranslation('team');
  const { duration } = useTaskImplementationDurationClock(task);
  if (!shouldShowTaskImplementationDuration(duration)) return null;

  return (
    <Tooltip>
      <TooltipTrigger className="inline-flex items-center gap-1 rounded-md bg-[var(--color-bg-secondary)] px-1.5 py-0.5 text-[10px] font-normal leading-none text-[var(--color-text-muted)]">
        <Clock size={10} />
        <span>
          {t('taskDetail.workflow.inProgressTime', {
            duration: formatTaskImplementationDuration(duration.elapsedMs),
          })}
        </span>
      </TooltipTrigger>
      <TooltipContent>{t('taskDetail.workflow.implementationTimeTitle')}</TooltipContent>
    </Tooltip>
  );
});

export const WorkflowTimelineWithDuration = memo(function WorkflowTimelineWithDuration({
  task,
  events,
  memberColorMap,
}: {
  task: TeamTaskWithKanban;
  events: NonNullable<TeamTaskWithKanban['historyEvents']>;
  memberColorMap: Map<string, string>;
}): React.JSX.Element {
  const { nowMs } = useTaskImplementationDurationClock(task);
  return (
    <WorkflowTimeline
      events={events}
      memberColorMap={memberColorMap}
      implementationDurationTask={task}
      nowMs={nowMs}
    />
  );
});
