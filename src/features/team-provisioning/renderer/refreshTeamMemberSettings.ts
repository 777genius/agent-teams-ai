import { useStore } from '@renderer/store';
import {
  applyLeadRuntimeSettingsToLaunchParams,
  areTeamLaunchParamsEqual,
  saveTeamLaunchParams,
} from '@renderer/store/team/teamLaunchParams';

import type { LeadRuntimeLaunchSettings } from '@renderer/store/team/teamLaunchParams';

export async function refreshTeamMemberSettings(
  teamName: string,
  committedLeadRuntime?: LeadRuntimeLaunchSettings
): Promise<void> {
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
