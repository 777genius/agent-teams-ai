import type { TeamImportDraftRepositoryPort } from '../../core/application/ports/TeamImportDraftRepositoryPort';
import type { TeamImportPreview } from '@features/team-import/contracts';
import type { TeamDataService } from '@main/services/team/TeamDataService';

export class TeamDataImportDraftRepository implements TeamImportDraftRepositoryPort {
  constructor(
    private readonly teamDataService: TeamDataService,
    private readonly onTeamCreated?: (teamName: string) => void
  ) {}

  async createDraft(teamName: string, preview: TeamImportPreview): Promise<void> {
    await this.teamDataService.createTeamConfig({
      teamName,
      displayName: teamName,
      cwd: preview.projectPath,
      members: preview.members,
      prompt: preview.prompt,
    });
    this.onTeamCreated?.(teamName);
  }
}
