import type {
  TeamConfigCreationRepositoryPort,
  TeamConfigurationCachePort,
  TeamConfigurationCreateConfigRequest,
} from '../ports/TeamConfigurationPorts';

export class CreateTeamConfigUseCase {
  constructor(
    private readonly dependencies: {
      repository: TeamConfigCreationRepositoryPort;
      cache: TeamConfigurationCachePort;
    }
  ) {}

  async execute(request: TeamConfigurationCreateConfigRequest): Promise<void> {
    await this.dependencies.repository.createTeamConfig(request);
    this.dependencies.cache.invalidateTeamConfig(request.teamName);
  }
}
