/** Persist a terminal schedule receipt and publish its same-domain change event.
 * The scheduler retains admission, retries, and active-run ownership.
 */
import type { ScheduleRepository } from './ScheduleRepository';
import type { ScheduleChangeEvent, ScheduleRun, ScheduleRunStatus } from '@shared/types';

export async function completeScheduleRun(
  repository: ScheduleRepository,
  emit: (event: ScheduleChangeEvent) => void,
  run: ScheduleRun,
  status: ScheduleRunStatus,
  exitCode: number | null,
  summary?: string,
  error?: string
): Promise<void> {
  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - new Date(run.startedAt).getTime();
  const updatedRun: ScheduleRun = {
    ...run,
    status,
    completedAt,
    durationMs,
    exitCode,
    summary: summary ?? run.summary,
    error: error ?? run.error,
  };
  await repository.saveRun(updatedRun);
  const eventType = status === 'completed' || status === 'dispatched' || status === 'skipped'
    ? 'run-completed'
    : 'run-failed';
  emit({ type: eventType, scheduleId: run.scheduleId, teamName: run.teamName, detail: error });
}
