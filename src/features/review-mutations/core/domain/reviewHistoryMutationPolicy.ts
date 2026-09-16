import { isDurableReviewEqual } from './durableReviewValue';
import {
  buildReviewExternalReloadState,
  buildReviewRestoreDecisionState,
  buildReviewUndoDecisionState,
} from './reviewHistoryDecisions';
import {
  buildForwardDiskMutationSteps,
  buildRedoDiskMutationSteps,
  buildUndoDiskMutationSteps,
  getReviewActionDiskSnapshots,
} from './reviewHistoryDiskSteps';

import type {
  ExecuteReviewMutationRequest,
  FileChangeSummary,
  ReviewDiskUndoSnapshot,
  ReviewPersistedStateSnapshot,
  ReviewUndoAction,
} from '@shared/types/review';

export interface ReviewHistoryDecisionState extends ReviewPersistedStateSnapshot {
  revision: number;
}

export interface ReviewHistoryMutationPolicyContext {
  resolveFile(filePath: string): FileChangeSummary;
  normalizePath(filePath: string): string;
  hashContent(content: string): string;
}

function assertExactReviewDiskSteps(
  request: ExecuteReviewMutationRequest,
  action: ReviewUndoAction,
  direction: 'forward' | 'undo' | 'redo'
): void {
  const snapshots = getReviewActionDiskSnapshots(action);
  const expectedSteps =
    direction === 'forward'
      ? buildForwardDiskMutationSteps(action.id, snapshots)
      : direction === 'undo'
        ? buildUndoDiskMutationSteps(action.id, snapshots)
        : buildRedoDiskMutationSteps(action.id, snapshots);
  if (!isDurableReviewEqual(request.diskSteps, expectedSteps)) {
    const label = direction === 'forward' ? request.kind : direction;
    throw new Error(
      `Review ${label[0]?.toUpperCase()}${label.slice(1)} disk mutation does not match durable history`
    );
  }
}

export function isAuthoritativelyBoundReviewSnapshot(
  snapshot: ReviewDiskUndoSnapshot,
  hashContent: (content: string) => string
): boolean {
  if (snapshot.authoritativeBeforeSha256 === undefined) return false;
  if (snapshot.authoritativeBeforeSha256 === null) {
    const mode =
      snapshot.restoreMode ?? (snapshot.renameExpectation ? 'restore-rejected-rename' : 'content');
    return (
      mode === 'delete-file' ||
      mode === 'restore-rejected-rename' ||
      mode === 'reapply-rejected-rename'
    );
  }
  return snapshot.authoritativeBeforeSha256 === hashContent(snapshot.beforeContent);
}

export function assertAuthoritativelyBoundReviewAction(
  action: ReviewUndoAction,
  hashContent: (content: string) => string
): void {
  if (
    getReviewActionDiskSnapshots(action).some(
      (snapshot) => !isAuthoritativelyBoundReviewSnapshot(snapshot, hashContent)
    )
  ) {
    throw new Error('Review history predates authoritative disk snapshots; reload Changes');
  }
}

export function rebindReviewActionDescriptorPath(
  action: ReviewUndoAction,
  filePath: string
): ReviewUndoAction['descriptor'] {
  return action.descriptor && 'filePath' in action.descriptor
    ? { ...action.descriptor, filePath }
    : action.descriptor;
}

