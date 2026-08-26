import { choosePreferredLaunchSnapshot } from '../TeamBootstrapStateReader';

import type { PersistedTeamLaunchSnapshot } from '@shared/types';

/** Selects normal rich evidence unless it loses the exact active-run binding. */
export function chooseActiveRunLaunchSnapshot(
  bootstrapSnapshot: PersistedTeamLaunchSnapshot | null,
  launchSnapshot: PersistedTeamLaunchSnapshot | null,
  activeRuntimeRunId: string
): PersistedTeamLaunchSnapshot | null {
  const preferred = choosePreferredLaunchSnapshot(bootstrapSnapshot, launchSnapshot);
  const activeRunId = activeRuntimeRunId.trim();
  if (!activeRunId) return preferred;
  if (launchSnapshot?.runtimeRunId === activeRunId) return launchSnapshot;
  if (bootstrapSnapshot?.runtimeRunId === activeRunId) return bootstrapSnapshot;
  return preferred;
}
