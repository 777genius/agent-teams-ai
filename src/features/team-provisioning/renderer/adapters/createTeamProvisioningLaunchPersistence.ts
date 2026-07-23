import type { TeamProvisioningLaunchPersistencePort } from '../ports/TeamProvisioningLaunchPorts';
import type { TeamLaunchParams } from '../utils/teamLaunchParams';
import type { ToolApprovalSettings } from '@shared/types';

const LAUNCH_PARAMS_PREFIX = 'team:launchParams:';
const TOOL_APPROVAL_PREFIX = 'team:toolApprovalSettings:';

export function loadAllTeamLaunchParams(): Record<string, TeamLaunchParams> {
  const result: Record<string, TeamLaunchParams> = {};
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(LAUNCH_PARAMS_PREFIX)) continue;

      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const teamName = key.slice(LAUNCH_PARAMS_PREFIX.length);
        const parsed = JSON.parse(raw) as TeamLaunchParams;
        if (parsed && typeof parsed === 'object') {
          result[teamName] = parsed;
        }
      } catch {
        // Best-effort restore: ignore only the malformed team entry.
      }
    }
  } catch {
    // Storage may be unavailable in restricted renderer contexts.
  }
  return result;
}

export function saveTeamLaunchParams(teamName: string, params: TeamLaunchParams): void {
  try {
    localStorage.setItem(LAUNCH_PARAMS_PREFIX + teamName, JSON.stringify(params));
  } catch {
    // Best-effort persistence.
  }
}

export function saveTeamToolApprovalSettings(
  teamName: string,
  settings: ToolApprovalSettings
): void {
  try {
    localStorage.setItem(TOOL_APPROVAL_PREFIX + teamName, JSON.stringify(settings));
  } catch {
    // Best-effort persistence.
  }
}

export function createTeamProvisioningLaunchPersistence(): TeamProvisioningLaunchPersistencePort {
  return {
    loadAllLaunchParams: loadAllTeamLaunchParams,
    saveLaunchParams: saveTeamLaunchParams,
    saveToolApprovalSettings: saveTeamToolApprovalSettings,
  };
}
