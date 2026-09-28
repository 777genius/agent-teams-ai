import { taskChangeFileIdentity } from './taskChangeFileIdentity';

import type {
  ApplyReviewDiskTransition,
  ApplyReviewRequest,
  FileChangeWithContent,
  FileReviewDecision,
} from '@shared/types';

/** Pending non-ledger recovery cannot prove task-time filesystem identity. */
export function assertReviewRecoveryContent(
  decision: FileReviewDecision,
  saved: FileChangeWithContent,
  alreadyApplied: boolean
): void {
  // Applied decisions are verified against their durable path postimages before commit.
  if (alreadyApplied) return;
  if (decision.fileDecision === 'accepted') return;
  if (saved.contentSource === 'ledger-exact' || saved.contentSource === 'ledger-snapshot') return;
  throw new Error('Review recovery requires exact task-bound ledger evidence');
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
    // Native snippets cannot prove historical filesystem identity on replay.
    if (!content) throw new Error('Review replay evidence is unavailable');
    const ledger =
      (content.contentSource === 'ledger-exact' || content.contentSource === 'ledger-snapshot') &&
      content.snippets.some((snippet) => snippet.ledger && !snippet.isError);
    if (!ledger) {
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
