import type { TeamNotificationPayload } from '@main/utils/teamNotificationBuilder';
import type { ScheduleChangeEvent } from '@shared/types/schedule';

/** A run-completed UI event may also mean "skipped" or "dispatched".
 * Only terminal executed runs produce success/failure notifications.
 * Do not forward schedule labels, errors, prompts, or run details externally.
 */
export function scheduleNotificationFromChange(
  event: ScheduleChangeEvent
): TeamNotificationPayload | null {
  const teamEventType =
    event.type === 'run-completed' && event.runStatus === 'completed'
      ? 'schedule_completed'
      : event.type === 'run-failed' && event.runStatus === 'failed'
        ? 'schedule_failed'
        : null;
  if (!teamEventType || !event.runId) return null;

  return {
    teamEventType,
    teamName: event.teamName,
    teamDisplayName: event.teamName,
    from: 'Scheduler',
    summary: teamEventType === 'schedule_completed' ? 'Scheduled run completed' : 'Scheduled run failed',
    body: '',
    dedupeKey: `schedule:${event.scheduleId}:${event.runId}:${teamEventType}`,
    target: { kind: 'team', teamName: event.teamName, section: 'schedules' },
  };
}
