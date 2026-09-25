import type {
  SavedTeamRequestRepositoryPort,
  TeamConfigurationSavedRequest,
} from '../ports/TeamConfigurationPorts';

export class GetSavedTeamRequestUseCase {
  constructor(private readonly repository: SavedTeamRequestRepositoryPort) {}

  execute(teamName: string): Promise<TeamConfigurationSavedRequest | null> {
    return this.repository.getSavedRequest(teamName);
  }
}
