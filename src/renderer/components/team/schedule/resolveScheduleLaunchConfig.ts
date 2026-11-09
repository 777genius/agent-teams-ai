import type { Schedule, ScheduleLaunchConfig, TeamProviderId } from '@shared/types';

type ScheduleMode = 'legacy' | 'agent' | 'team';

export interface ScheduleRuntimeEdits {
  provider: boolean;
  model: boolean;
  effort: boolean;
  fastMode: boolean;
  skipPermissions: boolean;
}

/** Explicit edits in the visible picker migrate a hidden provider together with its model. */
export function markScheduleProviderSwitch(
  edited: ScheduleRuntimeEdits,
  persistedProvider: TeamProviderId | undefined,
  visibleProvider: TeamProviderId
): void {
  if (persistedProvider === visibleProvider) return;
  edited.provider = true;
  edited.model = true;
  edited.effort = true;
  edited.fastMode = true;
}

interface ResolveScheduleLaunchConfigInput {
  schedule: Schedule | null;
  mode: ScheduleMode;
  taskFirst: boolean;
  savedTeam: Pick<ScheduleLaunchConfig, 'providerId' | 'providerBackendId'> | null;
  edited: ScheduleRuntimeEdits;
  proposed: ScheduleLaunchConfig;
}

/** Keep the exact legacy runtime configuration until the user changes it. */
export function resolveScheduleLaunchConfig({
  schedule, mode, taskFirst, savedTeam, edited, proposed,
}: ResolveScheduleLaunchConfigInput): ScheduleLaunchConfig {
  const preserveTeam = Boolean(
    schedule?.executionMode === 'team' && mode === 'team' && !schedule.taskFirst
  );
  const preserveOneShot = Boolean(
    schedule && !taskFirst && mode !== 'team' &&
    mode === (schedule.executionMode ?? 'legacy')
  );
  const oldConfig = preserveTeam || preserveOneShot ? schedule?.launchConfig ?? null : null;
  const original = (field: keyof ScheduleRuntimeEdits): ScheduleLaunchConfig | null =>
    preserveTeam || (preserveOneShot && !edited[field]) ? oldConfig : null;
  const oldProvider = original('provider');
  const oldModel = original('model');
  const oldEffort = original('effort');
  const oldFastMode = original('fastMode');
  const oldPermissions = original('skipPermissions');

  return {
    ...proposed,
    providerId: taskFirst ? savedTeam?.providerId
      : oldProvider ? oldProvider.providerId : proposed.providerId,
    providerBackendId: taskFirst ? savedTeam?.providerBackendId
      : oldProvider ? oldProvider.providerBackendId : proposed.providerBackendId,
    model: taskFirst ? undefined : oldModel ? oldModel.model : proposed.model,
    effort: taskFirst ? undefined : oldEffort ? oldEffort.effort : proposed.effort,
    fastMode: taskFirst ? undefined : oldFastMode ? oldFastMode.fastMode : proposed.fastMode,
    // An explicit model/provider/effort change can invalidate the previous
    // Fast-mode eligibility. Keep the selected preference, not stale resolution.
    resolvedFastMode: taskFirst ? undefined
      : oldFastMode && !(edited.model || edited.provider || edited.effort || edited.fastMode)
        ? oldFastMode.resolvedFastMode : proposed.resolvedFastMode,
    skipPermissions: taskFirst ? undefined
      : oldPermissions ? oldPermissions.skipPermissions : proposed.skipPermissions,
  };
}
