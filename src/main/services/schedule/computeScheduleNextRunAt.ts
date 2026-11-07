import { Cron } from 'croner';

import type { Schedule } from '@shared/types';

/** Calculate the next occurrence without creating a persistent cron timer. */
export function computeScheduleNextRunAt(schedule: Schedule): string | null {
  try {
    const job = new Cron(schedule.cronExpression, {
      timezone: schedule.timezone,
      paused: true,
    });
    const next = job.nextRun();
    job.stop();
    return next?.toISOString() ?? null;
  } catch {
    return null;
  }
}
