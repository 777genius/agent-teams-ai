import type { TeamConfigurationLoggerPort } from '../../../../core/application/ports/TeamConfigurationPorts';
import type { TeamConfig, TeamCreateConfigRequest, TeamCreateRequest } from '@shared/types';

export interface TeamConfigurationIpcDependencies {
  createConfig: { execute(request: TeamCreateConfigRequest): Promise<void> };
  updateConfig: {
    execute(
      teamName: string,
      updates: { name?: string; description?: string; color?: string }
    ): Promise<TeamConfig>;
  };
  getSavedRequest: { execute(teamName: string): Promise<TeamCreateRequest | null> };
  deleteDraft: { execute(teamName: string): Promise<void> };
  logger: TeamConfigurationLoggerPort;
}