export function assertExactReviewHistoryTransition(
  request: ExecuteReviewMutationRequest,
  current: ReviewHistoryDecisionState | null,
  context: ReviewHistoryMutationPolicyContext
): void {
  const next = request.persistedState;
  if (!Array.isArray(next.reviewActionHistory) || !Array.isArray(next.reviewRedoHistory)) {
    throw new Error('Review history transition is incomplete');
  }

  if (request.kind === 'reload-external') {
    if (typeof request.externalFilePath !== 'string' || request.diskSteps.length !== 0) {
      throw new Error('External review reload requires one reviewed file and no disk mutation');
    }
    const file = context.resolveFile(request.externalFilePath);
    const expected = buildReviewExternalReloadState(file, {
      hunkDecisions: current?.hunkDecisions ?? {},
      fileDecisions: current?.fileDecisions ?? {},
      hunkContextHashesByFile: current?.hunkContextHashesByFile ?? {},
      reviewActionHistory: current?.reviewActionHistory ?? [],
      reviewRedoHistory: current?.reviewRedoHistory ?? [],
    });
    if (!isDurableReviewEqual(next, expected)) {
      throw new Error('Invalid durable external file reload transition');
    }
    return;
  }

  if (request.kind === 'restore' || request.kind === 'rename') {
    const previousActions = current?.reviewActionHistory ?? [];
    const action = next.reviewActionHistory.at(-1);
    const snapshot = action?.kind === 'disk' ? action.action.snapshot : null;
    const restoreMode =
      snapshot?.restoreMode ??
      (snapshot?.renameExpectation ? 'restore-rejected-rename' : 'content');
    const isRenameSnapshot =
      restoreMode === 'restore-rejected-rename' || restoreMode === 'reapply-rejected-rename';
    const authoritativeFile = snapshot ? context.resolveFile(snapshot.filePath) : null;
    const expectedDecisions = authoritativeFile
      ? buildReviewRestoreDecisionState(authoritativeFile, {
          hunkDecisions: current?.hunkDecisions ?? {},
          fileDecisions: current?.fileDecisions ?? {},
        })
      : null;
    const transitionMatches =
      action?.kind === 'disk' &&
      authoritativeFile !== null &&
      action.action.file?.filePath === authoritativeFile.filePath &&
      action.action.file.changeKey === authoritativeFile.changeKey &&
      snapshot?.file?.filePath === authoritativeFile.filePath &&
      snapshot.file.changeKey === authoritativeFile.changeKey &&
      (action.descriptor === undefined ||
        (action.descriptor.intent ===
          (request.kind === 'rename' ? 'restore-rename' : 'restore-file') &&
          context.normalizePath(action.descriptor.filePath) ===
            context.normalizePath(snapshot.filePath))) &&
      isDurableReviewEqual(next.reviewActionHistory.slice(0, -1), previousActions) &&
      next.reviewRedoHistory.length === 0 &&
      isDurableReviewEqual(action.action.decisionSnapshot, {
        hunkDecisions: current?.hunkDecisions ?? {},
        fileDecisions: current?.fileDecisions ?? {},
      }) &&
      isDurableReviewEqual(
        next.hunkContextHashesByFile ?? {},
        current?.hunkContextHashesByFile ?? {}
      ) &&
      isDurableReviewEqual(next.hunkDecisions, expectedDecisions?.hunkDecisions) &&
      isDurableReviewEqual(next.fileDecisions, expectedDecisions?.fileDecisions) &&
      (request.kind === 'rename') === isRenameSnapshot;
    if (!transitionMatches || !action) {
      throw new Error(
        `Invalid durable ${request.kind === 'rename' ? 'Rename' : 'Restore'} history transition`
      );
    }
    assertExactReviewDiskSteps(request, action, 'forward');
    return;
  }

  if (!current) {
    throw new Error(
      `Review history changed; refusing stale ${request.kind === 'undo' ? 'Undo' : 'Redo'}`
    );
  }

  if (request.kind === 'undo') {
    const action = current.reviewActionHistory.at(-1);
    if (!request.expectedTopActionId) {
      throw new Error('Review Undo requires the expected durable action id');
    }
    if (!action || action.id !== request.expectedTopActionId) {
      throw new Error('Review history changed; refusing stale Undo');
    }
    assertAuthoritativelyBoundReviewAction(action, (content) => context.hashContent(content));
    const redoEntry = next.reviewRedoHistory.at(-1);
    const expectedDecisions = buildReviewUndoDecisionState(
      action,
      { hunkDecisions: current.hunkDecisions, fileDecisions: current.fileDecisions },
      (filePath) => context.resolveFile(filePath)
    );
    const transitionMatches =
      expectedDecisions !== null &&
      isDurableReviewEqual(next.reviewActionHistory, current.reviewActionHistory.slice(0, -1)) &&
      isDurableReviewEqual(next.reviewRedoHistory.slice(0, -1), current.reviewRedoHistory) &&
      isDurableReviewEqual(redoEntry?.action, action) &&
      isDurableReviewEqual(redoEntry?.decisionSnapshot, {
        hunkDecisions: current.hunkDecisions,
        fileDecisions: current.fileDecisions,
      }) &&
      isDurableReviewEqual(
        redoEntry?.hunkContextHashesByFile ?? {},
        current.hunkContextHashesByFile ?? {}
      ) &&
      isDurableReviewEqual(next.hunkDecisions, expectedDecisions.hunkDecisions) &&
      isDurableReviewEqual(next.fileDecisions, expectedDecisions.fileDecisions) &&
      isDurableReviewEqual(
        next.hunkContextHashesByFile ?? {},
        current.hunkContextHashesByFile ?? {}
      );
    if (!transitionMatches) {
      throw new Error('Invalid durable Undo history transition');
    }
    assertExactReviewDiskSteps(request, action, 'undo');
    return;
  }

  const redoEntry = current.reviewRedoHistory.at(-1);
  if (!request.expectedTopRedoActionId) {
    throw new Error('Review Redo requires the expected durable action id');
  }
  if (redoEntry?.action.id !== request.expectedTopRedoActionId) {
    throw new Error('Review history changed; refusing stale Redo');
  }
  assertAuthoritativelyBoundReviewAction(redoEntry.action, (content) =>
    context.hashContent(content)
  );
  const transitionMatches =
    isDurableReviewEqual(next.reviewRedoHistory, current.reviewRedoHistory.slice(0, -1)) &&
    isDurableReviewEqual(next.reviewActionHistory, [
      ...current.reviewActionHistory,
      redoEntry.action,
    ]) &&
    isDurableReviewEqual(next.hunkDecisions, redoEntry.decisionSnapshot.hunkDecisions) &&
    isDurableReviewEqual(next.fileDecisions, redoEntry.decisionSnapshot.fileDecisions) &&
    isDurableReviewEqual(
      next.hunkContextHashesByFile ?? {},
      redoEntry.hunkContextHashesByFile ?? current.hunkContextHashesByFile ?? {}
    );
  if (!transitionMatches) {
    throw new Error('Invalid durable Redo history transition');
  }
  assertExactReviewDiskSteps(request, redoEntry.action, 'redo');
}

