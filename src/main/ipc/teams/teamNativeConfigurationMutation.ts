import { createLogger } from '@shared/utils/logger';

import type { TeamConfigurationUpdate } from '@main/services/team/TeamConfigurationMutations';
import type { TeamDataService } from '@main/services/team/TeamDataService';

const logger = createLogger('TeamNativeConfigurationMutation');

/** Shared persisted metadata update and best-effort rename notice to a running lead. */
export async function updateNativeTeamConfiguration(
  teamName: string,
  updates: TeamConfigurationUpdate,
  ports: {
    data: Pick<TeamDataService, 'getTeamDisplayName' | 'updateConfig'>;
    isTeamAlive(teamName: string): boolean;
    notify(teamName: string, message: string): Promise<unknown>;
    invalidate(teamName: string): void;
  }
) {
  const previous = await ports.data.getTeamDisplayName(teamName).catch(() => teamName);
  const result = await ports.data.updateConfig(teamName, updates);
  if (!result) throw new Error('Team config not found');
  const requestedName = updates.name?.trim();
  if (
    requestedName &&
    requestedName !== (previous?.trim() || teamName) &&
    ports.isTeamAlive(teamName)
  ) {
    try {
      await ports.notify(
        teamName,
        `The team has been renamed to "${requestedName}". Please use this name when referring to the team going forward.`
      );
    } catch {
      logger.warn(`Failed to notify lead about team rename for ${teamName}`);
    }
  }
  ports.invalidate(teamName);
  return result;
}
