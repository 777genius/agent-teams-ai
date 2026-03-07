import React from 'react';

import { Calendar } from 'lucide-react';

export const ScheduleEmptyState = (): React.JSX.Element => (
  <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
    <Calendar className="size-8 text-[var(--color-text-muted)]" />
    <div className="space-y-1">
      <p className="text-xs font-medium text-[var(--color-text-secondary)]">No schedules yet</p>
      <p className="text-[11px] text-[var(--color-text-muted)]">
        Create a schedule to run Claude tasks automatically on a cron schedule.
      </p>
    </div>
  </div>
);
