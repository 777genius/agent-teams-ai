import {
  applyLeadRuntimeSettingsToLaunchParams,
  areTeamLaunchParamsEqual,
} from './utils/teamLaunchParams';

import type { LeadRuntimeLaunchSettings, TeamLaunchParams } from './utils/teamLaunchParams';

function saveTeamLaunchParams(teamName: string, params: TeamLaunchParams): void {
  try {
    localStorage.setItem(`team:launchParams:${teamName}`, JSON.stringify(params));
  } catch {
    // Best-effort renderer persistence; main metadata remains authoritative.
  }
}

export async function refreshTeamMemberSettings(
  teamName: string,
  committedLeadRuntime?: LeadRuntimeLaunchSettings
): Promise<void> {
  const { useStore } = await import('@renderer/store');
  if (committedLeadRuntime) {
    const state = useStore.getState();
    const current = state.launchParamsByTeam[teamName];
    const next = applyLeadRuntimeSettingsToLaunchParams(current, committedLeadRuntime);
    if (next && !areTeamLaunchParamsEqual(current, next)) {
      saveTeamLaunchParams(teamName, next);
      useStore.setState((latest) => ({
        launchParamsByTeam: { ...latest.launchParamsByTeam, [teamName]: next },
      }));
    }
  }
  await useStore.getState().refreshTeamData(teamName, { withDedup: false });
}
