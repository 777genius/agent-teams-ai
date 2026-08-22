import type { TeamLaunchParams } from '@features/team-provisioning/renderer';

export {
  applyLeadRuntimeSettingsToLaunchParams,
  areTeamLaunchParamsEqual,
  buildLaunchParamsFromRuntimeRequest,
  extractBaseModel,
  type LeadRuntimeLaunchSettings,
  type TeamLaunchParams,
} from '@features/team-provisioning/renderer';

export function saveTeamLaunchParams(teamName: string, params: TeamLaunchParams): void {
  try {
    localStorage.setItem(`team:launchParams:${teamName}`, JSON.stringify(params));
  } catch {
    // Best-effort renderer persistence; main metadata remains authoritative.
  }
}
