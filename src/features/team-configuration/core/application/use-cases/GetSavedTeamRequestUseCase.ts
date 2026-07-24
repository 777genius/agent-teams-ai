import type { SavedTeamRequestRepositoryPort } from '../ports/TeamConfigurationPorts';
import type { TeamCreateRequest } from '@shared/types';

export class GetSavedTeamRequestUseCase {
  constructor(private readonly repository: SavedTeamRequestRepositoryPort) {}

  execute(teamName: string): Promise<TeamCreateRequest | null> {
    return this.repository.getSavedRequest(teamName);
  }
}
