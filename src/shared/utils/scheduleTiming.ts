import { Cron } from 'croner';

/**
 * Validate the exact expression and timezone Croner will use at runtime.
 * A schedule without a future occurrence cannot be advertised as active.
 */
export function getValidScheduleNextRuns(
  expression: string,
  timezone: string,
  count = 1
): Date[] {
  const cronExpression = expression.trim();
  const scheduleTimezone = timezone.trim();
  if (!cronExpression) throw new Error('Cron expression is required');
  if (!scheduleTimezone) throw new Error('Schedule timezone is required');

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: scheduleTimezone });
  } catch {
    throw new Error('Invalid schedule timezone');
  }

  let job: Cron | null = null;
  try {
    job = new Cron(cronExpression, { timezone: scheduleTimezone, paused: true });
    const runs = job.nextRuns(count);
    if (
      runs.length === 0 ||
      runs.some((date) => !Number.isFinite(date.getTime()))
    ) {
      throw new Error('Cron expression has no upcoming runs');
    }
    return runs;
  } finally {
    job?.stop();
  }
}
