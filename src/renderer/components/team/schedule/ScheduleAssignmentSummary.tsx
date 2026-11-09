import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';

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
    <span
      className="block min-w-0 truncate text-[11px] text-[var(--color-text-muted)]"
      title={label}
    >
      {label}
    </span>
  );
}
