import type { TeamImportPreview } from '@features/team-import/contracts';

export interface TeamImportReviewStorePort {
  save(preview: Omit<TeamImportPreview, 'reviewId'>): TeamImportPreview;
  consume(reviewId: string): TeamImportPreview | null;
  restore(preview: TeamImportPreview): void;
}
