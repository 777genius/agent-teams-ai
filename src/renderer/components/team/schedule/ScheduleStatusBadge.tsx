import React from 'react';

import type { ScheduleStatus, ScheduleRunStatus } from '@shared/types';

// =============================================================================
// Schedule Status Badge
// =============================================================================

const SCHEDULE_STATUS_CONFIG: Record<ScheduleStatus, { label: string; className: string }> = {
  active: {
    label: 'Active',
    className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
  },
  paused: { label: 'Paused', className: 'bg-amber-500/15 text-amber-400 border-amber-500/20' },
  disabled: { label: 'Disabled', className: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/20' },
};

interface ScheduleStatusBadgeProps {
  status: ScheduleStatus;
}

export const ScheduleStatusBadge = ({ status }: ScheduleStatusBadgeProps): React.JSX.Element => {
  const config = SCHEDULE_STATUS_CONFIG[status];
  return (
    <span
      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${config.className}`}
    >
      {config.label}
    </span>
  );
};

// =============================================================================
// Run Status Badge
// =============================================================================

const RUN_STATUS_CONFIG: Record<ScheduleRunStatus, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'text-zinc-400' },
  warming_up: { label: 'Warming up', className: 'text-blue-400' },
  warm: { label: 'Warm', className: 'text-cyan-400' },
  running: { label: 'Running', className: 'text-emerald-400' },
  completed: { label: 'Completed', className: 'text-emerald-400' },
  failed: { label: 'Failed', className: 'text-red-400' },
  failed_interrupted: { label: 'Interrupted', className: 'text-amber-400' },
  cancelled: { label: 'Cancelled', className: 'text-zinc-400' },
};

interface RunStatusBadgeProps {
  status: ScheduleRunStatus;
}

export const RunStatusBadge = ({ status }: RunStatusBadgeProps): React.JSX.Element => {
  const config = RUN_STATUS_CONFIG[status];
  return <span className={`text-[10px] font-medium ${config.className}`}>{config.label}</span>;
};
