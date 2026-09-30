import type { ReviewMutationDiskPostimage } from '@shared/types';

export function markChangeReviewMutationDiskPostimages(
  postimages: readonly ReviewMutationDiskPostimage[] | undefined,
  markExpectedWrite: (filePath: string, expectedContent: string | null) => void
): void {
  for (const postimage of postimages ?? []) {
    markExpectedWrite(postimage.filePath, postimage.content);
  }
}
