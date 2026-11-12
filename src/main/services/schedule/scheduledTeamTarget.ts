import { isHostTeamSelectionKey, parseHostTeamSelectionKey } from '@features/agent-backend/contracts';

import type { HostScheduleTarget, Schedule } from '@shared/types';

export interface ScheduleTargetAdmission {
  target: HostScheduleTarget;
  isCurrent(): boolean;
}

export const HOST_SCHEDULE_UNSUPPORTED = 'Schedules for Host-backed teams require owner-aware scheduling';

export function hasScheduledTeamTarget(
  schedule: Pick<Schedule, 'teamName' | 'hostTarget'>,
  supportsHost: boolean
): boolean {
  if (!isHostTeamSelectionKey(schedule.teamName)) return schedule.hostTarget === undefined;
  const target = schedule.hostTarget;
  try {
    return supportsHost && target?.kind === 'host' &&
      target.handleId === parseHostTeamSelectionKey(schedule.teamName) &&
      [target.contextId, target.ownerResourceRef, target.teamResourceRef].every(value =>
        typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0'));
  } catch { return false; }
}

export function assertScheduledTeamTarget(
  schedule: Pick<Schedule, 'teamName' | 'hostTarget'>,
  supportsHost: boolean
): void {
  if (!hasScheduledTeamTarget(schedule, supportsHost)) throw new Error(HOST_SCHEDULE_UNSUPPORTED);
}
