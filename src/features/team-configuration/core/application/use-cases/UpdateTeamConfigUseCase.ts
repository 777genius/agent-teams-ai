import type {
  TeamConfigUpdateRepositoryPort,
  TeamConfigurationCachePort,
  TeamConfigurationLoggerPort,
  TeamConfigurationMessagingPort,
  TeamConfigurationRuntimePort,
} from '../ports/TeamConfigurationPorts';
import type { TeamConfig, TeamUpdateConfigRequest } from '@shared/types';

export class UpdateTeamConfigUseCase {
  constructor(
    private readonly dependencies: {
      repository: TeamConfigUpdateRepositoryPort;
      runtime: TeamConfigurationRuntimePort;
      messaging: TeamConfigurationMessagingPort;
      cache: TeamConfigurationCachePort;
      logger: TeamConfigurationLoggerPort;
    }
  ) {}

  async execute(teamName: string, updates: TeamUpdateConfigRequest): Promise<TeamConfig> {
    const previousDisplayName = await this.dependencies.repository
      .getTeamDisplayName(teamName)
      .catch(() => teamName);
    const requestedName = typeof updates.name === 'string' ? updates.name.trim() : '';
    const result = await this.dependencies.repository.updateConfig(teamName, updates);
    if (!result) {
      throw new Error('Team config not found');
    }

    if (requestedName && requestedName !== (previousDisplayName?.trim() || teamName)) {
      if (this.dependencies.runtime.isTeamAlive(teamName)) {
        const message = `The team has been renamed to "${requestedName}". Please use this name when referring to the team going forward.`;
        try {
          await this.dependencies.messaging.sendMessageToTeam(teamName, message);
        } catch {
          this.dependencies.logger.warn(`Failed to notify lead about team rename for ${teamName}`);
        }
      }
    }

    this.dependencies.cache.invalidateTeamConfig(teamName);
    return result;
  }
}
