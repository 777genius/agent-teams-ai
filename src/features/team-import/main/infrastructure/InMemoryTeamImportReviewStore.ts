import { randomUUID } from 'node:crypto';

import type { TeamImportReviewStorePort } from '../../core/application/ports/TeamImportReviewStorePort';
import type { TeamImportPreview } from '@features/team-import/contracts';

interface StoredReview {
  preview: TeamImportPreview;
  createdAt: number;
}

const REVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_STORED_REVIEWS = 10;

export class InMemoryTeamImportReviewStore implements TeamImportReviewStorePort {
  private readonly reviews = new Map<string, StoredReview>();

  save(preview: Omit<TeamImportPreview, 'reviewId'>): TeamImportPreview {
    this.prune();
    while (this.reviews.size >= MAX_STORED_REVIEWS) {
      const oldest = this.reviews.keys().next();
      if (oldest.done) break;
      this.reviews.delete(oldest.value);
    }
    const storedPreview: TeamImportPreview = { ...preview, reviewId: randomUUID() };
    this.reviews.set(storedPreview.reviewId, { preview: storedPreview, createdAt: Date.now() });
    return storedPreview;
  }

  consume(reviewId: string): TeamImportPreview | null {
    this.prune();
    const stored = this.reviews.get(reviewId);
    if (!stored) return null;
    this.reviews.delete(reviewId);
    return stored.preview;
  }

  restore(preview: TeamImportPreview): void {
    this.prune();
    if (this.reviews.has(preview.reviewId)) return;
    this.reviews.set(preview.reviewId, { preview, createdAt: Date.now() });
  }

  private prune(): void {
    const cutoff = Date.now() - REVIEW_TTL_MS;
    for (const [reviewId, stored] of this.reviews) {
      if (stored.createdAt < cutoff) this.reviews.delete(reviewId);
    }
  }
}
