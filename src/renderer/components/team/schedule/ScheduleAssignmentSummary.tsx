import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';

import type { Schedule } from '@shared/types';

/** A schedule handoff is not a completed task. Show who actually receives it. */
export function ScheduleAssignmentSummary({
  schedule,
}: Readonly<{ schedule: Schedule }>): React.JSX.Element {
  const { t } = useAppTranslation('team');
  let label: string;
  if (schedule.taskFirst) {
    const target =
      schedule.executionMode === 'team' || !schedule.targetMember?.trim()
        ? t('launch.schedule.leadDefault')
        : schedule.targetMember.trim();
    label = schedule.executionMode === 'team'
      ? t('launch.schedule.taskFirstWholeTeam')
      : `${t('launch.schedule.taskFirstTarget')}: ${target}`;
  } else if (!schedule.executionMode) {
    label = t('launch.schedule.legacyNotice');
  } else {
    label = t(
      schedule.executionMode === 'team'
        ? 'launch.schedule.wholeTeam'
        : 'launch.schedule.oneAgent'
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="block min-w-0 truncate text-[11px] text-[var(--color-text-muted)]">
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm text-xs">{label}</TooltipContent>
    </Tooltip>
  );
}
