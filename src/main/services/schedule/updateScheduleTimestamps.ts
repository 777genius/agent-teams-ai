import { computeScheduleNextRunAt } from './computeScheduleNextRunAt';

import type { ScheduleRepository } from './ScheduleRepository';
import type { Schedule, ScheduleChangeEvent } from '@shared/types';

export async function updateScheduleTimestamps(
  repository: Pick<ScheduleRepository, 'getSchedule' | 'saveSchedule'>,
  schedule: Schedule,
  emitChange: (event: ScheduleChangeEvent) => void
): Promise<void> {
  // Reload fresh from repo to avoid overwriting changes from incrementConsecutiveFailures
  const fresh = await repository.getSchedule(schedule.id);
  if (!fresh) return;

  const now = new Date().toISOString();
  const nextRunAt = computeScheduleNextRunAt(fresh);

  const updated: Schedule = {
    ...fresh,
    lastRunAt: now,
    nextRunAt: nextRunAt ?? undefined,
    updatedAt: now,
  };

  await repository.saveSchedule(updated);
  emitChange({
    type: 'schedule-updated',
    scheduleId: fresh.id,
    teamName: fresh.teamName,
  });
}
