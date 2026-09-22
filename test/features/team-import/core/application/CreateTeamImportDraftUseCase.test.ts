import { CreateTeamImportDraftUseCase } from '@features/team-import/core/application/use-cases/CreateTeamImportDraftUseCase';
import { InMemoryTeamImportReviewStore } from '@features/team-import/main/infrastructure/InMemoryTeamImportReviewStore';
import { describe, expect, it, vi } from 'vitest';

import type { TeamImportPreview } from '@features/team-import/contracts';
import type { TeamImportDraftRepositoryPort } from '@features/team-import/core/application/ports/TeamImportDraftRepositoryPort';

function previewInput(): Omit<TeamImportPreview, 'reviewId'> {
  return {
    suggestedTeamName: 'demo-team',
    projectPath: '/project',
    members: [{ name: 'writer', role: 'member', workflow: 'Write.' }],
    prompt: 'Coordinate the work.',
    skillsFound: [],
    warnings: [],
    blockingErrors: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe('CreateTeamImportDraftUseCase', () => {
  it('atomically consumes a review before awaiting draft persistence', async () => {
    const reviewStore = new InMemoryTeamImportReviewStore();
    const preview = reviewStore.save(previewInput());
    const pendingCreate = deferred<void>();
    const draftRepository: TeamImportDraftRepositoryPort = {
      createDraft: vi.fn(() => pendingCreate.promise),
    };
    const useCase = new CreateTeamImportDraftUseCase(reviewStore, draftRepository);

    const first = useCase.execute({ reviewId: preview.reviewId, teamName: 'first-team' });
    await expect(
      useCase.execute({ reviewId: preview.reviewId, teamName: 'second-team' })
    ).rejects.toThrow('expired');
    expect(draftRepository.createDraft).toHaveBeenCalledTimes(1);

    pendingCreate.resolve();
    await expect(first).resolves.toEqual({ teamName: 'first-team' });
  });

  it('restores a consumed review when persistence fails', async () => {
    const reviewStore = new InMemoryTeamImportReviewStore();
    const preview = reviewStore.save(previewInput());
    const draftRepository: TeamImportDraftRepositoryPort = {
      createDraft: vi
        .fn()
        .mockRejectedValueOnce(new Error('disk full'))
        .mockResolvedValueOnce(undefined),
    };
    const useCase = new CreateTeamImportDraftUseCase(reviewStore, draftRepository);
    const request = { reviewId: preview.reviewId, teamName: 'demo-team' };

    await expect(useCase.execute(request)).rejects.toThrow('disk full');
    await expect(useCase.execute(request)).resolves.toEqual({ teamName: 'demo-team' });
    expect(draftRepository.createDraft).toHaveBeenCalledTimes(2);
  });
});
