import { normalizePathForComparison } from '@shared/utils/platformPath';

import type {
  ApplyReviewDiskTransition,
  ApplyReviewRequest,
  FileChangeWithContent,
} from '@shared/types';

/** A persisted transaction must be proved safe before it can publish on recovery. */
export function assertReviewReplayEvidence(
  request: ApplyReviewRequest,
  fileContents: Map<string, FileChangeWithContent>,
  transitions: readonly ApplyReviewDiskTransition[]
): void {
  const replayable = transitions.filter(
    (transition) => transition.operation && transition.transactionId
  );
  if (replayable.length === 0) return;

  const decisions = request.decisions.filter((decision) => decision.fileDecision !== 'accepted');
  if (decisions.length === 0) throw new Error('Review replay evidence is unavailable');

  for (const decision of decisions) {
    const content = fileContents.get(decision.filePath);
    // Older non-ledger journals can contain a guessed baseline or a partial path
    // history. Neither can justify publishing a queued mutation after a crash.
    if (
      !content ||
      (content.contentSource !== 'ledger-exact' && content.contentSource !== 'ledger-snapshot') ||
      !content.snippets.some((snippet) => snippet.ledger && !snippet.isError)
    ) {
      throw new Error('Review replay evidence is unavailable');
    }
  }

  for (const transition of replayable) {
    const transitionPath = normalizePathForComparison(transition.filePath);
    const belongsToDecision = decisions.some((decision) => {
      const content = fileContents.get(decision.filePath);
      return (
        normalizePathForComparison(decision.filePath) === transitionPath ||
        content?.snippets.some(
          (snippet) =>
            snippet.ledger &&
            !snippet.isError &&
            normalizePathForComparison(snippet.filePath) === transitionPath
        )
      );
    });
    if (!belongsToDecision) throw new Error('Review replay evidence path does not match decision');
  }
}
