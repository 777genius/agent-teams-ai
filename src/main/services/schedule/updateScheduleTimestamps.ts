import { computeScheduleNextRunAt } from './computeScheduleNextRunAt';

import type { ScheduleRepository } from './ScheduleRepository';
import type { Schedule, ScheduleChangeEvent } from '@shared/types';

export async function updateScheduleTimestamps(
  repository: Pick<ScheduleRepository, 'updateSchedule'>,
  schedule: Schedule,
  emitChange: (event: ScheduleChangeEvent) => void
): Promise<void> {
  // Pause and edits may commit while a run finishes; retain their latest fields.
  const updated = await repository.updateSchedule(schedule.id, (fresh) => {
    const now = new Date().toISOString();
    return {
      ...fresh,
      lastRunAt: now,
      nextRunAt: computeScheduleNextRunAt(fresh) ?? undefined,
      updatedAt: now,
    };
  });
  if (!updated) return;
  emitChange({
    type: 'schedule-updated',
    scheduleId: updated.id,
    teamName: updated.teamName,
  });
}
