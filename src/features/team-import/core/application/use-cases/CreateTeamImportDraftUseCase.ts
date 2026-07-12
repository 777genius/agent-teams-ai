import { validateTeamImportName } from '../../domain/teamImportPolicy';

import type { TeamImportDraftRepositoryPort } from '../ports/TeamImportDraftRepositoryPort';
import type { TeamImportReviewStorePort } from '../ports/TeamImportReviewStorePort';
import type {
  CreateTeamImportDraftRequest,
  CreateTeamImportDraftResult,
} from '@features/team-import/contracts';

export class CreateTeamImportDraftUseCase {
  constructor(
    private readonly reviewStore: TeamImportReviewStorePort,
    private readonly draftRepository: TeamImportDraftRepositoryPort
  ) {}

  async execute(request: CreateTeamImportDraftRequest): Promise<CreateTeamImportDraftResult> {
    const reviewId = request.reviewId.trim();
    if (!reviewId) throw new Error('Import review is required.');

    const teamName = request.teamName.trim();
    const teamNameError = validateTeamImportName(teamName);
    if (teamNameError) throw new Error(teamNameError);

    const preview = this.reviewStore.get(reviewId);
    if (!preview) throw new Error('This import preview expired. Choose the folder again.');
    if (preview.blockingErrors.length > 0) {
      throw new Error(preview.blockingErrors[0]);
    }

    await this.draftRepository.createDraft(teamName, preview);
    this.reviewStore.delete(reviewId);
    return { teamName };
  }
}
