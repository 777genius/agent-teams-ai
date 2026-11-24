import { describe, expect, it } from 'vitest';

import { toOutboundNotification } from '@features/notification-channels/core/domain/routing';
import { scheduleNotificationFromChange } from '@main/services/schedule/scheduleNotificationFromChange';
import { buildDetectedErrorFromTeam } from '@main/utils/teamNotificationBuilder';

import type { ScheduleChangeEvent } from '@shared/types/schedule';

const completed: ScheduleChangeEvent = {
  type: 'run-completed',
  scheduleId: 'schedule-1',
  runId: 'run-1',
  runStatus: 'completed',
  teamName: 'private-team',
  detail: 'do-not-send-private-data',
};

describe('Schedule notification delivery', () => {
  it('emits one stable event per completed run with a schedule deep link', () => {
    const payload = scheduleNotificationFromChange(completed);
    expect(payload).toMatchObject({
      teamEventType: 'schedule_completed',
      dedupeKey: 'schedule:schedule-1:run-1:schedule_completed',
      target: { kind: 'team', teamName: 'private-team', section: 'schedules' },
    });
    expect(JSON.stringify(payload)).not.toContain('do-not-send-private-data');
    expect(toOutboundNotification(buildDetectedErrorFromTeam(payload!))).toEqual({
      event: 'schedule_completed',
      message: 'Agent Teams: Scheduled run completed.',
    });
  });

  it('emits a sanitized failed-run event without leaking provider errors', () => {
    const payload = scheduleNotificationFromChange({
      ...completed, type: 'run-failed', runStatus: 'failed',
      detail: 'secret=private-token',
    });
    expect(payload?.dedupeKey).toBe('schedule:schedule-1:run-1:schedule_failed');
    expect(JSON.stringify(payload)).not.toContain('private-token');
    expect(toOutboundNotification(buildDetectedErrorFromTeam(payload!))).toEqual({
      event: 'schedule_failed',
      message: 'Agent Teams: Scheduled run failed.',
    });
  });

  it('never sends skipped, dispatched, active, or nonterminal UI events', () => {
    for (const runStatus of ['skipped', 'dispatched', 'running', 'cancelled'] as const) {
      expect(scheduleNotificationFromChange({ ...completed, runStatus })).toBeNull();
    }
    expect(scheduleNotificationFromChange({ ...completed, type: 'run-started' })).toBeNull();
    expect(scheduleNotificationFromChange({ ...completed, runId: undefined })).toBeNull();
    expect(scheduleNotificationFromChange({ ...completed, runStatus: undefined })).toBeNull();
  });
});
