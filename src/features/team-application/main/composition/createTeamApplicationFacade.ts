import { getTeamsBasePath } from '@main/utils/pathDecoder';

import { DeleteDraftTeamUseCase } from '../../core/application/use-cases/DeleteDraftTeamUseCase';
import { FileSystemTeamDraftRepository } from '../infrastructure/FileSystemTeamDraftRepository';

import type { TeamDataService } from '@main/services';

export interface TeamApplicationFacade {
  deleteDraftTeam(teamName: unknown): Promise<void>;
}

export function createTeamApplicationFacade(deps: {
  teamDataService: TeamDataService;
}): TeamApplicationFacade {
  const draftRepository = new FileSystemTeamDraftRepository({
    getTeamsBasePath,
    permanentlyDeleteTeam: (teamName) => deps.teamDataService.permanentlyDeleteTeam(teamName),
  });
  const deleteDraftTeamUseCase = new DeleteDraftTeamUseCase({ draftRepository });

  return {
    deleteDraftTeam: (teamName) => deleteDraftTeamUseCase.execute(teamName),
  };
}
