import type { CreateScheduleInput, HostScheduleTarget, Schedule, TeamProviderId, UpdateSchedulePatch } from '../types';

/** Pinned native Codex has no one-shot turn, dollar-budget or tool-list controls. */
export function supportsScheduleExecutionLimits(host: boolean, provider: TeamProviderId | undefined) {
  return !host || provider !== 'codex';
}

type Limits = Pick<Schedule, 'maxTurns' | 'maxBudgetUsd'>;
type Selection = Pick<Schedule, 'hostTarget' | 'launchConfig' | 'executionMode' | 'taskFirst'>;
function validate(selection: Selection, limits: Limits) {
  if (limits.maxTurns !== undefined && (!Number.isSafeInteger(limits.maxTurns) || limits.maxTurns < 1))
    throw new Error('Maximum turns must be a positive whole number.');
  if (limits.maxBudgetUsd !== undefined && (!Number.isFinite(limits.maxBudgetUsd) || limits.maxBudgetUsd < 0))
    throw new Error('Maximum budget must be zero or a positive number.');
  if (!selection.taskFirst && selection.executionMode !== 'team' &&
    !supportsScheduleExecutionLimits(Boolean(selection.hostTarget), selection.launchConfig.providerId) &&
    (limits.maxTurns !== undefined || limits.maxBudgetUsd !== undefined ||
      selection.launchConfig.allowedTools?.length || selection.launchConfig.disallowedTools?.length))
    throw new Error('Codex standalone runs do not support turn, budget or tool-list limits. Open this schedule and save it to clear those settings.');
  return limits;
}

export function initialScheduleLimits(input: CreateScheduleInput & { hostTarget?: HostScheduleTarget }): Limits {
  return validate(input, {
    maxTurns: input.maxTurns ?? (supportsScheduleExecutionLimits(Boolean(input.hostTarget), input.launchConfig.providerId) ? 50 : undefined),
    maxBudgetUsd: input.maxBudgetUsd,
  });
}

/** Null explicitly clears a saved value; omission leaves that value unchanged. */
export function patchScheduleLimits(existing: Schedule, patch: UpdateSchedulePatch): Limits {
  return validate({ ...existing, ...patch, launchConfig: { ...existing.launchConfig, ...patch.launchConfig } }, {
    maxTurns: patch.maxTurns === null ? undefined : patch.maxTurns ?? existing.maxTurns,
    maxBudgetUsd: patch.maxBudgetUsd === null ? undefined : patch.maxBudgetUsd ?? existing.maxBudgetUsd,
  });
}
