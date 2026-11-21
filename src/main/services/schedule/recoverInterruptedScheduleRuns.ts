/** Crash recovery for the existing JSON schedule run history. */
import { createLogger } from '@shared/utils/logger';

import type { ScheduleRepository } from './ScheduleRepository';
import type { ScheduleRun } from '@shared/types';

const logger = createLogger('Service:SchedulerRecovery');

export async function recoverInterruptedScheduleRuns(
  repository: ScheduleRepository
): Promise<{ recoveredCount: number; unavailableScheduleIds: ReadonlySet<string> }> {
  const schedules = await repository.listSchedules();
  const unavailableScheduleIds = new Set<string>();
  let recoveredCount = 0;
  for (const schedule of schedules) {
    try {
      const runs = await repository.listRuns(schedule.id, { limit: 5 });
      for (const run of runs) {
        if (
          run.status === 'warming_up' ||
          run.status === 'warm' ||
          run.status === 'running' ||
          run.status === 'pending'
        ) {
          const updated: ScheduleRun = {
            ...run,
            status: 'failed_interrupted',
            completedAt: new Date().toISOString(),
            error: 'Interrupted by app restart',
          };
          await repository.saveRun(updated);
          recoveredCount++;
        }
      }
    } catch (error) {
      unavailableScheduleIds.add(schedule.id);
      logger.warn(`Failed to recover schedule ${schedule.id}: ${error}`);
    }
  }
  return { recoveredCount, unavailableScheduleIds };
}
