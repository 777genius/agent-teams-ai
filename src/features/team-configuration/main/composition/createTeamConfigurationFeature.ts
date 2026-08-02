import { CreateTeamConfigUseCase } from '../../core/application/use-cases/CreateTeamConfigUseCase';
import { DeleteDraftTeamUseCase } from '../../core/application/use-cases/DeleteDraftTeamUseCase';
import { GetSavedTeamRequestUseCase } from '../../core/application/use-cases/GetSavedTeamRequestUseCase';
import { UpdateTeamConfigUseCase } from '../../core/application/use-cases/UpdateTeamConfigUseCase';
import { TeamDataWorkerConfigCache } from '../adapters/output/TeamDataWorkerConfigCache';

import type {
  DraftTeamConfigGuardPort,
  TeamConfigurationCachePort,
  TeamConfigurationLoggerPort,
  TeamConfigurationMessagingPort,
  TeamConfigurationRepositoryPort,
  TeamConfigurationRuntimePort,
} from '../../core/application/ports/TeamConfigurationPorts';
import type { TeamConfigurationFeature } from './TeamConfigurationIpcBoundary';

export type { TeamConfigurationFeature } from './TeamConfigurationIpcBoundary';

export function createTeamConfigurationFeature(dependencies: {
  repository: TeamConfigurationRepositoryPort;
  runtime: TeamConfigurationRuntimePort;
  messaging: TeamConfigurationMessagingPort;
  logger: TeamConfigurationLoggerPort;
  cache?: TeamConfigurationCachePort;
  draftGuard: DraftTeamConfigGuardPort;
}): TeamConfigurationFeature {
  const cache = dependencies.cache ?? new TeamDataWorkerConfigCache();
  const createConfig = new CreateTeamConfigUseCase({ repository: dependencies.repository, cache });
  const updateConfig = new UpdateTeamConfigUseCase({
    repository: dependencies.repository,
    runtime: dependencies.runtime,
    messaging: dependencies.messaging,
    cache,
    logger: dependencies.logger,
  });
  const getSavedRequest = new GetSavedTeamRequestUseCase(dependencies.repository);
  const deleteDraft = new DeleteDraftTeamUseCase({
    repository: dependencies.repository,
    draftGuard: dependencies.draftGuard,
  });

  return {
    createConfig: { execute: (request) => createConfig.execute(request) },
    updateConfig: {
      execute: (teamName, updates) => updateConfig.execute(teamName, updates),
    },
    getSavedRequest: { execute: (teamName) => getSavedRequest.execute(teamName) },
    deleteDraft: { execute: (teamName) => deleteDraft.execute(teamName) },
    logger: dependencies.logger,
  };
}