export function findLatestRestorableDiskSnapshot(
  current: ReviewHistoryDecisionState | null,
  filePath: string,
  context: Pick<ReviewHistoryMutationPolicyContext, 'normalizePath' | 'hashContent'>
): ReviewDiskUndoSnapshot | null {
  if (!current) return null;
  const normalizedPath = context.normalizePath(filePath);
  for (let index = current.reviewActionHistory.length - 1; index >= 0; index--) {
    const action = current.reviewActionHistory[index];
    if (!action) continue;
    const matchingSnapshot = [...getReviewActionDiskSnapshots(action)]
      .reverse()
      .find((candidate) => context.normalizePath(candidate.filePath) === normalizedPath);
    if (!matchingSnapshot) continue;
    if (matchingSnapshot.restoreConflict) throw new Error(matchingSnapshot.restoreConflict);
    if (!isAuthoritativelyBoundReviewSnapshot(matchingSnapshot, context.hashContent)) {
      throw new Error('Review history predates authoritative disk snapshots; reload Changes');
    }
    if (matchingSnapshot.renameExpectation) return null;
    if (action.kind === 'disk' && action.action.originalIndex !== undefined) continue;
    return matchingSnapshot;
  }
  return null;
}

export function isAuthoritativeReviewDeletion(file: FileChangeSummary): boolean {
  if (file.ledgerSummary?.latestOperation) {
    return file.ledgerSummary.latestOperation === 'delete';
  }
  if (file.ledgerSummary?.afterState?.exists !== undefined) {
    return !file.ledgerSummary.afterState.exists;
  }
  const latestLedger = file.snippets
    .filter((snippet) => snippet.ledger && !snippet.isError)
    .at(-1)?.ledger;
  return (
    latestLedger?.operation === 'delete' ||
    latestLedger?.afterState?.exists === false ||
    file.ledgerSummary?.deletedInTask === true
  );
}
