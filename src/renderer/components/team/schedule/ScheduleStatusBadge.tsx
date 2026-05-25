import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';

import type { ScheduleRunStatus, ScheduleStatus } from '@shared/types';

// =============================================================================
// Schedule Status Badge
// =============================================================================

const SCHEDULE_STATUS_CONFIG: Record<ScheduleStatus, { labelKey: string; className: string }> = {
  active: {
    labelKey: 'schedule.status.active',
    className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
  },
  paused: {
    labelKey: 'schedule.status.paused',
    className: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
  },
  disabled: {
    labelKey: 'schedule.status.disabled',
    className: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/20',
  },
};

function getScheduleStatusLabel(
  status: ScheduleStatus,
  t: ReturnType<typeof useAppTranslation>['t']
): string {
  if (status === 'active') return t('schedule.status.active');
  if (status === 'paused') return t('schedule.status.paused');
  return t('schedule.status.disabled');
}

interface ScheduleStatusBadgeProps {
  status: ScheduleStatus;
}

export const ScheduleStatusBadge = ({ status }: ScheduleStatusBadgeProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const config = SCHEDULE_STATUS_CONFIG[status];
  return (
    <span
      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${config.className}`}
    >
      {getScheduleStatusLabel(status, t)}
    </span>
  );
};

// =============================================================================
// Run Status Badge
// =============================================================================

const RUN_STATUS_CONFIG: Record<ScheduleRunStatus, { labelKey: string; className: string }> = {
  pending: { labelKey: 'schedule.runStatus.pending', className: 'text-zinc-400' },
  warming_up: { labelKey: 'schedule.runStatus.warmingUp', className: 'text-blue-400' },
  warm: { labelKey: 'schedule.runStatus.warm', className: 'text-cyan-400' },
  running: { labelKey: 'schedule.runStatus.running', className: 'text-emerald-400' },
  completed: { labelKey: 'schedule.runStatus.completed', className: 'text-emerald-400' },
  failed: { labelKey: 'schedule.runStatus.failed', className: 'text-red-400' },
  failed_interrupted: { labelKey: 'schedule.runStatus.interrupted', className: 'text-amber-400' },
  cancelled: { labelKey: 'schedule.runStatus.cancelled', className: 'text-zinc-400' },
};

function getRunStatusLabel(
  status: ScheduleRunStatus,
  t: ReturnType<typeof useAppTranslation>['t']
): string {
  switch (status) {
    case 'pending':
      return t('schedule.runStatus.pending');
    case 'warming_up':
      return t('schedule.runStatus.warmingUp');
    case 'warm':
      return t('schedule.runStatus.warm');
    case 'running':
      return t('schedule.runStatus.running');
    case 'completed':
      return t('schedule.runStatus.completed');
    case 'failed':
      return t('schedule.runStatus.failed');
    case 'failed_interrupted':
      return t('schedule.runStatus.interrupted');
    case 'cancelled':
      return t('schedule.runStatus.cancelled');
    default:
      return status;
  }
}

interface RunStatusBadgeProps {
  status: ScheduleRunStatus;
}

export const RunStatusBadge = ({ status }: RunStatusBadgeProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const config = RUN_STATUS_CONFIG[status];
  return (
    <span className={`text-[10px] font-medium ${config.className}`}>
      {getRunStatusLabel(status, t)}
    </span>
  );
};
