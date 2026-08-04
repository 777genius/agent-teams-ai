import type { TeamImportDraftRepositoryPort } from '../../core/application/ports/TeamImportDraftRepositoryPort';
import type { TeamImportTeamDataPort } from '../application/TeamImportTeamDataPort';
import type { TeamImportPreview } from '@features/team-import/contracts';

export class TeamDataImportDraftRepository implements TeamImportDraftRepositoryPort {
  constructor(
    private readonly teamData: TeamImportTeamDataPort,
    private readonly onTeamCreated?: (teamName: string) => void
  ) {}

  async createDraft(teamName: string, preview: TeamImportPreview): Promise<void> {
    await this.teamData.createTeamConfig({
      teamName,
      displayName: teamName,
      cwd: preview.projectPath,
      members: preview.members,
      prompt: preview.prompt,
    });
    this.onTeamCreated?.(teamName);
  }
}
