import { randomUUID } from 'node:crypto';

import type { ScheduleRepository } from './ScheduleRepository';
import type { SchedulerStopBarrier } from './SchedulerStopBarrier';
import type { Schedule, ScheduleRun } from '@shared/types';

/** Quit drains initial publication as well as terminal history writes. */
export async function persistScheduleRun(
  repository: ScheduleRepository, barrier: SchedulerStopBarrier, run: ScheduleRun
): Promise<void> {
  const finish = barrier.beginFinalization();
  try { await repository.saveRun(run); }
  finally { finish(); }
}

/** Publish the original background target with the occurrence, before any external effect. */
export function createScheduleRun(schedule: Schedule): ScheduleRun {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), scheduleId: schedule.id, teamName: schedule.teamName,
    ...(schedule.hostTarget ? { hostTarget: structuredClone(schedule.hostTarget) } : {}),
    status: 'running', scheduledFor: now, startedAt: now, executionStartedAt: now, retryCount: 0,
  };
}
