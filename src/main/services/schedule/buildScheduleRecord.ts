import { initialScheduleLimits, patchScheduleLimits } from '@shared/utils/scheduleLimits';
import { randomUUID } from 'crypto';

import { computeScheduleNextRunAt } from './computeScheduleNextRunAt';

import type { ScheduleTargetAdmission } from './scheduledTeamTarget';
import type { CreateScheduleInput, Schedule, UpdateSchedulePatch } from '@shared/types';

/** Pure record construction after the caller has validated original admission. */
export function buildNewSchedule(
  input: CreateScheduleInput,
  admission: ScheduleTargetAdmission | undefined,
  selected: CreateScheduleInput & Pick<Schedule, 'hostTarget'>,
  cronExpression: string,
  timezone: string
): Schedule {
  const now = new Date().toISOString();
  const schedule: Schedule = {
    id: randomUUID(),
    teamName: input.teamName,
    ...(admission ? { hostTarget: structuredClone(admission.target) } : {}),
    ...(input.executionMode && { executionMode: input.executionMode }),
    ...(input.taskFirst && {
      taskFirst: true as const,
      reviewedSavedPrompt: input.reviewedSavedPrompt,
    }),
    ...(input.targetMember !== undefined && { targetMember: input.targetMember }),
    label: input.label,
    cronExpression,
    timezone,
    status: 'active',
    warmUpMinutes: input.warmUpMinutes ?? 15,
    maxConsecutiveFailures: 3,
    consecutiveFailures: 0,
    ...initialScheduleLimits(selected),
    createdAt: now,
    updatedAt: now,
    launchConfig: input.launchConfig,
  };
  schedule.nextRunAt = computeScheduleNextRunAt(schedule) ?? undefined;
  return schedule;
}

export function buildUpdatedSchedule(
  existing: Schedule,
  patch: UpdateSchedulePatch,
  hostTarget: Schedule['hostTarget'],
  cronChanged: boolean,
  cronExpression: string,
  timezone: string
): Schedule {
  const updated: Schedule = {
    ...existing,
    ...(hostTarget ? { hostTarget: structuredClone(hostTarget) } : {}),
    ...(patch.executionMode !== undefined && { executionMode: patch.executionMode }),
    ...(patch.targetMember !== undefined && { targetMember: patch.targetMember }),
    ...(patch.reviewedSavedPrompt && { reviewedSavedPrompt: true as const }),
    ...(patch.label !== undefined && { label: patch.label }),
    ...(cronChanged && { cronExpression, timezone }),
    ...(patch.warmUpMinutes !== undefined && { warmUpMinutes: patch.warmUpMinutes }),
    ...patchScheduleLimits({ ...existing, hostTarget }, patch),
    ...(patch.launchConfig && {
      launchConfig: { ...existing.launchConfig, ...patch.launchConfig },
    }),
    updatedAt: new Date().toISOString(),
  };
  return updated;
}
