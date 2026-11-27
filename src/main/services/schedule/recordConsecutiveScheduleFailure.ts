import { createLogger } from '@shared/utils/logger';

import type { ScheduleRepository } from './ScheduleRepository';

const logger = createLogger('Service:Scheduler');

/** Re-read the current record inside the repository's existing update fence. */
export async function recordConsecutiveScheduleFailure(
  repository: ScheduleRepository,
  scheduleId: string
) {
  let shouldAutoPause = false;
  const updated = await repository.updateSchedule(scheduleId, (fresh) => {
    const newCount = fresh.consecutiveFailures + 1;
    shouldAutoPause = newCount >= fresh.maxConsecutiveFailures;
    if (shouldAutoPause) {
      logger.warn(`[${scheduleId}] Auto-pausing after ${newCount} consecutive failures`);
    }
    return {
      ...fresh,
      consecutiveFailures: newCount,
      status: shouldAutoPause ? 'paused' : fresh.status,
      updatedAt: new Date().toISOString(),
    };
  });

  return { updated, shouldAutoPause };
}
