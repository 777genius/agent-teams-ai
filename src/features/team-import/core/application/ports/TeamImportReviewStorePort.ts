import type { TeamImportPreview } from '@features/team-import/contracts';

export interface TeamImportReviewStorePort {
  save(preview: Omit<TeamImportPreview, 'reviewId'>): TeamImportPreview;
  get(reviewId: string): TeamImportPreview | null;
  delete(reviewId: string): void;
}
