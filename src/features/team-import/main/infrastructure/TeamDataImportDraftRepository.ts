import { materializeDraftRuntimeSelectionProvenance } from '@shared/utils/draftRuntimeSelectionProvenance';

import type { TeamImportDraftRepositoryPort } from '../../core/application/ports/TeamImportDraftRepositoryPort';
import type { TeamImportPreview } from '@features/team-import/contracts';
import type { TeamDataService } from '@main/services/team/TeamDataService';

export class TeamDataImportDraftRepository implements TeamImportDraftRepositoryPort {
  constructor(
    private readonly teamDataService: TeamDataService,
    private readonly onTeamCreated?: (teamName: string) => void
  ) {}

  async createDraft(teamName: string, preview: TeamImportPreview): Promise<void> {
    await this.teamDataService.createTeamConfig(
      materializeDraftRuntimeSelectionProvenance(
        {
          teamName,
          displayName: teamName,
          cwd: preview.projectPath,
          members: preview.members,
          prompt: preview.prompt,
        },
        {
          lead: {
            supplied: false,
            value: undefined,
            missingIntent: {
              providerBackendId: 'default',
              model: 'default',
              effort: 'default',
            },
          },
          members: preview.members.map((member) => {
            const supplied = Object.hasOwn(member, 'runtimeSelectionProvenance');
            const hasLegacyConcreteSelection =
              member.providerBackendId !== undefined ||
              Boolean(member.model?.trim()) ||
              member.effort !== undefined;
            return {
              supplied,
              value: member.runtimeSelectionProvenance,
              ...(!supplied && !hasLegacyConcreteSelection
                ? {
                    missingIntent: {
                      providerBackendId: 'inherited' as const,
                      model: 'inherited' as const,
                      effort: 'inherited' as const,
                    },
                  }
                : !supplied
                  ? { missingReason: 'partial' as const }
                  : {}),
            };
          }),
        }
      )
    );
    this.onTeamCreated?.(teamName);
  }
}
