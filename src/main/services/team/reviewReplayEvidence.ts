import { hasCapturedCreationPostimage } from '@shared/utils/reviewContentEvidence';

import { taskChangeFileIdentity } from './taskChangeFileIdentity';

import type {
  ApplyReviewDiskTransition,
  ApplyReviewRequest,
  FileChangeWithContent,
  FileReviewDecision,
  SnippetDiff,
} from '@shared/types';

/** Re-read transcript history before replaying a pending non-ledger deletion. */
export function assertReviewRecoveryContent(
  decision: FileReviewDecision,
  saved: FileChangeWithContent,
  getAuthoritativeSnippets: () => readonly SnippetDiff[],
  alreadyApplied: boolean
): void {
  // Applied decisions are verified against their durable path postimages before commit.
  if (alreadyApplied) return;
  if (decision.fileDecision === 'accepted') return;
  if (saved.contentSource === 'ledger-exact' || saved.contentSource === 'ledger-snapshot') return;
  const authoritativeSnippets = getAuthoritativeSnippets();
  if (
    saved.contentSource !== 'snippet-reconstruction' ||
    !saved.isNewFile ||
    saved.originalFullContent !== '' ||
    saved.modifiedFullContent === null ||
    !hasCapturedCreationPostimage(
      authoritativeSnippets,
      saved.modifiedFullContent,
      decision.filePath
    ) ||
    JSON.stringify(saved.snippets) !== JSON.stringify(authoritativeSnippets)
  ) {
    throw new Error('Review recovery history no longer proves file creation');
  }
}

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
    // Replay only a ledger mutation or a captured creation with an exact delete transition.
    if (!content) throw new Error('Review replay evidence is unavailable');
    const ledger =
      (content.contentSource === 'ledger-exact' || content.contentSource === 'ledger-snapshot') &&
      content.snippets.some((snippet) => snippet.ledger && !snippet.isError);
    const capturedCreation =
      content.contentSource === 'snippet-reconstruction' &&
      content.isNewFile &&
      content.originalFullContent === '' &&
      hasCapturedCreationPostimage(
        content.snippets,
        content.modifiedFullContent,
        decision.filePath
      );
    const ownTransitions = replayable.filter(
      (transition) =>
        taskChangeFileIdentity(transition.filePath) === taskChangeFileIdentity(decision.filePath)
    );
    if (
      !ledger &&
      (!capturedCreation ||
        ownTransitions.some(
          (transition) =>
            transition.operation !== 'delete' ||
            transition.beforeContent !== content.modifiedFullContent ||
            transition.afterContent !== null
        ))
    ) {
      throw new Error('Review replay evidence is unavailable');
    }
  }

  for (const transition of replayable) {
    const transitionPath = taskChangeFileIdentity(transition.filePath);
    const belongsToDecision = decisions.some((decision) => {
      const content = fileContents.get(decision.filePath);
      return (
        taskChangeFileIdentity(decision.filePath) === transitionPath ||
        content?.snippets.some(
          (snippet) =>
            snippet.ledger &&
            !snippet.isError &&
            taskChangeFileIdentity(snippet.filePath) === transitionPath
        )
      );
    });
    if (!belongsToDecision) throw new Error('Review replay evidence path does not match decision');
  }
}
