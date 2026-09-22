import {
  getReviewChangeSetIdentityToken,
  type ReviewChangeSetLike,
} from '@renderer/utils/reviewDecisionScope';

export function buildInitialReviewFileScrollKey(
  changeSet: ReviewChangeSetLike | null | undefined,
  initialFilePath: string | null | undefined
): string | null {
  if (!changeSet || !initialFilePath) return null;
  return `${getReviewChangeSetIdentityToken(changeSet) ?? 'unknown'}:${initialFilePath}`;
}
