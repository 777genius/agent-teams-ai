import { useStore } from '@renderer/store';
import {
  applyLeadRuntimeSettingsToLaunchParams,
  areTeamLaunchParamsEqual,
  saveTeamLaunchParams,
} from '@renderer/store/team/teamLaunchParams';

import type { LeadRuntimeLaunchSettings } from '@renderer/store/team/teamLaunchParams';

/** The launch dialog of the team starts from the lead model and effort that were just saved. */
export function applyCommittedLeadRuntime(
  teamName: string,
  committedLeadRuntime?: LeadRuntimeLaunchSettings
): void {
  if (!committedLeadRuntime) return;
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

export async function refreshTeamMemberSettings(
  teamName: string,
  committedLeadRuntime?: LeadRuntimeLaunchSettings
): Promise<void> {
  applyCommittedLeadRuntime(teamName, committedLeadRuntime);
  await useStore.getState().refreshTeamData(teamName, { withDedup: false });
}
