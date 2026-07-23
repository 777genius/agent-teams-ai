import type {
  TeamConfigCreationRepositoryPort,
  TeamConfigurationCachePort,
} from '../ports/TeamConfigurationPorts';
import type { TeamCreateConfigRequest } from '@shared/types';

export class CreateTeamConfigUseCase {
  constructor(
    private readonly dependencies: {
      repository: TeamConfigCreationRepositoryPort;
      cache: TeamConfigurationCachePort;
    }
  ) {}

  async execute(request: TeamCreateConfigRequest): Promise<void> {
    await this.dependencies.repository.createTeamConfig(request);
    this.dependencies.cache.invalidateTeamConfig(request.teamName);
  }
}
