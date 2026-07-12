import { CreateTeamImportDraftUseCase } from '../../core/application/use-cases/CreateTeamImportDraftUseCase';
import { ReviewTeamImportUseCase } from '../../core/application/use-cases/ReviewTeamImportUseCase';
import { ElectronTeamImportFolderPicker } from '../infrastructure/ElectronTeamImportFolderPicker';
import { InMemoryTeamImportReviewStore } from '../infrastructure/InMemoryTeamImportReviewStore';
import { SafeLocalTeamImportFolderSource } from '../infrastructure/SafeLocalTeamImportFolderSource';
import { TeamDataImportDraftRepository } from '../infrastructure/TeamDataImportDraftRepository';

import type {
  CreateTeamImportDraftRequest,
  CreateTeamImportDraftResult,
  TeamImportPreview,
} from '@features/team-import/contracts';
import type { TeamDataService } from '@main/services/team/TeamDataService';

export interface TeamImportFeatureFacade {
  chooseFolderAndPreview(): Promise<TeamImportPreview | null>;
  createDraft(request: CreateTeamImportDraftRequest): Promise<CreateTeamImportDraftResult>;
}

export function createTeamImportFeature(teamDataService: TeamDataService): TeamImportFeatureFacade {
  const reviewStore = new InMemoryTeamImportReviewStore();
  const reviewUseCase = new ReviewTeamImportUseCase(
    new ElectronTeamImportFolderPicker(),
    new SafeLocalTeamImportFolderSource(),
    reviewStore
  );
  const createDraftUseCase = new CreateTeamImportDraftUseCase(
    reviewStore,
    new TeamDataImportDraftRepository(teamDataService)
  );

  return {
    chooseFolderAndPreview: () => reviewUseCase.execute(),
    createDraft: (request) => createDraftUseCase.execute(request),
  };
}
