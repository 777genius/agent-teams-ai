import { isDurableReviewEqual } from './durableReviewValue';
import { getReviewActionDiskSnapshots } from './reviewHistoryDiskSteps';

import type {
  FileChangeSummary,
  FileReviewDecision,
  HunkDecision,
  ReviewPersistedStateSnapshot,
} from '@shared/types/review';

export interface ReviewDecisionCommandCurrentState extends ReviewPersistedStateSnapshot {
  revision: number;
}

export interface ReviewDecisionCommandPolicyContext {
  resolveFile(filePath: string): FileChangeSummary;
  normalizePath(filePath: string): string;
}

export function assertCurrentReviewDecisionRevision(
  current: ReviewDecisionCommandCurrentState | null,
  expectedRevision: number
): void {
  if ((current?.revision ?? 0) !== expectedRevision) {
    throw new Error('Review decisions changed; refusing stale state overwrite');
  }
}

export function assertExactApplyReviewHistoryTransition(
  state: ReviewPersistedStateSnapshot,
  current: ReviewDecisionCommandCurrentState | null,
  decisions: readonly (FileReviewDecision & { reviewKey: string })[],
  context: ReviewDecisionCommandPolicyContext
): void {
  const previousActions = current?.reviewActionHistory ?? [];
  const nextActions = state.reviewActionHistory ?? [];
  const action = nextActions.at(-1);
  const currentRedo = current?.reviewRedoHistory ?? [];
  const knownIds = new Set([
    ...previousActions.map((entry) => entry.id),
    ...currentRedo.map((entry) => entry.action.id),
  ]);
  if (
    !action ||
    action.kind === 'hunk' ||
    knownIds.has(action.id) ||
    nextActions.length !== previousActions.length + 1 ||
    !isDurableReviewEqual(nextActions.slice(0, -1), previousActions) ||
    (state.reviewRedoHistory?.length ?? 0) !== 0
  ) {
    throw new Error('Durable Reject requires exactly one new disk history action');
  }

  const filesByPath = new Map(
    decisions.map((decision) => {
      const file = context.resolveFile(decision.filePath);
      const canonicalKey = file.changeKey ?? file.filePath;
      if (decision.reviewKey !== canonicalKey) {
        throw new Error('Durable reviewKey does not match the authoritative review identity');
      }
      return [context.normalizePath(file.filePath), file] as const;
    })
  );
  const actionPaths = getReviewActionDiskSnapshots(action).map((snapshot) =>
    context.normalizePath(snapshot.filePath)
  );
  if (
    actionPaths.length !== filesByPath.size ||
    new Set(actionPaths).size !== actionPaths.length ||
    actionPaths.some((filePath) => !filesByPath.has(filePath))
  ) {
    throw new Error('Durable Reject history does not match the requested files');
  }
  if ((decisions.length === 1) !== (action.kind === 'disk')) {
    throw new Error('Durable Reject history action kind does not match the decision batch');
  }
  if (action.descriptor) {
    const descriptor = action.descriptor;
    let descriptorMatches = false;
    if (action.kind === 'bulk') {
      descriptorMatches =
        descriptor.intent === 'reject-all' && descriptor.fileCount === filesByPath.size;
    } else if (action.action.originalIndex !== undefined) {
      descriptorMatches =
        descriptor.intent === 'reject-hunk' &&
        descriptor.hunkIndex === action.action.originalIndex &&
        context.normalizePath(descriptor.filePath) ===
          context.normalizePath(action.action.snapshot.filePath);
    } else {
      descriptorMatches =
        descriptor.intent === 'reject-file' &&
        context.normalizePath(descriptor.filePath) ===
          context.normalizePath(action.action.snapshot.filePath);
    }
    if (!descriptorMatches) {
      throw new Error('Durable Reject history descriptor does not match the decision transition');
    }
  }

  const currentDecisions = {
    hunkDecisions: current?.hunkDecisions ?? {},
    fileDecisions: current?.fileDecisions ?? {},
  };
  const allowedFileKeys = new Set(decisions.map((decision) => decision.reviewKey));
  const allowedHunkKeys = new Set<string>();
  for (const decision of decisions) {
    for (const index of Object.keys(decision.hunkDecisions)) {
      allowedHunkKeys.add(`${decision.reviewKey}:${index}`);
    }
  }
  const changedKeys = (
    previous: Record<string, HunkDecision>,
    next: Record<string, HunkDecision>,
    allowed: ReadonlySet<string>
  ): string[] => {
    const changed = [...new Set([...Object.keys(previous), ...Object.keys(next)])].filter(
      (key) => previous[key] !== next[key]
    );
    if (changed.some((key) => !allowed.has(key))) {
      throw new Error('Durable Reject state changes decisions outside the requested files');
    }
    return changed;
  };
  const changedHunks = changedKeys(
    currentDecisions.hunkDecisions,
    state.hunkDecisions,
    allowedHunkKeys
  );
  const changedFiles = changedKeys(
    currentDecisions.fileDecisions,
    state.fileDecisions,
    allowedFileKeys
  );
  if (changedHunks.length + changedFiles.length === 0) {
    throw new Error('Durable Reject history has no matching decision transition');
  }

  if (action.kind === 'bulk') {
    if (
      !isDurableReviewEqual(action.decisionSnapshot, currentDecisions) ||
      decisions.some((decision) => decision.fileDecision !== 'rejected')
    ) {
      throw new Error('Durable bulk Reject history has invalid decision metadata');
    }
    return;
  }

  const decision = decisions[0];
  if (!decision) throw new Error('Durable Reject decision is unavailable');
  const originalIndex = action.action.originalIndex;
  if (originalIndex !== undefined) {
    const decisionKey = `${decision.reviewKey}:${originalIndex}`;
    if (
      changedHunks.length !== 1 ||
      changedHunks[0] !== decisionKey ||
      changedFiles.length !== 0 ||
      decision.fileDecision !== 'pending' ||
      decision.hunkDecisions[originalIndex] !== 'rejected' ||
      state.hunkDecisions[decisionKey] !== 'rejected'
    ) {
      throw new Error('Durable hunk Reject history index does not match the decision transition');
    }
    return;
  }

  if (
    decision.fileDecision !== 'rejected' ||
    !isDurableReviewEqual(action.action.decisionSnapshot, currentDecisions)
  ) {
    throw new Error('Durable file Reject history has invalid decision metadata');
  }
}
