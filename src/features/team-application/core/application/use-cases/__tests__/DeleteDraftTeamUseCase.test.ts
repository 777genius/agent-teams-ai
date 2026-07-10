import { describe, expect, it, vi } from 'vitest';

import { DeleteDraftTeamUseCase } from '../DeleteDraftTeamUseCase';

import type { TeamDraftRepositoryPort } from '../../ports/TeamDraftRepositoryPort';

function createDraftRepository(state: 'draft' | 'materialized'): TeamDraftRepositoryPort {
  return {
    getDraftState: vi.fn(async () => state),
    permanentlyDeleteTeam: vi.fn(async () => undefined),
  };
}

describe('DeleteDraftTeamUseCase', () => {
  it('permanently deletes teams that are still drafts', async () => {
    const draftRepository = createDraftRepository('draft');
    const useCase = new DeleteDraftTeamUseCase({ draftRepository });

    await useCase.execute('team-a');

    expect(draftRepository.getDraftState).toHaveBeenCalledWith('team-a');
    expect(draftRepository.permanentlyDeleteTeam).toHaveBeenCalledWith('team-a');
  });

  it('normalizes valid team names before checking draft state', async () => {
    const draftRepository = createDraftRepository('draft');
    const useCase = new DeleteDraftTeamUseCase({ draftRepository });

    await useCase.execute(' team-a ');

    expect(draftRepository.getDraftState).toHaveBeenCalledWith('team-a');
    expect(draftRepository.permanentlyDeleteTeam).toHaveBeenCalledWith('team-a');
  });

  it('refuses to delete materialized teams through the draft path', async () => {
    const draftRepository = createDraftRepository('materialized');
    const useCase = new DeleteDraftTeamUseCase({ draftRepository });

    await expect(useCase.execute('team-a')).rejects.toThrow(
      'Cannot delete draft: team has config.json (use deleteTeam instead)'
    );

    expect(draftRepository.permanentlyDeleteTeam).not.toHaveBeenCalled();
  });

  it.each(['../outside', 'team/a', 'Team', 'con'])(
    'rejects unsafe team names before touching the repository: %s',
    async (teamName) => {
      const draftRepository = createDraftRepository('draft');
      const useCase = new DeleteDraftTeamUseCase({ draftRepository });

      await expect(useCase.execute(teamName)).rejects.toThrow(/teamName/);

      expect(draftRepository.getDraftState).not.toHaveBeenCalled();
      expect(draftRepository.permanentlyDeleteTeam).not.toHaveBeenCalled();
    }
  );
});
