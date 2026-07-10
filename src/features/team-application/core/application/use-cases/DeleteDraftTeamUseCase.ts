import { validateTeamApplicationTeamName } from '../../domain/TeamName';

import type { TeamDraftRepositoryPort } from '../ports/TeamDraftRepositoryPort';

export interface DeleteDraftTeamUseCaseDeps {
  draftRepository: TeamDraftRepositoryPort;
}

export class DeleteDraftTeamUseCase {
  constructor(private readonly deps: DeleteDraftTeamUseCaseDeps) {}

  async execute(teamName: unknown): Promise<void> {
    const validated = validateTeamApplicationTeamName(teamName);
    if (!validated.valid) {
      throw new Error(validated.error ?? 'Invalid teamName');
    }

    const draftState = await this.deps.draftRepository.getDraftState(validated.value!);
    if (draftState !== 'draft') {
      throw new Error('Cannot delete draft: team has config.json (use deleteTeam instead)');
    }

    await this.deps.draftRepository.permanentlyDeleteTeam(validated.value!);
  }
}
