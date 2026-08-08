import type {
  DraftTeamConfigGuardPort,
  DraftTeamDeletionRepositoryPort,
} from '../ports/TeamConfigurationPorts';

export class DeleteDraftTeamUseCase {
  constructor(
    private readonly dependencies: {
      repository: DraftTeamDeletionRepositoryPort;
      draftGuard: DraftTeamConfigGuardPort;
    }
  ) {}

  async execute(teamName: string): Promise<void> {
    await this.dependencies.draftGuard.assertDraftCanBeDeleted(teamName);
    await this.dependencies.repository.permanentlyDeleteTeam(teamName);
  }
}
