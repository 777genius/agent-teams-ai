/** Crash recovery for the existing JSON schedule run history. */
import type { ScheduleRepository } from './ScheduleRepository';
import type { ScheduleRun } from '@shared/types';

export async function recoverInterruptedScheduleRuns(
  repository: ScheduleRepository
): Promise<number> {
  const schedules = await repository.listSchedules();
  let recoveredCount = 0;
  for (const schedule of schedules) {
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
  }
  return recoveredCount;
}
