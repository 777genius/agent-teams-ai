import { CreateTeamConfigUseCase } from '../../core/application/use-cases/CreateTeamConfigUseCase';
import { DeleteDraftTeamUseCase } from '../../core/application/use-cases/DeleteDraftTeamUseCase';
import { GetSavedTeamRequestUseCase } from '../../core/application/use-cases/GetSavedTeamRequestUseCase';
import { UpdateTeamConfigUseCase } from '../../core/application/use-cases/UpdateTeamConfigUseCase';
import { TeamDataWorkerConfigCache } from '../adapters/output/TeamDataWorkerConfigCache';
import { FileSystemDraftTeamConfigGuard } from '../infrastructure/FileSystemDraftTeamConfigGuard';

import type {
  DraftTeamConfigGuardPort,
  TeamConfigurationCachePort,
  TeamConfigurationLoggerPort,
  TeamConfigurationMessagingPort,
  TeamConfigurationRepositoryPort,
  TeamConfigurationRuntimePort,
} from '../../core/application/ports/TeamConfigurationPorts';
import type { TeamConfigurationIpcDependencies } from '../adapters/input/ipc/TeamConfigurationIpcDependencies';

export type TeamConfigurationFeature = TeamConfigurationIpcDependencies;

export function createTeamConfigurationFeature(dependencies: {
  repository: TeamConfigurationRepositoryPort;
  runtime: TeamConfigurationRuntimePort;
  messaging: TeamConfigurationMessagingPort;
  logger: TeamConfigurationLoggerPort;
  cache?: TeamConfigurationCachePort;
  draftGuard?: DraftTeamConfigGuardPort;
}): TeamConfigurationFeature {
  const cache = dependencies.cache ?? new TeamDataWorkerConfigCache();
  const draftGuard = dependencies.draftGuard ?? new FileSystemDraftTeamConfigGuard();

  return {
    createConfig: new CreateTeamConfigUseCase({ repository: dependencies.repository, cache }),
    updateConfig: new UpdateTeamConfigUseCase({
      repository: dependencies.repository,
      runtime: dependencies.runtime,
      messaging: dependencies.messaging,
      cache,
      logger: dependencies.logger,
    }),
    getSavedRequest: new GetSavedTeamRequestUseCase(dependencies.repository),
    deleteDraft: new DeleteDraftTeamUseCase({
      repository: dependencies.repository,
      draftGuard,
    }),
    logger: dependencies.logger,
  };
}
