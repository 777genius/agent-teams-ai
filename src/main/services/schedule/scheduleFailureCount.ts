import { createLogger } from '@shared/utils/logger';

import type { ScheduleRepository } from './ScheduleRepository';
import type { Schedule } from '@shared/types';

const logger = createLogger('Service:Scheduler');

type Repository = Pick<ScheduleRepository, 'getSchedule' | 'saveSchedule'>;

// Both helpers reload the record so a pause, edit or delete made while the run
// executed survives. Run them inside the schedule's mutation queue.

export async function resetScheduleFailureCount(
  repository: Repository,
  scheduleId: string
): Promise<void> {
  const fresh = await repository.getSchedule(scheduleId);
  if (!fresh || fresh.consecutiveFailures === 0) return;

  const updated: Schedule = {
    ...fresh,
    consecutiveFailures: 0,
    updatedAt: new Date().toISOString(),
  };
  await repository.saveSchedule(updated);
}

/** Returns the new failure count when this failure auto-paused the schedule, else null. */
export async function recordScheduleFailure(
  repository: Repository,
  scheduleId: string
): Promise<number | null> {
  const fresh = await repository.getSchedule(scheduleId);
  if (!fresh) return null;
  const newCount = fresh.consecutiveFailures + 1;
  const shouldAutoPause = newCount >= fresh.maxConsecutiveFailures;

  const updated: Schedule = {
    ...fresh,
    consecutiveFailures: newCount,
    status: shouldAutoPause ? 'paused' : fresh.status,
    updatedAt: new Date().toISOString(),
  };
  if (shouldAutoPause) {
    logger.warn(`[${scheduleId}] Auto-pausing after ${newCount} consecutive failures`);
  }
  await repository.saveSchedule(updated);
  return shouldAutoPause ? newCount : null;
}
